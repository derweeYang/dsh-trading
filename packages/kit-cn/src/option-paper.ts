import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  OPTION_MULTIPLIER,
  OPTION_PAPER_INITIAL_CASH,
  type OptionBarRecommendation,
  type OptionChain,
  type OptionIntradayBoxRow,
  type OptionIntradaySession,
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

export { OPTION_MULTIPLIER, OPTION_PAPER_INITIAL_CASH }

export interface PaperState {
  account: PaperAccount
  positions: PaperPosition[]
  fills: PaperFill[]
}

type PaperLegs = PaperFill['legs']
type SkipReason = NonNullable<PaperFill['skip']>

export function emptyPaperAccount(nowIso: string): PaperAccount {
  return {
    currency: 'CNY',
    initialCash: OPTION_PAPER_INITIAL_CASH,
    cash: OPTION_PAPER_INITIAL_CASH,
    realizedPnl: 0,
    updatedAt: nowIso,
  }
}

export function quoteFillPrice(
  row: OptionQuoteRow & { bid?: number; ask?: number },
  _side: 'buy' | 'sell',
): number | undefined {
  const price = row.last ?? row.prevSettle
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return undefined
  return price
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

  const shortPrice = quoteFillPrice(short, 'sell')
  const longPrice = quoteFillPrice(long, 'buy')
  if (shortPrice === undefined || longPrice === undefined) {
    return { legs: [], skip: 'no_quote' }
  }

  return {
    legs: [
      { code: short.code, side: 'sell', qty, fillPrice: shortPrice },
      { code: long.code, side: 'buy', qty, fillPrice: longPrice },
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
  const cash = state.account.cash + fill.premiumCny - fill.marginCny
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
): PaperState {
  const position = state.positions.find((item) => item.id === positionId)
  if (position === undefined) return state

  const closePremium = premiumCny(legs)
  const openPremium = premiumCny(position.legs)
  const cash = state.account.cash + closePremium + position.marginCny
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
  }

  return {
    account: {
      ...state.account,
      cash,
      realizedPnl: state.account.realizedPnl + openPremium + closePremium,
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
    }
    const price = [row.last, row.fillPrice, row.premium]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (
      typeof row.code !== 'string'
      || (row.side !== 'buy' && row.side !== 'sell')
      || price === undefined
    ) return undefined
    return { code: row.code, side: row.side, qty: 1, fillPrice: price }
  })
  return parsed.every((leg) => leg !== undefined) ? parsed as PaperLegs : undefined
}

export function decidePaperOpen(input: {
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  fillsToday: readonly PaperFill[]
  chainFor: (underlying: string) => OptionChain | undefined
  marginFor: (legs: PaperLegs) => number
  nowIso: string
  cash: number
}): { fill: Omit<PaperFill, 'cashAfter'> } | { skip: PaperFill } | { noop: true } {
  const { rec } = input
  if (rec.skipReason !== undefined || rec.noTrade) return { noop: true }
  if (hasSuccessfulOpen(input.fillsToday, rec.bucketStart)) {
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
    const qty = sizeQty(pick.maxContracts, input.cash, premiumPer, marginPer)
    if (qty === 0) {
      lastFailure = {
        reason: 'no_cash',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }

    const legs = unitLegs.map((leg) => ({ ...leg, qty }))
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
}

function legsKey(legs: PaperLegs): string {
  return legs.map((leg) => `${leg.code}:${leg.side}:${leg.qty}:${leg.fillPrice}`).join('|')
}

export async function tryPaperOpen(input: {
  root: string
  date: string
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  nowIso: string
  getChain: (underlying: string) => Promise<OptionChain | undefined>
  getMargin: (legs: PaperFill['legs']) => Promise<number>
}): Promise<void> {
  try {
    const state = await loadPaperState(input.root, input.date, input.nowIso)
    const chains = new Map<string, OptionChain | undefined>()
    const margins = new Map<string, number>()

    for (const pick of input.rec.picks) {
      if (!pick.underlying || !pick.template) continue
      let legs = explicitLegs(pick.legs)
      if (legs === undefined) {
        let chain = chains.get(pick.underlying)
        if (!chains.has(pick.underlying)) {
          chain = await input.getChain(pick.underlying)
          chains.set(pick.underlying, chain)
        }
        const forecast = input.forecastByUnderlying[pick.underlying]
        const candidate = forecast?.candidates.find((item) => item.template === pick.template)
        if (chain !== undefined && candidate !== undefined) {
          const completed = completeVerticalLegs(chain, candidate.bias, 1)
          if (completed.skip === undefined) legs = completed.legs
        }
      }
      if (legs !== undefined) margins.set(legsKey(legs), await input.getMargin(legs))
    }

    const decision = decidePaperOpen({
      rec: input.rec,
      forecastByUnderlying: input.forecastByUnderlying,
      fillsToday: state.fills,
      chainFor: (underlying) => chains.get(underlying),
      marginFor: (legs) => margins.get(legsKey(legs)) ?? 0,
      nowIso: input.nowIso,
      cash: state.account.cash,
    })
    let next = state
    if ('fill' in decision) {
      const forecast = decision.fill.underlying === undefined
        ? undefined
        : input.forecastByUnderlying[decision.fill.underlying]
      next = applyOpen(state, {
        ...decision.fill,
        invalidIf: input.rec.invalidIf,
        ...(forecast?.boxLow === undefined ? {} : { boxLow: forecast.boxLow }),
        ...(forecast?.boxHigh === undefined ? {} : { boxHigh: forecast.boxHigh }),
      })
    } else if ('skip' in decision) {
      next = { ...state, fills: [...state.fills, decision.skip] }
    }
    if (!('noop' in decision)) await savePaperState(input.root, input.date, next)
  } catch {
    // Paper-account failures must never break recommendation persistence.
  }
}

async function closeLegs(
  position: PaperPosition,
  getMark: (code: string, side: 'buy' | 'sell') => Promise<number | undefined>,
): Promise<PaperLegs | undefined> {
  const legs: PaperLegs[number][] = []
  for (const leg of position.legs) {
    const side = leg.side === 'sell' ? 'buy' : 'sell'
    const fillPrice = await getMark(leg.code, side)
    if (fillPrice === undefined) return undefined
    legs.push({ code: leg.code, side, qty: leg.qty, fillPrice })
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
  getMark: (code: string, side: 'buy' | 'sell') => Promise<number | undefined>
  getLastClose: (underlying: string) => Promise<{
    lastClose: number
    volumeRatio?: number
  } | undefined>
}): Promise<void> {
  try {
    let state = await loadPaperState(input.root, input.date, input.nowIso)
    const currentDate = shanghaiCalendarDate(input.nowMs)
    for (const position of [...state.positions]) {
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
      state = applyClose(state, position.id, legs, reason, input.nowIso)
    }
    await savePaperState(input.root, input.date, state)
  } catch {
    // Paper-account failures must never break cycle ticks.
  }
}
