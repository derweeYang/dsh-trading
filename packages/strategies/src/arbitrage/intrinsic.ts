/**
 * 深度实值期权贴水扫描（Intrinsic Discount）。
 *
 * 欧式期权价格下界：C ≥ max(S₀·e^{-qT} − K·e^{-rT}, 0)，P ≥ max(K·e^{-rT} − S₀·e^{-qT}, 0)。
 * ETF 期权深度实值档因做市库存与流动性摩擦，常以低于下界的贴水价挂卖盘：
 *   discount = bound − ask > 0 → 买入实值腿替代现货/合成，赚贴水到期收敛（类套利，
 *   非瞬时无风险——贴水可持续甚至加深，故不并入 scanArbitrage，同 verticals 先例独立出口）。
 *
 * 只扫真实买卖盘（executable）行：无盘口 last 价回退在本结构上是伪影高发区
 * （2026-09-17 复盘实证），一律不产生信号。
 */
import type { ArbitrageChain, ArbitrageLeg, ArbitrageQuoteRow, OptionRight } from './types.ts'
import { yearsToExpiry, discountFactor } from './time.ts'
import { execPrices } from './prices.ts'

export interface IntrinsicOptions {
  /** 连续无风险利率（年化），默认 0.02 */
  rate?: number
  /** 连续股息率（年化），默认 0 */
  dividendYield?: number
  /** 费后净贴水门槛（元/份），低于此不计为机会，默认 0.005（= 50 元/张） */
  threshold?: number
  /** 单腿交易费（元/张），默认 0 */
  feePerContract?: number
  /** 合约乘数，默认 10000 */
  multiplier?: number
  /** 评估时点 YYYY-MM-DD，默认取 chain.asOf 或 now */
  asOf?: string
  /** 实值度下限：bound/spot 低于此值的近 ATM 行不计（噪声），默认 0.03 */
  minMoneyness?: number
}

export interface IntrinsicDiscount {
  readonly underlying: string
  readonly expiryMonth: string
  readonly strike: number
  readonly right: OptionRight
  /** 欧式下界（元/股） */
  readonly boundPerShare: number
  /** 买入对手价（元/股） */
  readonly askPerShare: number
  /** 贴水 = bound − ask（元/股，> 0） */
  readonly discountPerShare: number
  /** 费后净贴水（元/张）= discount × multiplier − fee */
  readonly netPerContract: number
  readonly leg: ArbitrageLeg
  readonly note: string
}

interface BoundContext {
  readonly spot: number
  readonly rate: number
  readonly q: number
  readonly T: number
}

/** 已解析的过滤闸门（元/份与张数口径）。 */
interface IntrinsicGates {
  readonly threshold: number
  readonly feePerContract: number
  readonly multiplier: number
  readonly minMoneyness: number
}

function boundOf(ctx: BoundContext, strike: number, right: OptionRight): number {
  const sDisc = ctx.spot * discountFactor(ctx.q, ctx.T) // S₀·e^{-qT}
  const kDisc = strike * discountFactor(ctx.rate, ctx.T) // K·e^{-rT}
  return right === 'C' ? Math.max(sDisc - kDisc, 0) : Math.max(kDisc - sDisc, 0)
}

function scanSide(
  chain: ArbitrageChain,
  ctx: BoundContext,
  rows: readonly ArbitrageQuoteRow[],
  right: OptionRight,
  options: IntrinsicGates,
): IntrinsicDiscount[] {
  const out: IntrinsicDiscount[] = []
  for (const row of rows) {
    const exec = execPrices(row)
    // 硬闸：无真实买一卖一不产生信号（last 回退在本结构上是伪影高发区）。
    if (!exec.executable) continue
    const bound = boundOf(ctx, row.strike, right)
    if (bound <= 0) continue
    if (bound / ctx.spot < options.minMoneyness) continue
    const discount = bound - exec.ask
    if (discount <= 0) continue
    // 价差闸：贴水必须宽过买卖价差，否则属盘口内噪声、进出即亏。
    if (exec.ask - exec.bid >= discount) continue
    const netPerContract = discount * options.multiplier - options.feePerContract
    if (netPerContract <= options.threshold * options.multiplier) continue
    out.push({
      underlying: chain.underlying,
      expiryMonth: chain.expiryMonth,
      strike: row.strike,
      right,
      boundPerShare: bound,
      askPerShare: exec.ask,
      discountPerShare: discount,
      netPerContract,
      leg: { code: row.code, right, action: 'buy', strike: row.strike },
      note: `深实值${right === 'C' ? '认购' : '认沽'} K=${row.strike} 贴水 ${discount.toFixed(4)} 元/股（bound ${bound.toFixed(4)} − ask ${exec.ask.toFixed(4)}）`,
    })
  }
  return out
}

/**
 * 扫描一条链的深实值贴水机会（仅 executable 行），按费后净贴水（元/张）降序。
 * 缺 spot / 缺到期 / 无盘口 → 空数组（不产生 last 价近似信号）。
 */
export function scanIntrinsicDiscount(chain: ArbitrageChain, options: IntrinsicOptions = {}): IntrinsicDiscount[] {
  const rate = options.rate ?? 0.02
  const q = options.dividendYield ?? 0
  const asOf = options.asOf ?? chain.asOf
  const T = yearsToExpiry(chain.expiryDate, asOf)
  if (chain.spot === undefined || T === undefined || chain.spot <= 0) return []

  const ctx: BoundContext = { spot: chain.spot, rate, q, T }
  const gates = {
    threshold: options.threshold ?? 0.005,
    feePerContract: options.feePerContract ?? 0,
    multiplier: options.multiplier ?? 10000,
    minMoneyness: options.minMoneyness ?? 0.03,
  }
  const calls = scanSide(chain, ctx, chain.calls, 'C', gates)
  const puts = scanSide(chain, ctx, chain.puts, 'P', gates)
  return [...calls, ...puts].sort((a, b) => b.netPerContract - a.netPerContract)
}

/**
 * 持仓监控用的同向签名边：当前再入场边 = bound − ask（与 scanIntrinsicDiscount 同口径同号；
 * 实际平仓腿价由执行层 takerFillPrice 对手价决定，同 parity 惯例）。
 * 腿缺行 / 无真实盘口 / 无 spot / 无到期 → undefined（调用方应 hold 等下轮）。
 */
export function intrinsicSignedEdge(
  chain: ArbitrageChain,
  strike: number,
  right: OptionRight,
  options: IntrinsicOptions = {},
): { edgePerShare: number; executable: boolean } | undefined {
  const rate = options.rate ?? 0.02
  const q = options.dividendYield ?? 0
  const asOf = options.asOf ?? chain.asOf
  const T = yearsToExpiry(chain.expiryDate, asOf)
  if (chain.spot === undefined || T === undefined) return undefined
  const rows = right === 'C' ? chain.calls : chain.puts
  const row = rows.find((item) => item.strike === strike)
  if (row === undefined) return undefined
  const exec = execPrices(row)
  if (!exec.executable) return undefined
  const bound = boundOf({ spot: chain.spot, rate, q, T }, strike, right)
  return { edgePerShare: bound - exec.ask, executable: true }
}
