/**
 * 期权总览聚合（C1/C2 桥侧纯函数）。行情与持仓由桥注入；本文件零 I/O。
 * 不进 client 半——只给 node 半 bridge 与单测用。
 */
import type {
  KernelReport,
  Kline,
  OptionOverviewDay,
  OptionOverviewRow,
  OptionOverviewSort,
  Ticker,
} from '@dshtrading/api'

export const HV20_WINDOW = 20
/** 日 K 根数：量能用近 20 根；HV20 需要 window+1 根收盘。 */
export const OVERVIEW_KLINE_LIMIT = HV20_WINDOW + 1
export const OVERVIEW_T5 = 5
export const VOLUME_SURGE_RATIO = 1.5

export function hv20FromKlines(klines: readonly Kline[]): number | undefined {
  if (klines.length < HV20_WINDOW + 1) return undefined
  const ordered = [...klines].sort((a, b) => a.closeTime - b.closeTime)
  const closes = ordered.map((bar) => bar.close)
  const logs: number[] = []
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]
    const next = closes[i]
    if (prev === undefined || next === undefined || prev <= 0 || next <= 0) return undefined
    logs.push(Math.log(next / prev))
  }
  const tail = logs.slice(-HV20_WINDOW)
  if (tail.length < HV20_WINDOW) return undefined
  const mean = tail.reduce((sum, item) => sum + item, 0) / tail.length
  const variance = tail.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (tail.length - 1)
  if (!Number.isFinite(variance) || variance < 0) return undefined
  return Math.sqrt(variance) * Math.sqrt(252)
}

export function spotSymbolOf(
  underlying: string,
  exchange: 'SSE' | 'SZSE' | 'SYNTH',
): string | undefined {
  if (exchange === 'SSE') return `${underlying}.SH`
  if (exchange === 'SZSE') return `${underlying}.SZ`
  return undefined
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, item) => sum + item, 0) / values.length
}

function utcDate(closeTime: number): string {
  return new Date(closeTime).toISOString().slice(0, 10)
}

export function buildOverviewMetrics(klines: readonly Kline[]): {
  return5d?: number
  volumeRatio?: number
  strengthScore?: number
  days: OptionOverviewDay[]
  divergence?: 'weak_rally' | 'accelerating_sell'
} {
  if (klines.length === 0) return { days: [] }
  const ordered = [...klines].sort((a, b) => a.closeTime - b.closeTime)
  const last5 = ordered.slice(-OVERVIEW_T5)
  const vols20 = ordered.slice(-OVERVIEW_KLINE_LIMIT).map((bar) => bar.volume)
  const vols5 = last5.map((bar) => bar.volume)
  const avg5 = mean(vols5)
  const avg20 = mean(vols20)
  const volumeRatio = avg5 !== undefined && avg20 !== undefined && avg20 > 0
    ? avg5 / avg20
    : undefined

  const days: OptionOverviewDay[] = last5.map((bar, index) => {
    const prev = last5[index - 1]
    const basis = prev !== undefined ? prev.close : bar.open
    const changePct = basis === 0 ? 0 : ((bar.close - basis) / basis) * 100
    return {
      date: utcDate(bar.closeTime),
      changePct,
      volumeSurge: avg5 !== undefined && avg5 > 0 && bar.volume / avg5 > VOLUME_SURGE_RATIO,
    }
  })

  const first = last5[0]
  const last = last5[last5.length - 1]
  const return5d = first !== undefined && last !== undefined && first.close !== 0
    ? ((last.close - first.close) / first.close) * 100
    : undefined
  const strengthScore = return5d !== undefined && volumeRatio !== undefined
    ? return5d * volumeRatio
    : undefined

  let divergence: 'weak_rally' | 'accelerating_sell' | undefined
  if (return5d !== undefined && volumeRatio !== undefined) {
    if (return5d > 0 && volumeRatio < 1) divergence = 'weak_rally'
    else if (return5d < 0 && volumeRatio > 1) divergence = 'accelerating_sell'
  }

  return {
    ...(return5d === undefined ? {} : { return5d }),
    ...(volumeRatio === undefined ? {} : { volumeRatio }),
    ...(strengthScore === undefined ? {} : { strengthScore }),
    days,
    ...(divergence === undefined ? {} : { divergence }),
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** vol_analytics 分位：0–1；若内核给 0–100 则归一。 */
function asUnitInterval(value: number): number {
  return value > 1 ? value / 100 : value
}

/**
 * 从 vol_analytics 报告取 ATM IV 分位。
 * 兼容：旧单测 `iv_percentile` 对象/标量；python 活牌 `ivPercentile` 行数组（status=ok）。
 */
export function extractIvPercentile(report: KernelReport): number | undefined {
  const rows = report.ivPercentile
  if (Array.isArray(rows)) {
    const ok = rows.filter((row): row is Record<string, unknown> =>
      row !== null && typeof row === 'object' && (row as { status?: unknown }).status === 'ok')
    const preferred = ok.find((row) => row.window === 252)
      ?? ok.find((row) => row.window === 60)
      ?? ok[0]
    const percentile = finiteNumber(preferred?.percentile)
    return percentile === undefined ? undefined : asUnitInterval(percentile)
  }
  const block = report.iv_percentile
  if (typeof block === 'number' && Number.isFinite(block)) return asUnitInterval(block)
  if (block === null || typeof block !== 'object') return undefined
  const record = block as Record<string, unknown>
  const preferred = record.w252 ?? record.w60 ?? record['252']
  if (typeof preferred === 'number' && Number.isFinite(preferred)) return asUnitInterval(preferred)
  for (const value of Object.values(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) return asUnitInterval(value)
  }
  return undefined
}

function legIv(row: Record<string, unknown>): number | undefined {
  if (row.converged === false) return undefined
  return finiteNumber(row.iv) ?? finiteNumber(row.impliedVol)
}

/**
 * 近月 ATM IV（年化 0–1）：优先 termStructure.status=ok 的 atmIv；
 * 否则在 implied_vol 的 results/rows 里取距现货最近一档已收敛 IV 的均值。
 */
export function extractAtmIv(report: unknown): number | undefined {
  if (report === null || typeof report !== 'object') return undefined
  const rec = report as Record<string, unknown>
  const term = rec.termStructure
  if (Array.isArray(term)) {
    for (const item of term) {
      if (item === null || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (row.status !== 'ok') continue
      const atm = finiteNumber(row.atmIv)
      if (atm !== undefined) return atm
    }
  }
  const legs = Array.isArray(rec.results) ? rec.results : Array.isArray(rec.rows) ? rec.rows : []
  const live: Array<{ strike: number; iv: number }> = []
  for (const item of legs) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const iv = legIv(row)
    const strike = finiteNumber(row.strike)
    if (iv === undefined || strike === undefined) continue
    live.push({ strike, iv })
  }
  if (live.length === 0) return undefined
  const spot = finiteNumber(rec.spot)
  const target = spot ?? live.reduce((sum, row) => sum + row.strike, 0) / live.length
  const atmStrike = live.reduce((best, row) =>
    Math.abs(row.strike - target) < Math.abs(best.strike - target) ? row : best).strike
  const atAtm = live.filter((row) => Math.abs(row.strike - atmStrike) < 1e-9).map((row) => row.iv)
  if (atAtm.length === 0) return undefined
  return atAtm.reduce((sum, iv) => sum + iv, 0) / atAtm.length
}

export function sortOverviewRows(
  rows: readonly OptionOverviewRow[],
  sort: OptionOverviewSort,
): OptionOverviewRow[] {
  const copy = [...rows]
  const missingLast = (value: number | undefined): number =>
    value === undefined ? Number.NEGATIVE_INFINITY : value
  copy.sort((a, b) => {
    if (sort === 'iv') {
      return missingLast(b.ivPercentile ?? b.atmIv) - missingLast(a.ivPercentile ?? a.atmIv)
    }
    if (sort === 'holdings') {
      const held = (b.heldQty ?? 0) - (a.heldQty ?? 0)
      if (held !== 0) return held
      return (b.optionQty ?? 0) - (a.optionQty ?? 0)
    }
    return missingLast(b.strengthScore) - missingLast(a.strengthScore)
  })
  return copy
}

export function composeScanPrompt(input: {
  underlying: string
  name: string
  last?: number
  changePct?: number
  return5d?: number
  volumeRatio?: number
  heldQty?: number
  optionQty?: number
  ivPercentile?: number
  atmIv?: number
  divergence?: 'weak_rally' | 'accelerating_sell'
}): string {
  const lines = [
    `Scan China ETF option underlying ${input.underlying} (${input.name}).`,
    input.last !== undefined ? `Spot ${input.last}${input.changePct !== undefined ? `, day ${input.changePct.toFixed(2)}%` : ''}.` : undefined,
    input.return5d !== undefined ? `5-day return ${input.return5d.toFixed(2)}%.` : undefined,
    input.volumeRatio !== undefined ? `5d/20d volume ratio ${input.volumeRatio.toFixed(2)}.` : undefined,
    input.heldQty !== undefined ? `ETF holding ${input.heldQty} shares.` : undefined,
    input.optionQty !== undefined ? `Option contracts ${input.optionQty}.` : undefined,
    input.ivPercentile !== undefined ? `IV percentile ${input.ivPercentile.toFixed(2)}.` : undefined,
    input.atmIv !== undefined ? `Near-month ATM IV ${input.atmIv.toFixed(3)}.` : undefined,
    input.divergence === 'weak_rally' ? 'Volume-price: rally on shrinking volume.' : undefined,
    input.divergence === 'accelerating_sell' ? 'Volume-price: decline on rising volume.' : undefined,
    'Call cn_get_option_intraday_box for the 5-minute box JSON; do not invent box levels.',
    'Then cn_get_option_chain / cn_get_option_iv / cn_get_option_vol_analytics / cn_get_option_strategy.',
    'Follow option-intraday-workflow. Technical analysis only; not investment advice. Prefill legs — do not place live orders.',
  ]
  return lines.filter((line): line is string => line !== undefined).join(' ')
}

export function composeScanAllPrompt(rows: readonly OptionOverviewRow[]): string {
  const summary = rows.slice(0, 9).map((row) => {
    const ret = row.return5d === undefined ? '?' : `${row.return5d.toFixed(1)}%`
    return `${row.underlying} 5d=${ret}`
  }).join('; ')
  return (
    `Scan these China ETF option underlyings for timing and structure: ${summary}. `
    + 'Rank by 5-day strength and volume confirmation. '
    + 'Call cn_get_option_intraday_box for the 5-minute box; do not invent levels. '
    + 'Then chain / IV / vol_analytics / strategy. Follow option-intraday-workflow. '
    + 'Technical analysis only; not investment advice. Prefill legs — do not place live orders.'
  )
}

export function applyTicker(_metrics: ReturnType<typeof buildOverviewMetrics>, ticker?: Ticker): {
  last?: number
  changePct?: number
} {
  if (ticker === undefined) return {}
  return {
    last: ticker.price,
    ...(ticker.changePercent === undefined ? {} : { changePct: ticker.changePercent }),
  }
}
