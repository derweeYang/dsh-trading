/**
 * 可转债转股折价扫描（CN 专属，纯函数 + 只读工具 + 台账路径）。
 *
 * 恒等式：转股价值 = 100/转股价 × 正股价；折价（转股溢价率 < 0）时
 * 买转债 → 转股 → 次日卖股（T+1 隔夜正股风险）理论上收取敛差。
 * 数据源为东财 datacenter 快照（spikes/impl-akshare-cov 取证）：
 * 快照列可能滞后——本扫描**一律重算**，快照列偏差超容忍即判 stale 剔除
 * （防「陈旧净值」伪影，同 2026-09-17 last 价伪影教训）。
 * 已知限制：该端点无成交额/换手字段 → 无流动性闸，台账记录不构成执行依据。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CbQuoteRow, MarketDataService } from '@dshtrading/api'

/** 重算溢价率计入门槛（百分数）：折价深于此才列示；默认 -1（覆盖佣金+冲击的实务下限）。 */
export const CB_DISCOUNT_DEFAULT_THRESHOLD_PCT = -1
/** 转债价下限（元）：低于此接近债底/信用边缘，折价信号失真；默认 70。 */
export const CB_DISCOUNT_DEFAULT_MIN_PRICE = 70
/** 快照列 vs 重算的相对偏差容忍（百分数）；超差判 stale。默认 0.5。 */
export const CB_DISCOUNT_DEFAULT_STALE_TOLERANCE_PCT = 0.5
/** 双边佣金近似（百分数，买卖各半含余量）；净溢价 = 溢价 + 该成本。默认 0.05。 */
export const CB_DISCOUNT_DEFAULT_ROUND_TRIP_FEE_PCT = 0.05

export const CB_DISCOUNT_DISCLAIMER =
  '可转债折价扫描为量化信号与技术分析，不构成投资建议；转股后 T+1 方可卖股，隔夜正股波动是主要风险；本数据源无流动性字段，不作为执行依据。'

export interface CbDiscountOptions {
  /** 重算溢价率 ≤ 此值（百分数，负值）才计入；默认 -1。 */
  thresholdPct?: number
  /** 转债价下限（元）；默认 70。 */
  minPrice?: number
  /** 快照列偏差容忍（百分数）；默认 0.5。 */
  staleTolerancePct?: number
  /** 双边佣金近似（百分数）；默认 0.05。 */
  roundTripFeePct?: number
}

export interface CbDiscountRow {
  readonly bondCode: string
  readonly bondName: string
  readonly exchange: 'SH' | 'SZ'
  readonly stockCode: string
  /** 转债现价（元）。 */
  readonly price: number
  /** 转股价（元）。 */
  readonly conversionPrice: number
  /** 正股现价（元）。 */
  readonly stockPrice: number
  /** 重算转股价值（元）= 100/转股价 × 正股价。 */
  readonly conversionValue: number
  /** 重算溢价率（百分数，负值 = 折价）。 */
  readonly premiumPct: number
  /** 费后净溢价率（百分数）= 溢价率 + 双边佣金近似。 */
  readonly netPremiumPct: number
}

export interface CbDiscountScanResult {
  /** 输入行数（快照全量）。 */
  readonly scanned: number
  /** 三要素（价/转股价/正股价）齐全的行数。 */
  readonly priced: number
  /** 快照列与重算偏差超容忍被剔除的行数。 */
  readonly stale: number
  /** 溢价率最低值（百分数；priced=0 时 undefined）——无折价日也要看分布。 */
  readonly minPremiumPct?: number
  /** 命中门槛的折价行，按溢价率升序（最深在前）。 */
  readonly hits: readonly CbDiscountRow[]
  readonly disclaimer: string
}

export function scanCbDiscount(rows: readonly CbQuoteRow[], options: CbDiscountOptions = {}): CbDiscountScanResult {
  const thresholdPct = options.thresholdPct ?? CB_DISCOUNT_DEFAULT_THRESHOLD_PCT
  const minPrice = options.minPrice ?? CB_DISCOUNT_DEFAULT_MIN_PRICE
  const staleTolerancePct = options.staleTolerancePct ?? CB_DISCOUNT_DEFAULT_STALE_TOLERANCE_PCT
  const roundTripFeePct = options.roundTripFeePct ?? CB_DISCOUNT_DEFAULT_ROUND_TRIP_FEE_PCT

  let priced = 0
  let stale = 0
  let minPremiumPct: number | undefined
  const hits: CbDiscountRow[] = []
  for (const row of rows) {
    if (!(row.conversionPrice > 0) || !(row.stockPrice > 0) || !(row.price > 0)) continue
    const conversionValue = (100 / row.conversionPrice) * row.stockPrice
    if (!Number.isFinite(conversionValue) || conversionValue <= 0) continue
    priced += 1
    // 快照列防伪影：偏差超容忍 → stale 剔除（不进分布统计）。
    if (row.conversionValue !== undefined
      && Math.abs(row.conversionValue - conversionValue) / conversionValue * 100 > staleTolerancePct) {
      stale += 1
      continue
    }
    const premiumPct = (row.price - conversionValue) / conversionValue * 100
    if (minPremiumPct === undefined || premiumPct < minPremiumPct) minPremiumPct = premiumPct
    if (premiumPct > thresholdPct) continue
    if (row.price < minPrice) continue
    hits.push({
      bondCode: row.bondCode,
      bondName: row.bondName,
      exchange: row.exchange,
      stockCode: row.stockCode,
      price: row.price,
      conversionPrice: row.conversionPrice,
      stockPrice: row.stockPrice,
      conversionValue,
      premiumPct,
      netPremiumPct: premiumPct + roundTripFeePct,
    })
  }
  hits.sort((a, b) => a.premiumPct - b.premiumPct)
  return {
    scanned: rows.length,
    priced,
    stale,
    ...(minPremiumPct === undefined ? {} : { minPremiumPct }),
    hits,
    disclaimer: CB_DISCOUNT_DISCLAIMER,
  }
}

/* ── 周期节流（桥侧 30s tick 里判间隔与 regular 会话；台账行/路径/读取见 option-bar-ledger）── */

/** 周期节流（纯函数）。 */
export function shouldRunCbScan(nowMs: number, lastRunMs: number, session: string, intervalMs: number): boolean {
  return session === 'regular' && nowMs - lastRunMs >= intervalMs
}

/** 默认扫描间隔（ms）：快照为全市场单请求，5 分钟足够喂跟踪台账。 */
export const CB_SCAN_INTERVAL_MS = 300_000

/* ── 只读工具：cn_get_cb_discount_scan ── */

export interface CbDiscountToolOptions {
  /** CN 行情服务（registry-first 由调用方解析）。 */
  readonly getMarketData: () => MarketDataService | undefined
}

export function createGetCbDiscountScanTool(options: CbDiscountToolOptions) {
  return defineTool({
    name: 'cn_get_cb_discount_scan',
    description:
      '全市场可转债转股折价扫描：重算转股价值与溢价率（不信任快照列），列示折价深于阈值的存续转债（费后净溢价、T+1 风险提示）。只读量化信号，不构成投资建议。',
    parameters: {
      thresholdPct: {
        type: 'number',
        description: '溢价率计入门槛（百分数，负值），默认 -1',
      },
      minPrice: {
        type: 'number',
        description: '转债价下限（元），默认 70',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { thresholdPct?: unknown; minPrice?: unknown }
      const service = options.getMarketData()
      if (service?.getCovSnapshot === undefined) {
        return JSON.stringify({
          error: 'cb discount scan: active CN market data provider has no getCovSnapshot (install/enable @dshtrading/connector-akshare)',
        })
      }
      const rows = await service.getCovSnapshot()
      const scan = scanCbDiscount(rows, {
        ...(typeof args.thresholdPct === 'number' && Number.isFinite(args.thresholdPct)
          ? { thresholdPct: args.thresholdPct }
          : {}),
        ...(typeof args.minPrice === 'number' && Number.isFinite(args.minPrice) ? { minPrice: args.minPrice } : {}),
      })
      return JSON.stringify(scan)
    },
  })
}
