import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  OPTION_MULTIPLIER,
  OPTION_PAPER_FEE_PER_CONTRACT,
  OPTION_PAPER_INITIAL_CASH,
  type OptionBarRecommendation,
  type OptionChain,
  type OptionIntradayBoxRow,
  type OptionIntradaySession,
  type OptionPaperPriceSource,
  type OptionQuoteRow,
  type PaperAccount,
  type PaperFill,
  type PaperPosition,
} from '@dshtrading/api'
import {
  paperAccountPath,
  paperFillsPath,
  paperPositionsPath,
  readJsonl,
  shanghaiCalendarDate,
} from './option-bar-ledger.js'

export { OPTION_MULTIPLIER, OPTION_PAPER_FEE_PER_CONTRACT, OPTION_PAPER_INITIAL_CASH }

export interface PaperState {
  account: PaperAccount
  positions: PaperPosition[]
  fills: PaperFill[]
}

type PaperLegs = PaperFill['legs']
type SkipReason = NonNullable<PaperFill['skip']>
const paperStateLocks = new Map<string, Promise<void>>()

async function withPaperStateLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = paperStateLocks.get(root) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current)
  paperStateLocks.set(root, queued)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (paperStateLocks.get(root) === queued) paperStateLocks.delete(root)
  }
}

export function emptyPaperAccount(nowIso: string): PaperAccount {
  return {
    currency: 'CNY',
    initialCash: OPTION_PAPER_INITIAL_CASH,
    cash: OPTION_PAPER_INITIAL_CASH,
    realizedPnl: 0,
    updatedAt: nowIso,
  }
}

/** 带来源标记的成交价（last 回退 prevSettle）。 */
export interface PaperMarkQuote {
  readonly price: number
  readonly source: OptionPaperPriceSource
}

export function quoteFillPriceWithSource(
  row: OptionQuoteRow & { bid?: number; ask?: number },
): PaperMarkQuote | undefined {
  if (typeof row.last === 'number' && Number.isFinite(row.last) && row.last >= 0) {
    return { price: row.last, source: 'last' }
  }
  if (typeof row.prevSettle === 'number' && Number.isFinite(row.prevSettle) && row.prevSettle >= 0) {
    return { price: row.prevSettle, source: 'prev_settle' }
  }
  return undefined
}

export function quoteFillPrice(
  row: OptionQuoteRow & { bid?: number; ask?: number },
  _side: 'buy' | 'sell',
): number | undefined {
  return quoteFillPriceWithSource(row)?.price
}

/** 手续费：每张 × 每腿张数合计（skip 桩 legs=[] 自然为 0）。 */
export function fillFeeCny(legs: PaperLegs, feePerContract: number): number {
  return feePerContract * legs.reduce((total, leg) => total + leg.qty, 0)
}

function nearestIndex(rows: readonly OptionQuoteRow[], spot: number | undefined): number {
  if (spot === undefined) return Math.floor((rows.length - 1) / 2)
  let best = 0
  for (let index = 1; index < rows.length; index += 1) {
    if (Math.abs(rows[index]!.strike - spot) < Math.abs(rows[best]!.strike - spot)) {
      best = index
    }
  }
  return best
}

export function completeVerticalLegs(
  chain: OptionChain,
  bias: 'up' | 'down' | 'neutral',
  qty: number,
): { legs: PaperLegs; skip?: 'no_quote' } {
  if (bias === 'neutral') return { legs: [], skip: 'no_quote' }

  const rows = [...(bias === 'down' ? chain.calls : chain.puts)]
    .sort((left, right) => left.strike - right.strike)
  if (rows.length < 2) return { legs: [], skip: 'no_quote' }

  const nearest = nearestIndex(rows, chain.spot)
  const shortIndex = bias === 'down'
    ? (chain.spot === undefined
        ? nearest
        : rows.findIndex((row) => row.strike >= chain.spot!))
    : (chain.spot === undefined
        ? nearest
        : rows.findLastIndex((row) => row.strike <= chain.spot!))
  const longIndex = bias === 'down' ? shortIndex + 1 : shortIndex - 1
  const short = rows[shortIndex]
  const long = rows[longIndex]
  if (!short?.code || !long?.code) return { legs: [], skip: 'no_quote' }

  const shortQuote = quoteFillPriceWithSource(short)
  const longQuote = quoteFillPriceWithSource(long)
  if (shortQuote === undefined || longQuote === undefined) {
    return { legs: [], skip: 'no_quote' }
  }

  return {
    legs: [
      { code: short.code, side: 'sell', qty, fillPrice: shortQuote.price, priceSource: shortQuote.source },
      { code: long.code, side: 'buy', qty, fillPrice: longQuote.price, priceSource: longQuote.source },
    ],
  }
}

export function premiumCny(legs: PaperLegs): number {
  return legs.reduce((total, leg) => (
    total + (leg.side === 'sell' ? 1 : -1) * leg.fillPrice * leg.qty * OPTION_MULTIPLIER
  ), 0)
}

export function sizeQty(
  maxContracts: number | undefined,
  cash: number,
  premiumPer: number,
  marginPer: number,
): number {
  let qty = Math.max(1, Math.floor(maxContracts ?? 1))
  // Brief tests govern over cash+premium-margin prose; capitalPer = abs(premium)+margin.
  const capitalPer = Math.abs(premiumPer) + Math.max(0, marginPer)
  while (qty > 0 && cash - capitalPer * qty < 0) qty -= 1
  return qty
}

export function hasSuccessfulOpen(
  fills: readonly PaperFill[],
  bucketStart: string,
): boolean {
  return fills.some((fill) => (
    fill.bucketStart === bucketStart
    && fill.offset === 'open'
    && fill.reason !== 'skipped'
    && fill.qty > 0
  ))
}

export function applyOpen(
  state: PaperState,
  fill: Omit<PaperFill, 'cashAfter' | 'id'> & {
    id?: string
    invalidIf?: string
    boxLow?: number
    boxHigh?: number
  },
): PaperState {
  const fee = fill.feeCny ?? 0
  const cash = state.account.cash + fill.premiumCny - fill.marginCny - fee
  const id = fill.id ?? `${fill.underlying ?? 'unknown'}:${fill.bucketStart}`
  const { invalidIf = '', boxLow, boxHigh, ...fillRow } = fill
  const recorded: PaperFill = { ...fillRow, id, cashAfter: cash }
  const position: PaperPosition | undefined = (
    fill.reason !== 'skipped'
    && fill.qty > 0
    && fill.underlying !== undefined
    && fill.template !== undefined
  ) ? {
      id: `${fill.underlying}:${fill.bucketStart}`,
      underlying: fill.underlying,
      template: fill.template,
      openedBucketStart: fill.bucketStart,
      invalidIf,
      qty: fill.qty,
      marginCny: fill.marginCny,
      ...(boxLow === undefined ? {} : { boxLow }),
      ...(boxHigh === undefined ? {} : { boxHigh }),
      legs: fill.legs,
      ...(fee === 0 ? {} : { openFeeCny: fee }),
    } : undefined

  return {
    account: { ...state.account, cash, updatedAt: fill.asOf },
    positions: position === undefined ? [...state.positions] : [...state.positions, position],
    fills: [...state.fills, recorded],
  }
}

export function applyClose(
  state: PaperState,
  positionId: string,
  legs: PaperLegs,
  reason: 'invalidIf' | 'close5' | 'session',
  asOf: string,
  feePerContract = OPTION_PAPER_FEE_PER_CONTRACT,
): PaperState {
  const position = state.positions.find((item) => item.id === positionId)
  if (position === undefined) return state

  const closePremium = premiumCny(legs)
  const openPremium = premiumCny(position.legs)
  const closeFee = fillFeeCny(legs, feePerContract)
  const openFee = position.openFeeCny ?? 0
  const cash = state.account.cash + closePremium + position.marginCny - closeFee
  const fill: PaperFill = {
    id: `${positionId}:close:${asOf}`,
    bucketStart: position.openedBucketStart,
    asOf,
    underlying: position.underlying,
    template: position.template,
    offset: 'close',
    qty: position.qty,
    legs,
    premiumCny: closePremium,
    marginCny: 0,
    cashAfter: cash,
    reason,
    ...(closeFee === 0 ? {} : { feeCny: closeFee }),
  }

  return {
    account: {
      ...state.account,
      cash,
      realizedPnl: state.account.realizedPnl + openPremium + closePremium - openFee - closeFee,
      updatedAt: asOf,
    },
    positions: state.positions.filter((item) => item.id !== positionId),
    fills: [...state.fills, fill],
  }
}

export function invalidIfTriggered(input: {
  invalidIf: string
  lastClose: number
  boxLow?: number
  boxHigh?: number
  volumeRatio?: number
}): boolean {
  if (input.boxLow === undefined || input.boxHigh === undefined) return false
  if (!/(donchian|box)/i.test(input.invalidIf)) return false

  const needsVolumeSurge = /volumeRatio\s*>=\s*1\.5|BOX_VOLUME_SURGE/i.test(input.invalidIf)
  if (needsVolumeSurge && (input.volumeRatio === undefined || input.volumeRatio < 1.5)) {
    return false
  }
  return input.lastClose < input.boxLow || input.lastClose > input.boxHigh
}

function skipFill(
  rec: OptionBarRecommendation,
  nowIso: string,
  cash: number,
  skip: SkipReason,
  underlying?: string,
  template?: string,
): PaperFill {
  return {
    id: `${rec.bucketStart}:skip:${skip}`,
    bucketStart: rec.bucketStart,
    asOf: nowIso,
    ...(underlying === undefined ? {} : { underlying }),
    ...(template === undefined ? {} : { template }),
    offset: 'open',
    qty: 0,
    legs: [],
    premiumCny: 0,
    marginCny: 0,
    cashAfter: cash,
    reason: 'skipped',
    skip,
  }
}

function explicitLegs(legs: readonly unknown[] | undefined): PaperLegs | undefined {
  if (legs === undefined || legs.length === 0) return undefined
  const parsed = legs.map((item) => {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as {
      code?: unknown
      side?: unknown
      last?: unknown
      fillPrice?: unknown
      premium?: unknown
      qty?: unknown
    }
    const price = [row.last, row.fillPrice, row.premium]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const qty = row.qty ?? 1
    if (
      typeof row.code !== 'string'
      || (row.side !== 'buy' && row.side !== 'sell')
      || price === undefined
      || typeof qty !== 'number'
      || !Number.isInteger(qty)
      || qty <= 0
    ) return undefined
    return { code: row.code, side: row.side, qty, fillPrice: price, priceSource: 'pick' }
  })
  return parsed.every((leg) => leg !== undefined) ? parsed as PaperLegs : undefined
}

export function decidePaperOpen(input: {
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  fillsToday: readonly PaperFill[]
  chainFor: (underlying: string) => OptionChain | undefined
  marginFor: (legs: PaperLegs) => number | undefined
  nowIso: string
  cash: number
  feePerContract?: number
}): { fill: Omit<PaperFill, 'cashAfter'> } | { skip: PaperFill } | { noop: true } {
  const { rec } = input
  if (
    rec.skipReason !== undefined
    || rec.noTrade
    || rec.session === 'close5'
    || rec.session === 'closed'
  ) return { noop: true }
  if (input.fillsToday.some((fill) => (
    fill.bucketStart === rec.bucketStart && fill.offset === 'open'
  ))) {
    return { skip: skipFill(rec, input.nowIso, input.cash, 'duplicate_bucket') }
  }

  let lastFailure: {
    reason: SkipReason
    underlying?: string
    template?: string
  } = { reason: 'bad_template' }

  for (const pick of rec.picks) {
    if (!pick.underlying || !pick.template) {
      lastFailure = { reason: 'bad_template' }
      continue
    }
    const forecast = input.forecastByUnderlying[pick.underlying]
    if (forecast === undefined) {
      lastFailure = {
        reason: 'no_forecast',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }
    const candidate = forecast.candidates.find((item) => item.template === pick.template)
    if (candidate === undefined) {
      lastFailure = {
        reason: 'bad_template',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }

    let unitLegs = explicitLegs(pick.legs)
    if (unitLegs === undefined) {
      if (pick.template !== 'vertical') {
        lastFailure = {
          reason: 'no_quote',
          underlying: pick.underlying,
          template: pick.template,
        }
        continue
      }
      const chain = input.chainFor(pick.underlying)
      if (chain === undefined) {
        lastFailure = {
          reason: 'no_quote',
          underlying: pick.underlying,
          template: pick.template,
        }
        continue
      }
      const completed = completeVerticalLegs(chain, candidate.bias, 1)
      if (completed.skip !== undefined) {
        lastFailure = {
          reason: completed.skip,
          underlying: pick.underlying,
          template: pick.template,
        }
        continue
      }
      unitLegs = completed.legs
    }

    const premiumPer = premiumCny(unitLegs)
    const marginPer = input.marginFor(unitLegs)
    if (marginPer === undefined || !Number.isFinite(marginPer) || marginPer < 0) {
      lastFailure = {
        reason: 'no_quote',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }
    const qty = sizeQty(pick.maxContracts, input.cash, premiumPer, marginPer)
    if (qty === 0) {
      lastFailure = {
        reason: 'no_cash',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }

    const legs = unitLegs.map((leg) => ({ ...leg, qty: leg.qty * qty }))
    const feeCny = fillFeeCny(legs, input.feePerContract ?? OPTION_PAPER_FEE_PER_CONTRACT)
    return {
      fill: {
        id: `${pick.underlying}:${rec.bucketStart}:open`,
        bucketStart: rec.bucketStart,
        asOf: input.nowIso,
        underlying: pick.underlying,
        template: pick.template,
        offset: 'open',
        qty,
        legs,
        premiumCny: premiumPer * qty,
        marginCny: marginPer * qty,
        reason: 'signal',
        ...(feeCny === 0 ? {} : { feeCny }),
      },
    }
  }

  return {
    skip: skipFill(
      rec,
      input.nowIso,
      input.cash,
      lastFailure.reason,
      lastFailure.underlying,
      lastFailure.template,
    ),
  }
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function loadPaperState(
  root: string,
  date: string,
  nowIso: string,
): Promise<PaperState> {
  const [account, positions, fills] = await Promise.all([
    readJsonFile(paperAccountPath(root), emptyPaperAccount(nowIso)),
    readJsonFile<PaperPosition[]>(paperPositionsPath(root), []),
    readJsonl<PaperFill>(paperFillsPath(root, date)),
  ])
  return { account, positions, fills }
}

function fillCalendarDate(fill: PaperFill): string | undefined {
  const time = Date.parse(fill.asOf)
  return Number.isFinite(time) ? shanghaiCalendarDate(time) : undefined
}

export async function savePaperState(
  root: string,
  date: string,
  state: PaperState,
): Promise<void> {
  const accountFile = paperAccountPath(root)
  const positionsFile = paperPositionsPath(root)
  const fillsFile = paperFillsPath(root, date)
  await Promise.all([
    mkdir(path.dirname(accountFile), { recursive: true }),
    mkdir(path.dirname(fillsFile), { recursive: true }),
  ])
  const fills = state.fills.filter((fill) => fillCalendarDate(fill) === date)
  await Promise.all([
    writeFile(accountFile, `${JSON.stringify(state.account)}\n`, 'utf8'),
    writeFile(positionsFile, `${JSON.stringify(state.positions)}\n`, 'utf8'),
    writeFile(
      fillsFile,
      fills.length === 0 ? '' : `${fills.map((fill) => JSON.stringify(fill)).join('\n')}\n`,
      'utf8',
    ),
  ])
}

export async function resetPaperState(root: string, nowIso: string): Promise<PaperState> {
  return await withPaperStateLock(root, async () => {
    const state: PaperState = {
      account: emptyPaperAccount(nowIso),
      positions: [],
      fills: [],
    }
    const accountFile = paperAccountPath(root)
    await mkdir(path.dirname(accountFile), { recursive: true })
    await Promise.all([
      writeFile(accountFile, `${JSON.stringify(state.account)}\n`, 'utf8'),
      writeFile(paperPositionsPath(root), '[]\n', 'utf8'),
    ])
    return state
  })
}

export async function tryPaperOpen(input: {
  root: string
  date: string
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  nowIso: string
  getChain: (underlying: string) => Promise<OptionChain | undefined>
  getMargin: (legs: PaperFill['legs']) => Promise<number | undefined>
  feePerContract?: number
}): Promise<void> {
  await withPaperStateLock(input.root, async () => {
  try {
    const feePerContract = input.feePerContract ?? OPTION_PAPER_FEE_PER_CONTRACT
    const state = await loadPaperState(input.root, input.date, input.nowIso)
    const gate = decidePaperOpen({
      rec: { ...input.rec, picks: [] },
      forecastByUnderlying: input.forecastByUnderlying,
      fillsToday: state.fills,
      chainFor: () => undefined,
      marginFor: () => 0,
      nowIso: input.nowIso,
      cash: state.account.cash,
      feePerContract,
    })
    if ('noop' in gate) return
    if ('skip' in gate && gate.skip.skip === 'duplicate_bucket') {
      await savePaperState(input.root, input.date, {
        ...state,
        fills: [...state.fills, gate.skip],
      })
      return
    }

    let lastSkip = 'skip' in gate ? gate.skip : undefined
    for (const pick of input.rec.picks) {
      const rec = { ...input.rec, picks: [pick] }
      if (!pick.underlying || !pick.template) {
        const decision = decidePaperOpen({
          rec,
          forecastByUnderlying: input.forecastByUnderlying,
          fillsToday: state.fills,
          chainFor: () => undefined,
          marginFor: () => 0,
          nowIso: input.nowIso,
          cash: state.account.cash,
          feePerContract,
        })
        if ('skip' in decision) lastSkip = decision.skip
        continue
      }

      const forecast = input.forecastByUnderlying[pick.underlying]
      const candidate = forecast?.candidates.find((item) => item.template === pick.template)
      if (forecast === undefined || candidate === undefined) {
        const decision = decidePaperOpen({
          rec,
          forecastByUnderlying: input.forecastByUnderlying,
          fillsToday: state.fills,
          chainFor: () => undefined,
          marginFor: () => 0,
          nowIso: input.nowIso,
          cash: state.account.cash,
          feePerContract,
        })
        if ('skip' in decision) lastSkip = decision.skip
        continue
      }

      try {
        const explicit = explicitLegs(pick.legs)
        const chain = explicit === undefined && pick.template === 'vertical'
          ? await input.getChain(pick.underlying)
          : undefined
        const unitLegs = explicit ?? (
          chain === undefined || pick.template !== 'vertical'
            ? undefined
            : completeVerticalLegs(chain, candidate.bias, 1).legs
        )
        let margin: number | undefined
        if (unitLegs !== undefined) {
          try {
            margin = await input.getMargin(unitLegs)
          } catch {
            margin = undefined
          }
        }
        const decision = decidePaperOpen({
          rec,
          forecastByUnderlying: input.forecastByUnderlying,
          fillsToday: state.fills,
          chainFor: () => chain,
          marginFor: () => margin,
          nowIso: input.nowIso,
          cash: state.account.cash,
          feePerContract,
        })
        if ('skip' in decision) {
          lastSkip = decision.skip
          continue
        }
        if ('fill' in decision) {
          const next = applyOpen(state, {
            ...decision.fill,
            invalidIf: input.rec.invalidIf,
            ...(forecast.boxLow === undefined ? {} : { boxLow: forecast.boxLow }),
            ...(forecast.boxHigh === undefined ? {} : { boxHigh: forecast.boxHigh }),
          })
          await savePaperState(input.root, input.date, next)
          return
        }
      } catch {
        lastSkip = skipFill(
          rec,
          input.nowIso,
          state.account.cash,
          'no_quote',
          pick.underlying,
          pick.template,
        )
      }
    }

    if (lastSkip !== undefined) {
      await savePaperState(input.root, input.date, {
        ...state,
        fills: [...state.fills, lastSkip],
      })
    }
  } catch {
    // Paper-account failures must never break recommendation persistence.
  }
  })
}

async function closeLegs(
  position: PaperPosition,
  getMark: (code: string, side: 'buy' | 'sell') => Promise<PaperMarkQuote | undefined>,
): Promise<PaperLegs | undefined> {
  const legs: PaperLegs[number][] = []
  for (const leg of position.legs) {
    const side = leg.side === 'sell' ? 'buy' : 'sell'
    const mark = await getMark(leg.code, side)
    if (mark === undefined) return undefined
    legs.push({ code: leg.code, side, qty: leg.qty, fillPrice: mark.price, priceSource: mark.source })
  }
  return legs
}

export async function tryPaperManage(input: {
  root: string
  date: string
  nowMs: number
  nowIso: string
  session: OptionIntradaySession
  calendarDate: string
  getMark: (code: string, side: 'buy' | 'sell') => Promise<PaperMarkQuote | undefined>
  getLastClose: (underlying: string) => Promise<{
    lastClose: number
    volumeRatio?: number
  } | undefined>
  feePerContract?: number
}): Promise<void> {
  await withPaperStateLock(input.root, async () => {
  try {
    let state = await loadPaperState(input.root, input.date, input.nowIso)
    const currentDate = shanghaiCalendarDate(input.nowMs)
    for (const position of [...state.positions]) {
      try {
        const openedMs = Date.parse(position.openedBucketStart)
        const openedDate = Number.isFinite(openedMs)
          ? shanghaiCalendarDate(openedMs)
          : input.calendarDate
        let reason: 'invalidIf' | 'close5' | 'session' | undefined
        if (currentDate !== openedDate) {
          reason = 'session'
        } else {
          const market = await input.getLastClose(position.underlying)
          if (market !== undefined && invalidIfTriggered({
            invalidIf: position.invalidIf,
            lastClose: market.lastClose,
            ...(position.boxLow === undefined ? {} : { boxLow: position.boxLow }),
            ...(position.boxHigh === undefined ? {} : { boxHigh: position.boxHigh }),
            ...(market.volumeRatio === undefined ? {} : { volumeRatio: market.volumeRatio }),
          })) {
            reason = 'invalidIf'
          } else if (input.session === 'close5') {
            reason = 'close5'
          }
        }
        if (reason === undefined) continue
        const legs = await closeLegs(position, input.getMark)
        if (legs === undefined) continue
        state = applyClose(
          state,
          position.id,
          legs,
          reason,
          input.nowIso,
          input.feePerContract ?? OPTION_PAPER_FEE_PER_CONTRACT,
        )
      } catch {
        // A failed market lookup only skips this position for the current tick.
      }
    }
    await savePaperState(input.root, input.date, state)
  } catch {
    // Paper-account failures must never break cycle ticks.
  }
  })
}
