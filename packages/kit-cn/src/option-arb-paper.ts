/**
 * 套利纸面引擎（arbitrage 账本）：executable 机会 → 对手价立即成交 →
 * 收敛 / 反转 / 到期自动平仓。纯决策函数 + 一次周期编排（tryArbPaperCycle），
 * 行情与保证金依赖全部注入，不触网。审计粒度 = 成交-only（不写 skip 桩 fill：
 * 30s×14 链会洪水化 jsonl）。
 * 2026-09-17 起同账本承载深实值贴水（intrinsic_call/intrinsic_put 模板，
 * 纯买腿无保证金，收敛/反转/到期平仓语义复用）。
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
  intrinsicSignedEdge,
  paritySignedEdge,
  scanArbitrage,
  scanIntrinsicDiscount,
  type ArbitrageLeg,
  type ArbitrageOpportunity,
  type IntrinsicDiscount,
  type OptionRight,
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
import {
  appendJsonlLine,
  arbHeartbeatPath,
  shanghaiCalendarDate,
  type ArbCycleHeartbeat,
} from './option-bar-ledger.js'

/** 套利账本同时持有的最大组合数（风控上限，含跨标的）。 */
export const OPTION_ARB_MAX_POSITIONS = 6
/** 单个套利组合的最大张数（默认规模上限）。 */
export const OPTION_ARB_MAX_CONTRACTS_PER_POSITION = 10
/** 深实值贴水子帽：防止高频贴水信号挤占 parity/box 的共享仓位上限。 */
export const OPTION_ARB_MAX_INTRINSIC_POSITIONS = 3
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
 * kind 含深实值贴水模板（intrinsic_call / intrinsic_put：call 与 put 是不同工具，键天然分离）。
 */
export function arbPositionKey(input: {
  kind: 'parity' | 'box' | 'intrinsic_call' | 'intrinsic_put'
  underlying: string
  expiryMonth: string
  strikes: readonly number[]
}): string {
  const enc = [...input.strikes].sort((a, b) => a - b).map(encodeStrike).join('-')
  return `arb:${input.kind}:${input.underlying}:${input.expiryMonth}:${enc}`
}

/** 深实值贴水持仓模板（right → template 字符串，落 PaperPosition.template 透传）。 */
export function intrinsicTemplateOf(right: OptionRight): 'intrinsic_call' | 'intrinsic_put' {
  return right === 'C' ? 'intrinsic_call' : 'intrinsic_put'
}

/** 模板字符串 → 贴水腿 right；非贴水模板返回 undefined。 */
export function rightOfIntrinsicTemplate(template: string): OptionRight | undefined {
  return template === 'intrinsic_call' ? 'C' : template === 'intrinsic_put' ? 'P' : undefined
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

export type ArbIntrinsicOpenSkipReason =
  | 'stale_snapshot'
  | 'duplicate'
  | 'no_quote'
  | 'no_spot'
  | 'edge_gone'
  | 'no_cash'

export interface ArbIntrinsicOpenInput {
  /** 扫描层机会（腿价从这里重推 + 边现算复核，防 TOCTOU）。 */
  readonly discount: IntrinsicDiscount
  readonly chain: OptionChain
  readonly positionKeys: ReadonlySet<string>
  readonly cash: number
  readonly nowMs: number
  /** bound 依赖的现货现价（元/份）；缺省不可决策。 */
  readonly spotPrice?: number
  readonly maxContracts?: number
  readonly feePerContract?: number
}

export type ArbIntrinsicOpenDecision =
  | { kind: 'open'; fill: Omit<PaperFill, 'cashAfter'>; positionId: string }
  | { kind: 'skip'; reason: ArbIntrinsicOpenSkipReason }

/**
 * 深实值贴水开仓决策：单买腿、无保证金、无现货腿。
 * 边复核 = intrinsicSignedEdge（bound − ask，与扫描同口径）；≤0 → edge_gone。
 */
export function decideIntrinsicOpen(input: ArbIntrinsicOpenInput): ArbIntrinsicOpenDecision {
  const discount = input.discount
  // 1. 快照新鲜度闸：与 parity/box 同款。
  const snapshotMs = Date.parse(input.chain.snapshotAt ?? '')
  if (!Number.isFinite(snapshotMs) || input.nowMs - snapshotMs > OPTION_ARB_OPEN_SNAPSHOT_MAX_AGE_MS) {
    return { kind: 'skip', reason: 'stale_snapshot' }
  }
  // 2. 去重键（call/put 模板分离；同键持仓 → 不叠仓）。
  const template = intrinsicTemplateOf(discount.right)
  const positionId = arbPositionKey({
    kind: template,
    underlying: discount.underlying,
    expiryMonth: discount.expiryMonth,
    strikes: [discount.strike],
  })
  if (input.positionKeys.has(positionId)) return { kind: 'skip', reason: 'duplicate' }

  // 3. 腿价 strict 重推（对手卖一），并现算再入场边复核。
  const row = [...input.chain.calls, ...input.chain.puts].find((item) => item.code === discount.leg.code)
  const fill = row === undefined ? undefined : takerFillPrice(row, 'buy', 'strict')
  if (fill === undefined) return { kind: 'skip', reason: 'no_quote' }
  if (!isPositiveFinite(input.spotPrice)) return { kind: 'skip', reason: 'no_spot' }
  const signed = intrinsicSignedEdge(arbChainOf(input.chain, input.spotPrice), discount.strike, discount.right)
  if (signed === undefined || signed.edgePerShare <= 0) return { kind: 'skip', reason: 'edge_gone' }

  // 4. 规模：纯买腿，占用 = |premium|（保证金 0）。
  const premiumPer = -fill.price * OPTION_MULTIPLIER
  const qty = sizeQty(input.maxContracts ?? OPTION_ARB_MAX_CONTRACTS_PER_POSITION, input.cash, premiumPer, 0)
  if (qty === 0) return { kind: 'skip', reason: 'no_cash' }

  // 5. 落账 fill（腿 qty 按张数放大）。
  const scaledLegs: PaperLegFill[] = [{
    code: discount.leg.code,
    side: 'buy',
    qty,
    fillPrice: fill.price,
    priceSource: fill.source,
  }]
  const feeCny = fillFeeCny(scaledLegs, input.feePerContract ?? OPTION_PAPER_FEE_PER_CONTRACT)
  return {
    kind: 'open',
    positionId,
    fill: {
      id: `${positionId}:open`,
      bucketStart: new Date(shanghaiBucketStartMs(input.nowMs)).toISOString(),
      asOf: new Date(input.nowMs).toISOString(),
      underlying: discount.underlying,
      template,
      offset: 'open',
      qty,
      legs: scaledLegs,
      premiumCny: premiumCny(scaledLegs),
      marginCny: 0,
      reason: 'arb_open',
      book: 'arbitrage',
      ...(input.chain.expiryDate === undefined ? {} : { expiryDate: input.chain.expiryDate }),
      openEdgePerShare: signed.edgePerShare,
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

/** 已持有的深实值贴水仓位数（子帽计数）。 */
function countIntrinsicPositions(positions: readonly PaperPosition[]): number {
  return positions.filter((position) => rightOfIntrinsicTemplate(position.template) !== undefined).length
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

/**
 * 扫描链组装：桥侧现价优先、缺省回落链自带 spot（iquant /v1/chain 不带该键——
 * 2026-09-17 诊断：无 spot 时 parityMatrix 恒空，平价检测整链瘫痪）。口径同
 * T 板 scanOptionChainArbitrage 的 query.spot ?? chain.spot。
 */
function arbChainOf(chain: OptionChain, spot: number | undefined): ReturnType<typeof fromOptionChain> {
  const base = fromOptionChain(chain)
  return isPositiveFinite(spot) ? { ...base, spot } : base
}

/** 残余边计算依赖桥侧现价的模板（parity 现货腿 / intrinsic 的 bound）。 */
function needsSpotForEdge(position: PaperPosition): boolean {
  return position.template === 'parity'
    || position.template === 'intrinsic_call'
    || position.template === 'intrinsic_put'
}

/** 持仓残余边（signedEdge 同口径）；链缺/要素缺 → undefined（hold）。 */
function positionCurrentEdge(
  position: PaperPosition,
  chain: OptionChain | undefined,
  spot?: number,
): number | undefined {
  if (chain === undefined
    || position.strikes === undefined
    || position.strikes.length === 0) return undefined
  const arb = arbChainOf(chain, spot)
  if (position.template === 'box') {
    if (position.direction === undefined || position.strikes.length < 2) return undefined
    return boxSignedEdge(
      arb,
      position.strikes[0]!,
      position.strikes[1]!,
      position.direction as 'long_box' | 'short_box',
    )?.edgePerShare
  }
  const intrinsicRight = rightOfIntrinsicTemplate(position.template)
  if (intrinsicRight !== undefined) {
    // 贴水持仓无 direction（right 在模板里）；无盘口 → undefined（hold 等下轮）。
    return intrinsicSignedEdge(arb, position.strikes[0]!, intrinsicRight)?.edgePerShare
  }
  if (position.direction === undefined) return undefined
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
    const startedMs = Date.now()
    const hb = {
      underlyingsScanned: 0,
      monthsScanned: 0,
      chainFailures: 0,
      parity: 0,
      box: 0,
      executable: 0,
      intrinsic: 0,
      openAttempts: 0,
      opens: 0,
      skipCounts: {} as Record<string, number>,
    }
    const noteSkip = (reason: string): void => {
      hb.skipCounts[reason] = (hb.skipCounts[reason] ?? 0) + 1
    }
    const writeHeartbeat = async (error?: string): Promise<void> => {
      await appendJsonlLine(arbHeartbeatPath(input.root, input.date), {
        kind: 'arb_cycle',
        asOf: input.nowIso,
        session: input.session,
        durationMs: Date.now() - startedMs,
        underlyingsScanned: hb.underlyingsScanned,
        monthsScanned: hb.monthsScanned,
        chainFailures: hb.chainFailures,
        opportunities: { parity: hb.parity, box: hb.box, executable: hb.executable },
        intrinsicDiscounts: hb.intrinsic,
        openAttempts: hb.openAttempts,
        opens: hb.opens,
        skipCounts: hb.skipCounts,
        ...(error === undefined ? {} : { error }),
      } satisfies ArbCycleHeartbeat)
    }
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
        if (position.expiryMonth !== undefined && chain === undefined) hb.chainFailures += 1
        // 残余边依赖 spot 的持仓（parity 现货腿 / intrinsic bound）：链不带时用桥侧现价补
        // （box 无现货腿不用）。
        const spot = chain !== undefined && chain.spot === undefined && needsSpotForEdge(position)
          ? await input.getSpot(position.underlying).catch(() => undefined)
          : undefined
        const currentEdge = positionCurrentEdge(position, chain, spot)
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
          hb.underlyingsScanned += 1
          const months = await input.expiryMonthsFor(underlying).catch(() => [])
          // 标的级现价取一次：扫描 / 双确认 / 现货腿成交同源（30s 周期内一致），
          // 拿不到则 parity 不可用（box 不依赖 spot，仍扫）。
          const spot = await input.getSpot(underlying).catch(() => undefined)
          for (const month of months) {
            if (state.positions.length >= OPTION_ARB_MAX_POSITIONS) break scan
            const chain = await input.getChain(underlying, month).catch(() => undefined)
            if (chain === undefined) {
              hb.chainFailures += 1
              continue
            }
            hb.monthsScanned += 1
            const opportunities = scanArbitrage(arbChainOf(chain, spot), { feePerContract: fee })
            hb.parity += opportunities.filter((item) => item.kind === 'parity').length
            hb.box += opportunities.filter((item) => item.kind === 'box').length
            hb.executable += opportunities.filter((item) => item.executable).length
            for (const opportunity of opportunities) {
              if (state.positions.length >= OPTION_ARB_MAX_POSITIONS) break scan
              const key = positionKeyOf(opportunity)
              if (key === undefined || !opportunity.executable) continue
              if (state.positions.some((position) => position.id === key)) continue
              const marginPer = await input
                .getOptionLegMarginPerContract(underlying, opportunity.legs)
                .catch(() => undefined)
              const spotSymbol = input.spotSymbolFor?.(underlying)
              const openInput = {
                opportunity,
                chain,
                positionKeys: new Set(state.positions.map((position) => position.id)),
                cash: state.account.cash,
                nowMs: input.nowMs,
                ...(opportunity.kind === 'parity' && isPositiveFinite(spot) ? { spotPrice: spot } : {}),
                ...(spotSymbol === undefined ? {} : { spotSymbol }),
                ...(marginPer === undefined ? {} : { optionMarginPerContract: marginPer }),
                feePerContract: fee,
              } satisfies ArbOpenInput
              hb.openAttempts += 1
              const decided = decideArbOpen(openInput)
              if (decided.kind !== 'open') {
                noteSkip(decided.reason)
                continue
              }
              // on-hit refresh：绕缓存强制新拉链重扫——仍 executable 且同向才落账
              // （削缓存前视偏差；边已反转/消失则本轮放弃）。
              const fresh = await input.getChain(underlying, month, { refresh: true }).catch(() => undefined)
              if (fresh === undefined) continue
              const still = scanArbitrage(arbChainOf(fresh, spot), { feePerContract: fee })
                .find((item) => positionKeyOf(item) === key && item.direction === opportunity.direction)
              if (still === undefined) continue
              const confirmed = decideArbOpen({ ...openInput, opportunity: still, chain: fresh })
              if (confirmed.kind !== 'open') {
                noteSkip(confirmed.reason)
                continue
              }
              const stillStrikes = opportunityStrikes(still)
              state = applyOpen(state, {
                ...confirmed.fill,
                positionId: confirmed.positionId,
                expiryMonth: month,
                direction: still.direction,
                ...(stillStrikes === undefined ? {} : { strikes: stillStrikes }),
              })
              hb.opens += 1
            }

            // 深实值贴水（纯买腿、无保证金；子帽独立于共享上限，不挤占 parity/box）。
            const intrinsicDiscounts = scanIntrinsicDiscount(arbChainOf(chain, spot), { feePerContract: fee })
            hb.intrinsic += intrinsicDiscounts.length
            for (const discount of intrinsicDiscounts) {
              if (state.positions.length >= OPTION_ARB_MAX_POSITIONS) break scan
              if (countIntrinsicPositions(state.positions) >= OPTION_ARB_MAX_INTRINSIC_POSITIONS) break
              const intrinsicInput = {
                discount,
                chain,
                positionKeys: new Set(state.positions.map((position) => position.id)),
                cash: state.account.cash,
                nowMs: input.nowMs,
                ...(isPositiveFinite(spot) ? { spotPrice: spot } : {}),
                feePerContract: fee,
              } satisfies ArbIntrinsicOpenInput
              hb.openAttempts += 1
              const decided = decideIntrinsicOpen(intrinsicInput)
              if (decided.kind !== 'open') {
                noteSkip(decided.reason)
                continue
              }
              // on-hit refresh：同 code 同 right 仍在且边为正才落账（同款削前视）。
              const fresh = await input.getChain(underlying, month, { refresh: true }).catch(() => undefined)
              if (fresh === undefined) continue
              const still = scanIntrinsicDiscount(arbChainOf(fresh, spot), { feePerContract: fee })
                .find((item) => item.leg.code === discount.leg.code)
              if (still === undefined) continue
              const confirmed = decideIntrinsicOpen({ ...intrinsicInput, discount: still, chain: fresh })
              if (confirmed.kind !== 'open') {
                noteSkip(confirmed.reason)
                continue
              }
              state = applyOpen(state, {
                ...confirmed.fill,
                positionId: confirmed.positionId,
                expiryMonth: month,
                strikes: [still.strike],
              })
              hb.opens += 1
            }
          }
        }
      }

      await savePaperState(input.root, input.date, state, 'arbitrage')
      await writeHeartbeat()
    } catch (err) {
      // 套利纸账失败绝不阻断 cycle ticks；错误行照落心跳（可观测性优先）。
      try {
        await writeHeartbeat(err instanceof Error ? err.message : String(err))
      } catch {
        // 心跳写失败不放大。
      }
    }
  })
}
