/**
 * @dshtrading/connector-options/arbitrage
 * 实时期权链 → 套利扫描组装：拉到的 OptionChain 经 strategies 纯函数内核
 * （fromOptionChain → scanArbitrage / scanVerticalSpreads）产出机会表。
 * 纯本地计算，不打网关新命令。不反向依赖 rest.ts（名册乘数由调用方注入，防模块循环）。
 */
import {
  OPTION_ARBITRAGE_DISCLAIMER,
  type OptionArbitrageScanQuery,
  type OptionArbitrageScanResult,
  type OptionChain,
  type OptionIntrinsicDiscount,
  type OptionQuoteRow,
  type OptionVerticalSpread,
} from '@dshtrading/api'
// 深导入套利子入口：纯函数零依赖（不引 indicators/cordis），避免把宿主
// cordis 的第二份 Context 类型拉进本包类型图（exactOptionalPropertyTypes 冲突）。
import {
  fromOptionChain,
  scanArbitrage,
  scanIntrinsicDiscount,
  scanVerticalSpreads,
} from '@dshtrading/strategies/arbitrage'

/** 调用方未注入名册乘数时的兜底（当前名册全部为 10000；仅作最后防线）。 */
export const FALLBACK_MULTIPLIER = 10000
export const DEFAULT_ARB_RATE = 0.02
export const DEFAULT_ARB_THRESHOLD_PER_SHARE = 0.005

function hasExecutableQuotes(row: OptionQuoteRow): boolean {
  return (
    typeof row.bid === 'number'
    && typeof row.ask === 'number'
    && Number.isFinite(row.bid)
    && Number.isFinite(row.ask)
    && row.ask >= row.bid
  )
}

function priceBasisOf(chain: OptionChain): OptionArbitrageScanResult['assumptions']['priceBasis'] {
  const rows = [...chain.calls, ...chain.puts]
  const executable = rows.filter(hasExecutableQuotes).length
  if (rows.length === 0 || executable === 0) return 'mid_last'
  return executable === rows.length ? 'bid_ask' : 'mixed'
}

export interface ScanOptions {
  /** 合约乘数（名册行；edgePerContract 换算依据，不写死在扫描层）。 */
  multiplier?: number
  /** 评估时点兜底（链无 snapshotAt 时用；缺省当前时刻）。 */
  nowIso?: () => string
}

/**
 * 对一条已拉取的链跑套利扫描（平价 + 箱型；垂直价差可选）。
 * query.spot 优先于链自带 spot（桥侧现价拼接）；asOf 用链快照时刻。
 */
export function scanOptionChainArbitrage(
  chain: OptionChain,
  query: OptionArbitrageScanQuery,
  options: ScanOptions = {},
): OptionArbitrageScanResult {
  const rate = query.rate ?? DEFAULT_ARB_RATE
  const thresholdPerShare = query.thresholdPerShare ?? DEFAULT_ARB_THRESHOLD_PER_SHARE
  const feePerContract = query.feePerContract ?? 0
  const multiplier = options.multiplier ?? FALLBACK_MULTIPLIER
  const spot = query.spot ?? chain.spot
  const asOf = chain.snapshotAt ?? options.nowIso?.() ?? new Date().toISOString()

  const base = fromOptionChain(chain)
  const arbChain = spot === undefined ? base : { ...base, spot }
  const opportunities = scanArbitrage(arbChain, {
    rate,
    threshold: thresholdPerShare,
    feePerContract,
    multiplier,
    asOf,
  })

  let verticals: readonly OptionVerticalSpread[] | undefined
  if (query.includeVerticals === true) verticals = scanVerticalSpreads(arbChain)

  // 深实值贴水（收敛型类套利）：仅真实盘口行，无 spot / 无到期自然为空。
  let intrinsic: readonly OptionIntrinsicDiscount[] | undefined
  if (query.includeIntrinsic === true) {
    intrinsic = scanIntrinsicDiscount(arbChain, {
      rate,
      threshold: thresholdPerShare,
      feePerContract,
      multiplier,
      asOf,
    })
  }

  return {
    underlying: chain.underlying,
    expiryMonth: chain.expiryMonth,
    ...(chain.expiryDate !== undefined ? { expiryDate: chain.expiryDate } : {}),
    ...(chain.snapshotAt !== undefined ? { snapshotAt: chain.snapshotAt } : {}),
    source: chain.source,
    ...(spot !== undefined ? { spot } : {}),
    multiplier,
    asOf,
    assumptions: { rate, thresholdPerShare, feePerContract, priceBasis: priceBasisOf(chain) },
    opportunities,
    ...(verticals !== undefined ? { verticals } : {}),
    ...(intrinsic !== undefined ? { intrinsic } : {}),
    disclaimer: OPTION_ARBITRAGE_DISCLAIMER,
  }
}
