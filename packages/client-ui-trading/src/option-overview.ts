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

export const OVERVIEW_KLINE_LIMIT = 20
export const OVERVIEW_T5 = 5
export const VOLUME_SURGE_RATIO = 1.5

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

export function extractIvPercentile(report: KernelReport): number | undefined {
  const block = report.iv_percentile
  if (typeof block === 'number' && Number.isFinite(block)) return block
  if (block === null || typeof block !== 'object') return undefined
  const record = block as Record<string, unknown>
  const preferred = record.w252 ?? record.w60 ?? record['252']
  if (typeof preferred === 'number' && Number.isFinite(preferred)) return preferred
  for (const value of Object.values(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

export function sortOverviewRows(
  rows: readonly OptionOverviewRow[],
  sort: OptionOverviewSort,
): OptionOverviewRow[] {
  const copy = [...rows]
  const missingLast = (value: number | undefined): number =>
    value === undefined ? Number.NEGATIVE_INFINITY : value
  copy.sort((a, b) => {
    if (sort === 'iv') return missingLast(b.ivPercentile) - missingLast(a.ivPercentile)
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

export function applyTicker(metrics: ReturnType<typeof buildOverviewMetrics>, ticker?: Ticker): {
  last?: number
  changePct?: number
} {
  if (ticker === undefined) return {}
  return {
    last: ticker.price,
    ...(ticker.changePercent === undefined ? {} : { changePct: ticker.changePercent }),
  }
}
