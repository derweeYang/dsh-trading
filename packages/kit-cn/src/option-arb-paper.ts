/**
 * 套利纸面引擎（arbitrage 账本）：executable 机会 → 对手价立即成交 →
 * 收敛 / 反转 / 到期自动平仓。纯决策函数 + 一次周期编排（tryArbPaperCycle），
 * 行情与保证金依赖全部注入，不触网。审计粒度 = 成交-only（不写 skip 桩 fill：
 * 30s×14 链会洪水化 jsonl）。
 */
import type {
  OptionChain,
  OptionIntradaySession,
  OptionPaperPriceSource,
  OptionQuoteRow,
  PaperFill,
  PaperLegFill,
  PaperPosition,
} from '@dshtrading/api'
import {
  boxSignedEdge,
  fromOptionChain,
  paritySignedEdge,
  scanArbitrage,
  type ArbitrageLeg,
  type ArbitrageOpportunity,
} from '@dshtrading/strategies/arbitrage'
import {
  applyClose,
  applyOpen,
  ensurePaperBooksLayout,
  fillFeeCny,
  loadPaperState,
  OPTION_MULTIPLIER,
  OPTION_PAPER_FEE_PER_CONTRACT,
  premiumCny,
  savePaperState,
  sizeQty,
  withPaperStateLock,
} from './option-paper.js'
import { shanghaiBucketStartMs } from './option-cycles.js'
import { shanghaiCalendarDate } from './option-bar-ledger.js'

/** 套利账本同时持有的最大组合数（风控上限，含跨标的）。 */
export const OPTION_ARB_MAX_POSITIONS = 6
/** 单个套利组合的最大张数（默认规模上限）。 */
export const OPTION_ARB_MAX_CONTRACTS_PER_POSITION = 10
/** 卖空现货腿的保证金率（融券近似，简化假设）。 */
export const OPTION_ARB_SHORT_SPOT_MARGIN_RATE = 0.5
/** 链缓存 TTL（调用方 bridge 侧使用；引擎自身的 on-hit refresh 不走缓存）。 */
export const OPTION_ARB_CHAIN_TTL_MS = 60_000
/** 开仓允许的链快照最大年龄（ms）——防陈旧盘口伪 executable。 */
export const OPTION_ARB_OPEN_SNAPSHOT_MAX_AGE_MS = 90_000

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export type ArbTakerMode = 'strict' | 'fallback'

/**
 * 对手价成交：buy 吃 ask / sell 吃 bid。
 * strict（开仓）= 盘口不健全宁可不交易；fallback（平仓）= 盘口撤了也得能平，
 * 回退 last → prevSettle（0/负价一律无效，防伪造盈利）。
 */
export function takerFillPrice(
  row: OptionQuoteRow,
  action: 'buy' | 'sell',
  mode: ArbTakerMode,
): { price: number; source: OptionPaperPriceSource } | undefined {
  const level = action === 'buy' ? row.ask : row.bid
  if (isPositiveFinite(level)) return { price: level, source: action === 'buy' ? 'ask' : 'bid' }
  if (mode === 'strict') return undefined
  if (isPositiveFinite(row.last)) return { price: row.last, source: 'last' }
  if (isPositiveFinite(row.prevSettle)) return { price: row.prevSettle, source: 'prev_settle' }
  return undefined
}

function encodeStrike(strike: number): number {
  return Math.round(strike * 1000)
}

/**
 * 套利持仓键：`arb:<kind>:<underlying>:<expiryMonth>:<K1>[-<K2>]`，strikes 升序归一，
 * **方向无关**——同 strikes 反向机会走平仓/换向路径，不叠仓。
 */
export function arbPositionKey(input: {
  kind: 'parity' | 'box'
  underlying: string
  expiryMonth: string
  strikes: readonly number[]
}): string {
  const enc = [...input.strikes].sort((a, b) => a - b).map(encodeStrike).join('-')
  return `arb:${input.kind}:${input.underlying}:${input.expiryMonth}:${enc}`
}

export type ArbOpenSkipReason =
  | 'not_executable'
  | 'stale_snapshot'
  | 'duplicate'
  | 'no_quote'
  | 'no_spot'
  | 'no_margin'
  | 'no_cash'

export interface ArbOpenInput {
  readonly opportunity: ArbitrageOpportunity
  /** 腿价从这里重推（不信 opportunity 上的数字，自洽防 TOCTOU）。 */
  readonly chain: OptionChain
  readonly positionKeys: ReadonlySet<string>
  readonly cash: number
  readonly nowMs: number
  /** parity 现货腿现价（元/份）。 */
  readonly spotPrice?: number
  /** 现货全符号（如 510050.SH），记账备查。 */
  readonly spotSymbol?: string
  /** 期权腿组合保证金（元/张，外部 getStrategy 注入）。 */
  readonly optionMarginPerContract?: number
  readonly maxContracts?: number
  readonly feePerContract?: number
}

export type ArbOpenDecision =
  | { kind: 'open'; fill: Omit<PaperFill, 'cashAfter'>; positionId: string }
  | { kind: 'skip'; reason: ArbOpenSkipReason }

export function decideArbOpen(input: ArbOpenInput): ArbOpenDecision {
  const opportunity = input.opportunity
  // 1. 休市/无盘口天然闸：只做可执行机会。
  if (opportunity.executable !== true) return { kind: 'skip', reason: 'not_executable' }
  // 2. 快照新鲜度闸：snapshotAt 缺失或过老 → 不可证新鲜。
  const snapshotMs = Date.parse(input.chain.snapshotAt ?? '')
  if (!Number.isFinite(snapshotMs) || input.nowMs - snapshotMs > OPTION_ARB_OPEN_SNAPSHOT_MAX_AGE_MS) {
    return { kind: 'skip', reason: 'stale_snapshot' }
  }
  // 3. 同 strikes 已持仓 → 不叠仓（方向无关键）。
  const strikes = opportunity.kind === 'parity'
    ? (opportunity.strike !== undefined ? [opportunity.strike] : undefined)
    : (opportunity.lowStrike !== undefined && opportunity.highStrike !== undefined
      ? [opportunity.lowStrike, opportunity.highStrike]
      : undefined)
  if (strikes === undefined) return { kind: 'skip', reason: 'no_quote' }
  const positionId = arbPositionKey({
    kind: opportunity.kind,
    underlying: opportunity.underlying,
    expiryMonth: opportunity.expiryMonth,
    strikes,
  })
  if (input.positionKeys.has(positionId)) return { kind: 'skip', reason: 'duplicate' }

  // 4. 期权腿价从链重推（strict 对手价）。
  const rows = [...input.chain.calls, ...input.chain.puts]
  const legs: PaperLegFill[] = []
  let premiumPer = 0
  for (const leg of opportunity.legs) {
    const row = rows.find((item) => item.code === leg.code)
    const fill = row === undefined ? undefined : takerFillPrice(row, leg.action, 'strict')
    if (fill === undefined) return { kind: 'skip', reason: 'no_quote' }
    legs.push({
      code: leg.code,
      side: leg.action,
      qty: 1,
      fillPrice: fill.price,
      priceSource: fill.source,
    })
    premiumPer += (leg.action === 'sell' ? 1 : -1) * fill.price * OPTION_MULTIPLIER
  }

  // 5. parity 现货腿（1 张 = multiplier 份）；box 无现货腿。
  if (opportunity.kind === 'parity') {
    if (!isPositiveFinite(input.spotPrice)) return { kind: 'skip', reason: 'no_spot' }
    const spotSide = opportunity.direction === 'sell_synthetic_buy_spot' ? 'buy' : 'sell'
    legs.push({
      code: opportunity.underlying,
      side: spotSide,
      qty: OPTION_MULTIPLIER, // 每张的份数，下方按 qty 放大
      fillPrice: input.spotPrice!,
      priceSource: 'spot',
      asset: 'spot',
      ...(input.spotSymbol === undefined ? {} : { spotSymbol: input.spotSymbol }),
    })
    premiumPer += (spotSide === 'sell' ? 1 : -1) * input.spotPrice! * OPTION_MULTIPLIER
  }

  // 6. 保证金：期权腿外部注入 + 卖空现货腿融券近似。
  if (input.optionMarginPerContract === undefined
    || !Number.isFinite(input.optionMarginPerContract)
    || input.optionMarginPerContract < 0) {
    return { kind: 'skip', reason: 'no_margin' }
  }
  let marginPer = input.optionMarginPerContract
  if (opportunity.kind === 'parity' && opportunity.direction === 'buy_synthetic_sell_spot') {
    marginPer += input.spotPrice! * OPTION_MULTIPLIER * OPTION_ARB_SHORT_SPOT_MARGIN_RATE
  }

  // 7. 规模：现金约束下取 min(max, 可负担)（买现货腿 ~3 万/张现金占用自然限仓）。
  const qty = sizeQty(
    input.maxContracts ?? OPTION_ARB_MAX_CONTRACTS_PER_POSITION,
    input.cash,
    premiumPer,
    marginPer,
  )
  if (qty === 0) return { kind: 'skip', reason: 'no_cash' }

  // 8. 落账 fill（腿 qty 按张数放大；现货腿份数 = 张 × multiplier）。
  const scaledLegs = legs.map((leg) => ({ ...leg, qty: leg.qty * qty }))
  const feeCny = fillFeeCny(scaledLegs, input.feePerContract ?? OPTION_PAPER_FEE_PER_CONTRACT)
  return {
    kind: 'open',
    positionId,
    fill: {
      id: `${positionId}:open`,
      bucketStart: new Date(shanghaiBucketStartMs(input.nowMs)).toISOString(),
      asOf: new Date(input.nowMs).toISOString(),
      underlying: opportunity.underlying,
      template: opportunity.kind,
      offset: 'open',
      qty,
      legs: scaledLegs,
      premiumCny: premiumCny(scaledLegs),
      marginCny: marginPer * qty,
      reason: 'arb_open',
      book: 'arbitrage',
      ...(input.chain.expiryDate === undefined ? {} : { expiryDate: input.chain.expiryDate }),
      openEdgePerShare: opportunity.edgePerShare,
      ...(feeCny === 0 ? {} : { feeCny }),
    },
  }
}

/** 平仓优先级：到期强平 > 边反转 > 收敛（开仓边一半）；边缺/未收敛 → hold。 */
export function decideArbClose(input: {
  position: PaperPosition
  currentEdgePerShare?: number
  todayDate: string
}): 'arb_expiry' | 'arb_reverse' | 'arb_converge' | undefined {
  if (input.position.expiryDate !== undefined && input.todayDate >= input.position.expiryDate) {
    return 'arb_expiry'
  }
  const edge = input.currentEdgePerShare
  if (edge === undefined || !Number.isFinite(edge)) return undefined
  if (edge < 0) return 'arb_reverse'
  const open = input.position.openEdgePerShare
  if (open !== undefined && open > 0 && edge < open / 2) return 'arb_converge'
  return undefined
}

/**
 * 平仓腿：每腿反向（buy↔sell）；期权腿价由 markOptionLeg 注入（调用方用
 * takerFillPrice fallback），现货腿用 spotMark。任一腿无价 → undefined（本轮 hold）。
 */
export function buildArbCloseLegs(
  position: PaperPosition,
  markOptionLeg: (code: string, action: 'buy' | 'sell') => { price: number; source: OptionPaperPriceSource } | undefined,
  spotMark?: { price: number; source: OptionPaperPriceSource },
): PaperLegFill[] | undefined {
  const legs: PaperLegFill[] = []
  for (const leg of position.legs) {
    const side = leg.side === 'sell' ? 'buy' : 'sell'
    const mark = leg.asset === 'spot'
      ? spotMark
      : markOptionLeg(leg.code, side)
    if (mark === undefined || !Number.isFinite(mark.price)) return undefined
    legs.push({
      code: leg.code,
      side,
      qty: leg.qty,
      fillPrice: mark.price,
      priceSource: mark.source,
      ...(leg.asset === undefined ? {} : { asset: leg.asset }),
      ...(leg.spotSymbol === undefined ? {} : { spotSymbol: leg.spotSymbol }),
    })
  }
  return legs
}

export interface ArbPaperCycleInput {
  readonly root: string
  readonly date: string
  readonly nowMs: number
  readonly nowIso: string
  readonly session: OptionIntradaySession
  /** 待扫标的（6 位 underlying，SYNTH 已由调用方滤除）。 */
  readonly underlyings: readonly string[]
  /** 每标的要扫的到期月（近/次月）。 */
  readonly expiryMonthsFor: (underlying: string) => Promise<readonly string[]>
  readonly getChain: (underlying: string, expiryMonth: string, opts?: { refresh?: boolean }) => Promise<OptionChain | undefined>
  readonly getSpot: (underlying: string) => Promise<number | undefined>
  /** 期权腿组合保证金（元/张）。 */
  readonly getOptionLegMarginPerContract: (underlying: string, legs: readonly ArbitrageLeg[]) => Promise<number | undefined>
  readonly spotSymbolFor?: (underlying: string) => string | undefined
  readonly feePerContract?: number
}

function opportunityStrikes(opportunity: ArbitrageOpportunity): readonly number[] | undefined {
  return opportunity.kind === 'parity'
    ? (opportunity.strike !== undefined ? [opportunity.strike] : undefined)
    : (opportunity.lowStrike !== undefined && opportunity.highStrike !== undefined
      ? [opportunity.lowStrike, opportunity.highStrike]
      : undefined)
}

function positionKeyOf(opportunity: ArbitrageOpportunity): string | undefined {
  const strikes = opportunityStrikes(opportunity)
  return strikes === undefined ? undefined : arbPositionKey({
    kind: opportunity.kind,
    underlying: opportunity.underlying,
    expiryMonth: opportunity.expiryMonth,
    strikes,
  })
}

/** 持仓残余边（signedEdge 同口径）；链缺/要素缺 → undefined（hold）。 */
function positionCurrentEdge(position: PaperPosition, chain: OptionChain | undefined): number | undefined {
  if (chain === undefined
    || position.strikes === undefined
    || position.direction === undefined
    || position.strikes.length === 0) return undefined
  const arb = fromOptionChain(chain)
  if (position.template === 'box') {
    if (position.strikes.length < 2) return undefined
    return boxSignedEdge(
      arb,
      position.strikes[0]!,
      position.strikes[1]!,
      position.direction as 'long_box' | 'short_box',
    )?.edgePerShare
  }
  return paritySignedEdge(
    arb,
    position.strikes[0]!,
    position.direction as 'buy_synthetic_sell_spot' | 'sell_synthetic_buy_spot',
  )?.edgePerShare
}

async function arbCloseLegs(
  position: PaperPosition,
  chain: OptionChain | undefined,
  getSpot: (underlying: string) => Promise<number | undefined>,
): Promise<PaperLegFill[] | undefined> {
  const needsSpot = position.legs.some((leg) => leg.asset === 'spot')
  const spotPrice = needsSpot ? await getSpot(position.underlying).catch(() => undefined) : undefined
  const rows = chain === undefined ? [] : [...chain.calls, ...chain.puts]
  return buildArbCloseLegs(
    position,
    (code, action) => {
      const row = rows.find((item) => item.code === code)
      return row === undefined ? undefined : takerFillPrice(row, action, 'fallback')
    },
    isPositiveFinite(spotPrice) ? { price: spotPrice, source: 'spot' } : undefined,
  )
}

/**
 * 一次套利纸面周期（30s 心跳驱动）：先平仓轮（任何 session——到期强平跨休市可重试），
 * 再开仓轮（仅 regular）。root 锁内、顶层吞错（镜像 tryPaperManage 容错）。
 */
export async function tryArbPaperCycle(input: ArbPaperCycleInput): Promise<void> {
  await withPaperStateLock(input.root, async () => {
    try {
      await ensurePaperBooksLayout(input.root)
      let state = await loadPaperState(input.root, input.date, input.nowIso, 'arbitrage')
      const todayDate = shanghaiCalendarDate(input.nowMs)
      const fee = input.feePerContract ?? OPTION_PAPER_FEE_PER_CONTRACT

      // ---- 平仓轮 ----
      for (const position of [...state.positions]) {
        const chain = position.expiryMonth === undefined
          ? undefined
          : await input.getChain(position.underlying, position.expiryMonth).catch(() => undefined)
        const currentEdge = positionCurrentEdge(position, chain)
        const reason = decideArbClose({
          position,
          ...(currentEdge === undefined ? {} : { currentEdgePerShare: currentEdge }),
          todayDate,
        })
        if (reason === undefined) continue
        const legs = await arbCloseLegs(position, chain, input.getSpot)
        if (legs === undefined) continue // 到期无价 → 跨期悬挂，下轮重试
        state = applyClose(state, position.id, legs, reason, input.nowIso, fee)
      }

      // ---- 开仓轮（仅 regular 会话）----
      if (input.session === 'regular') {
        scan: for (const underlying of input.underlyings) {
          if (state.positions.length >= OPTION_ARB_MAX_POSITIONS) break scan
          const months = await input.expiryMonthsFor(underlying).catch(() => [])
          for (const month of months) {
            if (state.positions.length >= OPTION_ARB_MAX_POSITIONS) break scan
            const chain = await input.getChain(underlying, month).catch(() => undefined)
            if (chain === undefined) continue
            const opportunities = scanArbitrage(fromOptionChain(chain), { feePerContract: fee })
            for (const opportunity of opportunities) {
              if (state.positions.length >= OPTION_ARB_MAX_POSITIONS) break scan
              const key = positionKeyOf(opportunity)
              if (key === undefined || !opportunity.executable) continue
              if (state.positions.some((position) => position.id === key)) continue
              const marginPer = await input
                .getOptionLegMarginPerContract(underlying, opportunity.legs)
                .catch(() => undefined)
              const spotPrice = opportunity.kind === 'parity'
                ? await input.getSpot(underlying).catch(() => undefined)
                : undefined
              const spotSymbol = input.spotSymbolFor?.(underlying)
              const openInput = {
                opportunity,
                chain,
                positionKeys: new Set(state.positions.map((position) => position.id)),
                cash: state.account.cash,
                nowMs: input.nowMs,
                ...(spotPrice === undefined ? {} : { spotPrice }),
                ...(spotSymbol === undefined ? {} : { spotSymbol }),
                ...(marginPer === undefined ? {} : { optionMarginPerContract: marginPer }),
                feePerContract: fee,
              } satisfies ArbOpenInput
              const decided = decideArbOpen(openInput)
              if (decided.kind !== 'open') continue
              // on-hit refresh：绕缓存强制新拉链重扫——仍 executable 且同向才落账
              // （削缓存前视偏差；边已反转/消失则本轮放弃）。
              const fresh = await input.getChain(underlying, month, { refresh: true }).catch(() => undefined)
              if (fresh === undefined) continue
              const still = scanArbitrage(fromOptionChain(fresh), { feePerContract: fee })
                .find((item) => positionKeyOf(item) === key && item.direction === opportunity.direction)
              if (still === undefined) continue
              const confirmed = decideArbOpen({ ...openInput, opportunity: still, chain: fresh })
              if (confirmed.kind !== 'open') continue
              const stillStrikes = opportunityStrikes(still)
              state = applyOpen(state, {
                ...confirmed.fill,
                positionId: confirmed.positionId,
                expiryMonth: month,
                direction: still.direction,
                ...(stillStrikes === undefined ? {} : { strikes: stillStrikes }),
              })
            }
          }
        }
      }

      await savePaperState(input.root, input.date, state, 'arbitrage')
    } catch {
      // 套利纸账失败绝不阻断 cycle ticks。
    }
  })
}
