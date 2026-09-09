import { describe, expect, it } from 'vitest'
import type { Kline, OptionIntradayBoxRow } from '@dshtrading/api'
import {
  OptionCycleBook,
  calibrateNextForecast,
  cycleId,
  realizedInWindow,
  scorePreviousCycle,
  shanghaiBucketStartMs,
} from '../src/option-cycles.ts'

const CST_1030 = Date.parse('2026-09-08T02:30:00.000Z')
const CST_1032 = Date.parse('2026-09-08T02:32:00.000Z')

function forecast(partial: Partial<OptionIntradayBoxRow> = {}): OptionIntradayBoxRow {
  return {
    underlying: '510050',
    name: '华夏上证50ETF',
    exchange: 'SSE',
    horizonMin: 5,
    last: 3,
    boxLow: 2.99,
    boxHigh: 3.01,
    halfWidth: 0.01,
    regime: 'range_hold',
    bias: 'neutral',
    session: 'regular',
    candidates: [],
    ...partial,
  }
}

function bar(closeTime: number, close: number, high = close + 0.001, low = close - 0.001): Kline {
  return { openTime: closeTime - 60_000, open: close, high, low, close, volume: 10, closeTime }
}

describe('shanghaiBucketStartMs', () => {
  it('10:32 CST 落到 10:30 桶；整点不前移', () => {
    expect(shanghaiBucketStartMs(CST_1032)).toBe(CST_1030)
    expect(shanghaiBucketStartMs(CST_1030)).toBe(CST_1030)
  })
})

describe('scorePreviousCycle', () => {
  it('range_hold 且收盘在箱内 → hit', () => {
    const realized = [
      bar(CST_1030 + 60_000, 3.0),
      bar(CST_1030 + 120_000, 3.002),
      bar(CST_1030 + 180_000, 2.999),
      bar(CST_1030 + 240_000, 3.001),
      bar(CST_1030 + 300_000, 3.0),
    ]
    const score = scorePreviousCycle({ forecast: forecast(), realized })
    expect(score.verdict).toBe('hit')
    expect(score.closeInside).toBe(true)
    expect(score.barCount).toBe(5)
  })

  it('收盘破箱 → miss', () => {
    const realized = [
      bar(CST_1030 + 60_000, 3.0),
      bar(CST_1030 + 120_000, 3.02, 3.03, 3.01),
      bar(CST_1030 + 180_000, 3.03, 3.04, 3.02),
    ]
    expect(scorePreviousCycle({ forecast: forecast(), realized }).verdict).toBe('miss')
  })

  it('no_trade 预报 → skipped，不打假分', () => {
    const score = scorePreviousCycle({
      forecast: forecast({ regime: 'no_trade', noTradeReason: 'open15', boxLow: undefined, boxHigh: undefined }),
      realized: [bar(CST_1030 + 60_000, 3)],
    })
    expect(score).toEqual({ verdict: 'skipped', barCount: 1, skipReason: 'no_trade' })
  })
})

describe('calibrateNextForecast', () => {
  it('连续 3 miss → suppressed', () => {
    const misses = [
      { verdict: 'miss' as const, barCount: 5, regimeHit: false },
      { verdict: 'miss' as const, barCount: 5, regimeHit: false },
      { verdict: 'miss' as const, barCount: 5, regimeHit: false },
    ]
    const next = calibrateNextForecast(forecast(), misses)
    expect(next.calibration).toBe('suppressed')
    expect(next.forecast.regime).toBe('no_trade')
    expect(next.forecast.noTradeReason).toBe('calibrated')
    expect(next.forecast.candidates).toEqual([])
  })
})

describe('OptionCycleBook', () => {
  it('同 id upsert；list 按标的截断', () => {
    const book = new OptionCycleBook()
    const first = book.upsert({
      id: cycleId('510050', CST_1030),
      underlying: '510050',
      bucketStart: new Date(CST_1030).toISOString(),
      asOf: new Date(CST_1030).toISOString(),
      forecast: forecast(),
      calibration: 'none',
    })
    book.upsert({ ...first, score: { verdict: 'hit', barCount: 5 } })
    expect(book.latest('510050')?.score?.verdict).toBe('hit')
    expect(book.list('510050')).toHaveLength(1)
  })
})

describe('realizedInWindow', () => {
  it('只收 (from, to] 的 closeTime', () => {
    const bars = [
      bar(CST_1030, 3),
      bar(CST_1030 + 60_000, 3.01),
      bar(CST_1030 + 300_000, 3.02),
      bar(CST_1030 + 360_000, 3.03),
    ]
    const window = realizedInWindow(bars, CST_1030, CST_1030 + 300_000)
    expect(window.map((item) => item.close)).toEqual([3.01, 3.02])
  })
})
