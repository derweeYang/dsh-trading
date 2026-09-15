import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  OPTION_MULTIPLIER,
  OPTION_PAPER_FEE_PER_CONTRACT,
  OPTION_PAPER_INITIAL_CASH,
  type OptionBarRecommendation,
  type OptionChain,
  type OptionIntradayBoxRow,
  type OptionIntradaySession,
  type OptionPaperBookId,
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

/** 套利账本现货腿佣金率（万 1，无最低，简化假设；显式导出供覆盖与审计）。 */
export const OPTION_PAPER_SPOT_FEE_RATE = 0.0001

export interface PaperState {
  account: PaperAccount
  positions: PaperPosition[]
  fills: PaperFill[]
}

type PaperLegs = PaperFill['legs']
type SkipReason = NonNullable<PaperFill['skip']>
const paperStateLocks = new Map<string, Promise<void>>()

/** 同 root 账本操作串行化（按 root 排队、不可重入；套利引擎与策略账本共用）。 */
export async function withPaperStateLock<T>(root: string, task: () => Promise<T>): Promise<T> {
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

export function emptyPaperAccount(nowIso: string, book?: OptionPaperBookId): PaperAccount {
  return {
    currency: 'CNY',
    initialCash: OPTION_PAPER_INITIAL_CASH,
    cash: OPTION_PAPER_INITIAL_CASH,
    realizedPnl: 0,
    updatedAt: nowIso,
    ...(book === undefined ? {} : { id: book }),
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
  // 正价才有效：iquant 链缺价合约回 last=0，0 价成交会伪造盈利。
  if (typeof row.last === 'number' && Number.isFinite(row.last) && row.last > 0) {
    return { price: row.last, source: 'last' }
  }
  if (typeof row.prevSettle === 'number' && Number.isFinite(row.prevSettle) && row.prevSettle > 0) {
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

/**
 * 手续费：期权腿每张费率 × 张数合计；现货腿按名义额 × 现货佣金率
 * （skip 桩 legs=[] 自然为 0）。旧行无 asset 键 → 全按期权腿。
 */
export function fillFeeCny(
  legs: PaperLegs,
  feePerContract: number,
  spotFeeRate: number = OPTION_PAPER_SPOT_FEE_RATE,
): number {
  return legs.reduce((total, leg) => (
    leg.asset === 'spot'
      ? total + Math.abs(leg.fillPrice * leg.qty) * spotFeeRate
      : total + feePerContract * leg.qty
  ), 0)
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

/**
 * 蝶式腿补全（2026-09-14）：long butterfly = 买 1 低行权价 + 卖 2 中间 + 买 1 高行权价。
 *
 * 为什么现在才有：此前只有 vertical 会去取链（`pick.template !== 'vertical'` 直接
 * 判 no_quote），而蝶式候选 bias 恒为 `neutral`——`completeVerticalLegs` 见到 neutral
 * 同样返回 no_quote。结果是**蝶式在纸账户里永远不可能成交**，09-14 三条 butterfly
 * 推荐全部以 no_quote 收场。蝶式不依赖方向 bias，只依赖「ATM 上下各一档」，故单独构造。
 *
 * 与 vertical 同款纪律：任一腿拿不到可成交报价即 no_quote，绝不口算权利金。
 */
export function completeButterflyLegs(
  chain: OptionChain,
  qty: number,
): { legs: PaperLegs; skip?: 'no_quote' } {
  const rows = [...chain.calls].sort((left, right) => left.strike - right.strike)
  const midIndex = nearestIndex(rows, chain.spot)
  const low = rows[midIndex - 1]
  const body = rows[midIndex]
  const high = rows[midIndex + 1]
  if (!low?.code || !body?.code || !high?.code) return { legs: [], skip: 'no_quote' }

  const lowQuote = quoteFillPriceWithSource(low)
  const bodyQuote = quoteFillPriceWithSource(body)
  const highQuote = quoteFillPriceWithSource(high)
  if (lowQuote === undefined || bodyQuote === undefined || highQuote === undefined) {
    return { legs: [], skip: 'no_quote' }
  }

  return {
    legs: [
      { code: low.code, side: 'buy', qty, fillPrice: lowQuote.price, priceSource: lowQuote.source },
      { code: body.code, side: 'sell', qty: qty * 2, fillPrice: bodyQuote.price, priceSource: bodyQuote.source },
      { code: high.code, side: 'buy', qty, fillPrice: highQuote.price, priceSource: highQuote.source },
    ],
  }
}

/** 单腿现金流（元）：sell 正 buy 负；期权腿 ×multiplier，现货腿 qty 已是份数不再乘。 */
export function legCashCny(leg: PaperLegs[number]): number {
  return (leg.side === 'sell' ? 1 : -1) * leg.fillPrice * leg.qty
    * (leg.asset === 'spot' ? 1 : OPTION_MULTIPLIER)
}

/** 组合现金流（元）：Σ legCashCny。纯期权腿与旧实现逐位等价。 */
export function premiumCny(legs: PaperLegs): number {
  return legs.reduce((total, leg) => total + legCashCny(leg), 0)
}

/** 盯市腿值（元）：多头为正；期权腿 ×multiplier，现货腿按份（equity 口径与 bridge 一致）。 */
export function markLegValueCny(leg: PaperLegs[number], markPrice: number): number {
  return (leg.side === 'buy' ? 1 : -1) * markPrice * leg.qty
    * (leg.asset === 'spot' ? 1 : OPTION_MULTIPLIER)
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
    /** 持仓 id 覆盖（套利同标的同桶多机会需要显式区分）。 */
    positionId?: string
    /** 套利持仓新维度（透传进 position；fill 自身字段经 ...fillRow 落账）。 */
    expiryMonth?: string
    expiryDate?: string
    direction?: PaperPosition['direction']
    strikes?: readonly number[]
    openEdgePerShare?: number
  },
): PaperState {
  const fee = fill.feeCny ?? 0
  const cash = state.account.cash + fill.premiumCny - fill.marginCny - fee
  const id = fill.id ?? `${fill.underlying ?? 'unknown'}:${fill.bucketStart}`
  const { invalidIf = '', boxLow, boxHigh, positionId, expiryMonth, direction, strikes, ...fillRow } = fill
  const recorded: PaperFill = { ...fillRow, id, cashAfter: cash }
  const position: PaperPosition | undefined = (
    fill.reason !== 'skipped'
    && fill.qty > 0
    && fill.underlying !== undefined
    && fill.template !== undefined
  ) ? {
      id: positionId ?? `${fill.underlying}:${fill.bucketStart}`,
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
      ...(fillRow.book === undefined ? {} : { book: fillRow.book }),
      ...(expiryMonth === undefined ? {} : { expiryMonth }),
      ...(fillRow.expiryDate === undefined ? {} : { expiryDate: fillRow.expiryDate }),
      ...(direction === undefined ? {} : { direction }),
      ...(strikes === undefined ? {} : { strikes }),
      ...(fillRow.openEdgePerShare === undefined ? {} : { openEdgePerShare: fillRow.openEdgePerShare }),
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
  reason: 'invalidIf' | 'close5' | 'session' | 'arb_converge' | 'arb_reverse' | 'arb_expiry',
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

/**
 * 腿方向归一化：推荐侧写法不统一，实测见过 `side:'buy'|'sell'` 与
 * `action:'buy'|'sell'|'buy_to_open'|'sell_to_open'`。取首个下划线段即可覆盖；
 * 认不出来返回 undefined（宁可回退取链，也不猜方向）。
 */
function legSide(value: unknown): 'buy' | 'sell' | undefined {
  if (value === 'buy' || value === 'sell') return value
  if (typeof value !== 'string') return undefined
  const head = value.split('_')[0]
  return head === 'buy' || head === 'sell' ? head : undefined
}

function explicitLegs(legs: readonly unknown[] | undefined): PaperLegs | undefined {
  if (legs === undefined || legs.length === 0) return undefined
  const parsed = legs.map((item) => {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as {
      code?: unknown
      side?: unknown
      action?: unknown
      last?: unknown
      fillPrice?: unknown
      premium?: unknown
      price?: unknown
      limitPrice?: unknown
      bid?: unknown
      ask?: unknown
      quoteBid?: unknown
      quoteAsk?: unknown
      qty?: unknown
      ratio?: unknown
    }
    // 2026-09-15：原实现只认 `side` + `last/fillPrice/premium`，而盘中推荐实际给的是
    // `action` + `price` / `limitPrice` / `quoteBid`+`quoteAsk`——字段名对不上，
    // 带腿的推荐**全部**解析失败并回退取链，取链再失败就是 no_quote。这是纸账户
    // 有腿也开不了仓的直接原因（09-15 上午三条带 picks 推荐零开仓尝试）。
    const side = legSide(row.side) ?? legSide(row.action)
    if (side === undefined || typeof row.code !== 'string') return undefined
    const explicitPrice = [row.last, row.fillPrice, row.premium, row.price, row.limitPrice]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const bid = [row.bid, row.quoteBid]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const ask = [row.ask, row.quoteAsk]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    // 无显式成交价时退盘口**保守侧**：买吃 ask、卖吃 bid（真实报价，不是口算），
    // 并把来源如实标进 priceSource，避免事后把假设价当成成交价。
    const price = explicitPrice ?? (side === 'buy' ? ask : bid)
    if (price === undefined) return undefined
    const priceSource: OptionPaperPriceSource = explicitPrice !== undefined
      ? 'pick'
      : (side === 'buy' ? 'ask' : 'bid')
    const qty = row.qty ?? row.ratio ?? 1
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) return undefined
    return { code: row.code, side, qty, fillPrice: price, priceSource }
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
      // 2026-09-14：蝶式此前被这一行直接判死（只有 vertical 会取链）→ 纸账户蝶式
      // 零成交。放行蝶式，与 vertical 同走「取链 → 按模板补全腿」路径。
      if (pick.template !== 'vertical' && pick.template !== 'butterfly') {
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
      const completed = pick.template === 'butterfly'
        ? completeButterflyLegs(chain, 1)
        : completeVerticalLegs(chain, candidate.bias, 1)
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

const paperBooksMigrated = new Set<string>()

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** rename 平移；目标已存在跳过（宁可弃旧不毁新），源缺失容忍。 */
async function moveIfAbsent(from: string, to: string): Promise<void> {
  if (await pathExists(to)) return
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * 单账本 → paper/<book>/ 多账本布局的惰性迁移（旧 paper/{account.json,positions.json,fills/}
 * → paper/strategy/）。无锁幂等（rename 原子、目标存在即跳过、残缺旧布局只移存在的项），
 * load/reset 入口都会路过；旧目录留空壳不删（Windows 受保护树纪律：只移动不删除）。
 */
export async function ensurePaperBooksLayout(root: string): Promise<void> {
  if (paperBooksMigrated.has(root)) return
  try {
    const legacyPaper = path.join(root, 'paper')
    const legacyAccount = path.join(legacyPaper, 'account.json')
    const legacyPositions = path.join(legacyPaper, 'positions.json')
    const legacyFills = path.join(legacyPaper, 'fills')
    const residue = (await pathExists(legacyAccount))
      || (await pathExists(legacyPositions))
      || (await pathExists(legacyFills))
    const strategyReady = await pathExists(paperAccountPath(root, 'strategy'))
    if (residue) {
      await mkdir(path.dirname(paperAccountPath(root, 'strategy')), { recursive: true })
      await moveIfAbsent(legacyAccount, paperAccountPath(root, 'strategy'))
      await moveIfAbsent(legacyPositions, paperPositionsPath(root, 'strategy'))
      await moveIfAbsent(legacyFills, path.join(root, 'paper', 'strategy', 'fills'))
    }
    if (residue || strategyReady) paperBooksMigrated.add(root)
  } catch {
    // 迁移失败下轮 load 重试；不阻断账本读写。
  }
}

export async function loadPaperState(
  root: string,
  date: string,
  nowIso: string,
  book: OptionPaperBookId = 'strategy',
): Promise<PaperState> {
  await ensurePaperBooksLayout(root)
  const [account, positions, fills] = await Promise.all([
    readJsonFile(paperAccountPath(root, book), emptyPaperAccount(nowIso, book)),
    readJsonFile<PaperPosition[]>(paperPositionsPath(root, book), []),
    readJsonl<PaperFill>(paperFillsPath(root, book, date)),
  ])
  // 旧账本文件无 id → 内存回填（下次 save 自然落盘）。
  const normalized: PaperAccount = account.id === undefined ? { ...account, id: book } : account
  return { account: normalized, positions, fills }
}

function fillCalendarDate(fill: PaperFill): string | undefined {
  const time = Date.parse(fill.asOf)
  return Number.isFinite(time) ? shanghaiCalendarDate(time) : undefined
}

export async function savePaperState(
  root: string,
  date: string,
  state: PaperState,
  book: OptionPaperBookId = 'strategy',
): Promise<void> {
  const accountFile = paperAccountPath(root, book)
  const positionsFile = paperPositionsPath(root, book)
  const fillsFile = paperFillsPath(root, book, date)
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

export async function resetPaperState(
  root: string,
  nowIso: string,
  book: OptionPaperBookId = 'strategy',
): Promise<PaperState> {
  return await withPaperStateLock(root, async () => {
    await ensurePaperBooksLayout(root)
    const state: PaperState = {
      account: emptyPaperAccount(nowIso, book),
      positions: [],
      fills: [],
    }
    const accountFile = paperAccountPath(root, book)
    await mkdir(path.dirname(accountFile), { recursive: true })
    await Promise.all([
      writeFile(accountFile, `${JSON.stringify(state.account)}\n`, 'utf8'),
      writeFile(paperPositionsPath(root, book), '[]\n', 'utf8'),
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
  /** 2026-09-15：失败观测。此前总 catch 静默吞错，带 picks 桶执行痕迹为零也无从排查。 */
  log?: (message: string, error?: unknown) => void
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
        // 2026-09-14：蝶式与 vertical 一样需要从链补腿（原先只给 vertical 取链，
        // 蝶式的 chainFor 恒 undefined → 必然 no_quote）。
        const needsChain = explicit === undefined
          && (pick.template === 'vertical' || pick.template === 'butterfly')
        const chain = needsChain ? await input.getChain(pick.underlying) : undefined
        let unitLegs = explicit
        if (unitLegs === undefined && chain !== undefined) {
          if (pick.template === 'butterfly') {
            unitLegs = completeButterflyLegs(chain, 1).legs
          } else if (pick.template === 'vertical') {
            unitLegs = completeVerticalLegs(chain, candidate.bias, 1).legs
          }
        }
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
  } catch (error) {
    // Paper-account failures must never break recommendation persistence.
    input.log?.(
      `tryPaperOpen failed (bucket=${input.rec.bucketStart} picks=${input.rec.picks.length})`,
      error,
    )
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
