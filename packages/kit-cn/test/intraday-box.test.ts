import { describe, expect, it } from 'vitest'
import type { Kline } from '@dshtrading/api'
import {
  BOX_HORIZON_MIN,
  BOX_LOOKBACK,
  buildIntradayBox,
  expectedLatestBarOpenMs,
  selectBoxTargets,
  sessionFlag,
  twinUnderlyingOf,
} from '../src/intraday-box.ts'

/** 2026-09-08 周二。CST = UTC+8。 */
const CST_1030 = Date.parse('2026-09-08T02:30:00.000Z')
const CST_0932 = Date.parse('2026-09-08T01:32:00.000Z')
const CST_1128 = Date.parse('2026-09-08T03:28:00.000Z')
const CST_1302 = Date.parse('2026-09-08T05:02:00.000Z')
const CST_1457 = Date.parse('2026-09-08T06:57:00.000Z')
const CST_2000 = Date.parse('2026-09-08T12:00:00.000Z')
const CST_1120 = Date.parse('2026-09-08T03:20:00.000Z')
const CST_1145 = Date.parse('2026-09-08T03:45:00.000Z')
const CST_1530 = Date.parse('2026-09-08T07:30:00.000Z')
const CST_0920 = Date.parse('2026-09-08T01:20:00.000Z')
const CST_1310 = Date.parse('2026-09-08T05:10:00.000Z')
const SAT_1030 = Date.parse('2026-09-12T02:30:00.000Z')

function bars(opts: {
  count: number
  endMs: number
  close: (index: number) => number
  volume?: (index: number) => number
}): Kline[] {
  const volume = opts.volume ?? (() => 100)
  const out: Kline[] = []
  for (let index = 0; index < opts.count; index += 1) {
    const closeTime = opts.endMs - (opts.count - 1 - index) * 60_000
    const close = opts.close(index)
    const high = close + 0.002
    const low = close - 0.002
    out.push({
      openTime: closeTime - 60_000,
      open: close,
      high,
      low,
      close,
      volume: volume(index),
      closeTime,
    })
  }
  return out
}

function quietBars(endMs = CST_1030, count = BOX_LOOKBACK): Kline[] {
  return bars({
    count,
    endMs,
    close: () => 3,
  })
}

describe('sessionFlag', () => {
  it('连续竞价中段 regular；开盘 15 分 / 午休边 / 尾盘 5 分 / 盘后 closed', () => {
    expect(sessionFlag(CST_1030)).toBe('regular')
    expect(sessionFlag(CST_0932)).toBe('open15')
    expect(sessionFlag(CST_1128)).toBe('lunch')
    expect(sessionFlag(CST_1302)).toBe('lunch')
    expect(sessionFlag(CST_1457)).toBe('close5')
    expect(sessionFlag(CST_2000)).toBe('closed')
  })
})

describe('selectBoxTargets', () => {
  const roster = [
    { underlying: '510050', exchange: 'SSE' as const, name: '50', multiplier: 10000, tickSize: 0.0001, quotesSource: 'iquant_board' as const },
    { underlying: '159915', exchange: 'SZSE' as const, name: '创业', multiplier: 10000, tickSize: 0.0001, quotesSource: 'iquant_board' as const },
    { underlying: '910050', exchange: 'SYNTH' as const, name: 'synth', multiplier: 10000, tickSize: 0.0001, quotesSource: 'synth' as const },
  ]

  it('去掉 SYNTH；all/空 = 全表；510050.SH 命中一只', () => {
    expect(selectBoxTargets(roster).map((row) => row.underlying)).toEqual(['510050', '159915'])
    expect(selectBoxTargets(roster, 'all').map((row) => row.underlying)).toEqual(['510050', '159915'])
    expect(selectBoxTargets(roster, '510050.SH').map((row) => row.underlying)).toEqual(['510050'])
    expect(selectBoxTargets(roster, '600519.SH')).toEqual([])
  })
})

describe('twinUnderlyingOf', () => {
  it('同源双挂成对；单挂缺席', () => {
    // 2026-09-13 起 510300/510500 下架，300/500 双挂对随之移除
    expect(twinUnderlyingOf('588000')).toBe('588080')
    expect(twinUnderlyingOf('588080')).toBe('588000')
    expect(twinUnderlyingOf('510050')).toBeUndefined()
    expect(twinUnderlyingOf('159919')).toBeUndefined()
    expect(twinUnderlyingOf('510300')).toBeUndefined()
  })
})

describe('buildIntradayBox', () => {
  it('K 线不足 31 根 → no_trade，不编造箱体', () => {
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines: quietBars(CST_1030, 10),
      nowMs: CST_1030,
    })
    expect(row.regime).toBe('no_trade')
    expect(row.noTradeReason).toBe('insufficient')
    expect(row.candidates).toEqual([])
    expect(row.boxLow).toBeUndefined()
    expect(row.horizonMin).toBe(BOX_HORIZON_MIN)
  })

  it('开盘 15 分钟 → no_trade，即使 K 线充足', () => {
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines: quietBars(CST_0932),
      nowMs: CST_0932,
    })
    expect(row.regime).toBe('no_trade')
    expect(row.noTradeReason).toBe('open15')
    expect(row.candidates).toEqual([])
  })

  it('窄幅震荡 + 现价在 Donchian 中轨 → range_hold，候选 butterfly', () => {
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines: quietBars(),
      nowMs: CST_1030,
    })
    expect(row.regime).toBe('range_hold')
    expect(row.spotSymbol).toBe('510050.SH')
    expect(row.last).toBeDefined()
    expect(row.boxLow).toBeLessThan(row.last!)
    expect(row.boxHigh).toBeGreaterThan(row.last!)
    expect(row.boxHigh! - row.last!).toBeCloseTo(row.last! - row.boxLow!, 8)
    expect(row.candidates).toHaveLength(1)
    expect(row.candidates[0]?.template).toBe('butterfly')
    expect(row.candidates[0]?.invalidIf).toContain(row.boxLow!.toFixed(4))
    expect(row.candidates[0]?.invalidIf).toContain(row.boxHigh!.toFixed(4))
  })

  it('贴 Donchian 上沿且放量 → breakout，候选顺势 vertical', () => {
    const klines = bars({
      count: BOX_LOOKBACK,
      endMs: CST_1030,
      close: (index) => (index < 45 ? 3.0 : 3.0 + (index - 44) * 0.008),
      volume: (index) => (index < 55 ? 80 : 200),
    })
    const row = buildIntradayBox({
      underlying: '159915',
      name: '创业板ETF易方达',
      exchange: 'SZSE',
      klines,
      nowMs: CST_1030,
    })
    expect(row.spotSymbol).toBe('159915.SZ')
    expect(row.regime).toBe('breakout')
    expect(row.bias).toBe('up')
    expect(row.candidates[0]?.template).toBe('vertical')
    expect(row.candidates).toHaveLength(1)
  })

  it('贴 Donchian 上沿但不放量 → mean_revert', () => {
    const klines = bars({
      count: BOX_LOOKBACK,
      endMs: CST_1030,
      close: (index) => (index < 45 ? 3.0 : 3.0 + (index - 44) * 0.008),
      volume: () => 80,
    })
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines,
      nowMs: CST_1030,
    })
    expect(row.regime).toBe('mean_revert')
    expect(row.bias).toBe('down')
    expect(row.candidates[0]?.template).toBe('vertical')
  })

  it('近 5 根实现波动远高于 30 根 → vol_expand，候选含 straddle', () => {
    const klines = bars({
      count: BOX_LOOKBACK,
      endMs: CST_1030,
      close: (index) => {
        if (index < 55) return 3.0
        const swings = [3.04, 2.96, 3.06, 2.94, 3.07]
        return swings[index - 55] ?? 3.0
      },
    })
    const row = buildIntradayBox({
      underlying: '588000',
      name: '华夏科创50ETF',
      exchange: 'SSE',
      klines,
      nowMs: CST_1030,
    })
    expect(row.regime).toBe('vol_expand')
    expect(row.twinUnderlying).toBe('588080')
    expect(row.candidates.map((item) => item.template)).toContain('straddle')
    expect(row.candidates.length).toBeGreaterThan(0)
    expect(row.candidates.length).toBeLessThanOrEqual(2)
  })

  it('K 线拉取失败形状：空序列 → no_trade insufficient，不填 0', () => {
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines: [],
      nowMs: CST_1030,
    })
    expect(row.regime).toBe('no_trade')
    expect(row.last).toBeUndefined()
    expect(row.sigma1).toBeUndefined()
  })

  it('尾 bar 落后应有位置超过容差（厂商停更）→ no_trade stale_klines，不编箱体', () => {
    // 2026-09-11 事故形状：K 线窗停在 10:00，now 已 10:30
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines: quietBars(CST_1030 - 30 * 60_000),
      nowMs: CST_1030,
    })
    expect(row.regime).toBe('no_trade')
    expect(row.noTradeReason).toBe('stale_klines')
    expect(row.candidates).toEqual([])
    expect(row.boxLow).toBeUndefined()
    expect(row.last).toBeUndefined()
  })

  it('午后 regular 时尾 bar 停在上午（跨午休停更）→ no_trade stale_klines', () => {
    // 13:10 回源但 K 线窗停在 11:20：上午停更一直延续到下午，必须拦截
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines: quietBars(CST_1120),
      nowMs: CST_1310,
    })
    expect(row.regime).toBe('no_trade')
    expect(row.noTradeReason).toBe('stale_klines')
  })

  it('ticker 与尾 1m close 偏差超 0.5%（钉死的日 K 回退腿）→ 弃 ticker 用 close', () => {
    // 2026-09-11 事故形状：ticker last=3.017 钉死，真实尾 close 2.96
    const klines = bars({
      count: BOX_LOOKBACK,
      endMs: CST_1030,
      close: () => 2.96,
    })
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines,
      nowMs: CST_1030,
      last: 3.017,
    })
    expect(row.last).toBe(2.96)
    expect(row.regime).not.toBe('no_trade')
  })

  it('ticker 与尾 1m close 偏差在容差内 → 采纳 ticker', () => {
    const klines = bars({
      count: BOX_LOOKBACK,
      endMs: CST_1030,
      close: () => 2.96,
    })
    const row = buildIntradayBox({
      underlying: '510050',
      name: '华夏上证50ETF',
      exchange: 'SSE',
      klines,
      nowMs: CST_1030,
      last: 2.97,
    })
    expect(row.last).toBe(2.97)
  })
})

describe('expectedLatestBarOpenMs', () => {
  it('盘中=当前分钟；午休回指 11:30；收盘后回指 15:00；盘前/周末无法预期', () => {
    expect(expectedLatestBarOpenMs(CST_1030)).toBe(Date.parse('2026-09-08T02:30:00.000Z'))
    expect(expectedLatestBarOpenMs(CST_1145)).toBe(Date.parse('2026-09-08T03:30:00.000Z'))
    expect(expectedLatestBarOpenMs(CST_1530)).toBe(Date.parse('2026-09-08T07:00:00.000Z'))
    expect(expectedLatestBarOpenMs(CST_0920)).toBeNull()
    expect(expectedLatestBarOpenMs(SAT_1030)).toBeNull()
  })
})
