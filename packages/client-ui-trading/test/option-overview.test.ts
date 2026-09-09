import { describe, expect, it } from 'vitest'
import type { Kline, OptionOverviewRow } from '@dshtrading/api'
import {
  buildOverviewMetrics,
  composeScanAllPrompt,
  composeScanPrompt,
  extractIvPercentile,
  sortOverviewRows,
  spotSymbolOf,
} from '../src/option-overview.ts'

function bar(day: number, close: number, volume: number, open = close): Kline {
  const closeTime = Date.UTC(2026, 8, day, 7, 0, 0)
  return {
    openTime: closeTime - 86_400_000,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume,
    closeTime,
  }
}

describe('spotSymbolOf', () => {
  it('SSE → .SH，SZSE → .SZ，SYNTH 无现货', () => {
    expect(spotSymbolOf('510050', 'SSE')).toBe('510050.SH')
    expect(spotSymbolOf('159915', 'SZSE')).toBe('159915.SZ')
    expect(spotSymbolOf('910050', 'SYNTH')).toBeUndefined()
  })
})

describe('buildOverviewMetrics', () => {
  it('空序列 → 空 days，不编造分数', () => {
    expect(buildOverviewMetrics([])).toEqual({ days: [] })
  })

  it('5 日上涨 + 近 5 日均量低于 20 日 → 虚涨；放量格打标', () => {
    const klines: Kline[] = []
    for (let i = 1; i <= 15; i += 1) klines.push(bar(i, 2.0, 200))
    klines.push(bar(16, 2.02, 80))
    klines.push(bar(17, 2.04, 80))
    klines.push(bar(18, 2.06, 80))
    klines.push(bar(19, 2.08, 80))
    klines.push(bar(20, 2.20, 200))
    const metrics = buildOverviewMetrics(klines)
    expect(metrics.return5d).toBeGreaterThan(0)
    expect(metrics.volumeRatio).toBeLessThan(1)
    expect(metrics.divergence).toBe('weak_rally')
    expect(metrics.days).toHaveLength(5)
    expect(metrics.days[4]?.volumeSurge).toBe(true)
  })

  it('5 日下跌 + 近 5 日放量 → 加速', () => {
    const klines: Kline[] = []
    for (let i = 1; i <= 15; i += 1) klines.push(bar(i, 3.0, 50))
    klines.push(bar(16, 2.9, 120))
    klines.push(bar(17, 2.8, 120))
    klines.push(bar(18, 2.7, 120))
    klines.push(bar(19, 2.6, 120))
    klines.push(bar(20, 2.5, 120))
    const metrics = buildOverviewMetrics(klines)
    expect(metrics.return5d).toBeLessThan(0)
    expect(metrics.volumeRatio).toBeGreaterThan(1)
    expect(metrics.divergence).toBe('accelerating_sell')
  })
})

describe('extractIvPercentile', () => {
  it('优先 w252，其次对象里第一个有限数；非法形状缺席', () => {
    expect(extractIvPercentile({ iv_percentile: { w60: 0.4, w252: 0.62 } })).toBe(0.62)
    expect(extractIvPercentile({ iv_percentile: 0.5 })).toBe(0.5)
    expect(extractIvPercentile({ iv_percentile: { w60: 0.3 } })).toBe(0.3)
    expect(extractIvPercentile({})).toBeUndefined()
    expect(extractIvPercentile({ iv_percentile: 'nope' })).toBeUndefined()
  })
})

describe('sortOverviewRows', () => {
  const row = (id: string, extra: Partial<OptionOverviewRow>): OptionOverviewRow => ({
    underlying: id,
    name: id,
    exchange: 'SSE',
    days: [],
    scanPrompt: id,
    ...extra,
  })

  it('strength 缺席沉底；iv / holdings 各按键降序', () => {
    const rows = [
      row('a', { strengthScore: 1, ivPercentile: 0.2, heldQty: 0, optionQty: 2 }),
      row('b', { ivPercentile: 0.9, heldQty: 20000 }),
      row('c', { strengthScore: 3, heldQty: 10000, optionQty: 1 }),
    ]
    expect(sortOverviewRows(rows, 'strength').map((item) => item.underlying)).toEqual(['c', 'a', 'b'])
    expect(sortOverviewRows(rows, 'iv').map((item) => item.underlying)).toEqual(['b', 'a', 'c'])
    expect(sortOverviewRows(rows, 'holdings').map((item) => item.underlying)).toEqual(['b', 'c', 'a'])
  })
})

describe('composeScanPrompt', () => {
  it('含非投资建议与不下单纪律；scanAll 摘要前 9 行', () => {
    const text = composeScanPrompt({
      underlying: '510050',
      name: '华夏上证50ETF',
      last: 2.91,
      return5d: 1.2,
    })
    expect(text).toContain('510050')
    expect(text).toContain('not investment advice')
    expect(text).toContain('do not place live orders')
    expect(text).toContain('cn_get_option_intraday_box')
    expect(text).toContain('option-intraday-workflow')
    const all = composeScanAllPrompt([
      rowish('510050', 1),
      rowish('510300', -0.5),
    ])
    expect(all).toContain('510050 5d=1.0%')
    expect(all).toContain('not investment advice')
    expect(all).toContain('cn_get_option_intraday_box')
  })
})

function rowish(underlying: string, return5d: number): OptionOverviewRow {
  return {
    underlying,
    name: underlying,
    exchange: 'SSE',
    days: [],
    scanPrompt: '',
    return5d,
  }
}
