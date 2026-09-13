/**
 * 闭环卡片机会排序单测（2026-09-09 WB-10）。
 *
 * 锁的是「排序不失真」：
 * - 最强 / 最弱 / 中位必须来自真实累计涨跌幅排名，且**排在前面**；
 * - 数据缺席的标的不许抢档（不能因为排第一就冒充最强）；
 * - 同档顺序确定，30s 轮询不会让卡片乱跳。
 */
import { describe, expect, it } from 'vitest'
import type { OptionCycleLoopRow } from '@dshtrading/api'
import { cycleTierOf, rankCycleRows } from '../src/client/cycle-rank.ts'

/** 造一行闭环数据：默认「有箱 + 1 条候选」（= 本桶有机会）。 */
function makeRow(underlying: string, overrides: { box?: boolean; candidates?: number } = {}): OptionCycleLoopRow {
  const { box = true, candidates = 1 } = overrides
  return {
    underlying,
    stats: { n: 4, hits: 2, misses: 1, partials: 0, skipped: 1, hitRate: 0.5 },
    latest: {
      id: `${underlying}:1`,
      underlying,
      bucketStart: '2026-09-09T02:30:00.000Z',
      asOf: '2026-09-09T02:30:00.000Z',
      forecast: {
        underlying,
        name: underlying,
        exchange: 'SSE',
        horizonMin: 5,
        ...(box ? { boxLow: 2.9, boxHigh: 3.1 } : {}),
        regime: box ? 'range_hold' : 'no_trade',
        session: 'regular',
        candidates: Array.from({ length: candidates }, () => ({
          template: 'butterfly' as const, bias: 'neutral' as const, invalidIf: 'x', reason: 'y',
        })),
      },
      calibration: 'none',
    },
  }
}

const codes = (ranked: readonly { row: OptionCycleLoopRow }[]): string[] => ranked.map(r => r.row.underlying)

describe('cycleTierOf', () => {
  it('第 1 名最强、末位最弱、正中位中位，其余 rest', () => {
    // total = 9：0 最强，8 最弱，4 中位
    expect(cycleTierOf(0, 9)).toBe('strong')
    expect(cycleTierOf(8, 9)).toBe('weak')
    expect(cycleTierOf(4, 9)).toBe('median')
    expect(cycleTierOf(1, 9)).toBe('rest')
    expect(cycleTierOf(7, 9)).toBe('rest')
  })

  it('独一份标的只算最强，不能同时是最弱', () => {
    expect(cycleTierOf(0, 1)).toBe('strong')
  })

  it('两个标的：最强 + 最弱，无中位', () => {
    expect(cycleTierOf(0, 2)).toBe('strong')
    expect(cycleTierOf(1, 2)).toBe('weak')
  })

  it('越界 / 空集合一律 rest，不抛错', () => {
    expect(cycleTierOf(0, 0)).toBe('rest')
    expect(cycleTierOf(-1, 9)).toBe('rest')
    expect(cycleTierOf(9, 9)).toBe('rest')
  })
})

describe('rankCycleRows', () => {
  it('多标的：最强 → 最弱 → 中位排前三，其余按机会与原始顺序', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(code => makeRow(code))
    // 累计：i 最高（最强），a 最低（最弱），e 正中位
    const cum5d = { a: -3, b: -1, c: 2, d: 0.5, e: 1, f: 3, g: -0.5, h: 4, i: 6 }
    const ranked = rankCycleRows(rows, cum5d)
    expect(codes(ranked).slice(0, 3)).toEqual(['i', 'a', 'e'])
    expect(ranked[0].tier).toBe('strong')
    expect(ranked[1].tier).toBe('weak')
    expect(ranked[2].tier).toBe('median')
    expect(ranked[0].rank).toBe(0)
    expect(ranked[1].rank).toBe(8)
    expect(ranked[2].rank).toBe(4)
  })

  it('累计值缺席的标的不抢档：不进排名，也不冒充最强 / 最弱', () => {
    const rows = [makeRow('x'), makeRow('y'), makeRow('z'), makeRow('w')]
    // y 无数据 → y 落 rest；x 最强、w 最弱、z 中位（参与排名的只有 3 个：x,z,w）
    const cum5d = { x: 5, z: 1, w: -2 }
    const ranked = rankCycleRows(rows, cum5d)
    expect(codes(ranked)).toEqual(['x', 'w', 'z', 'y'])
    expect(ranked.find(r => r.row.underlying === 'y')?.tier).toBe('rest')
    expect(ranked.find(r => r.row.underlying === 'y')?.rank).toBeUndefined()
  })

  it('NaN 累计值同样不抢档', () => {
    const rows = [makeRow('p'), makeRow('q')]
    const ranked = rankCycleRows(rows, { p: Number.NaN, q: 1 })
    expect(codes(ranked)).toEqual(['q', 'p'])
    expect(ranked[0].tier).toBe('strong')
    expect(ranked[1].tier).toBe('rest')
  })

  it('全无累计值：不排序，保持桥给的原始顺序', () => {
    const rows = [makeRow('a'), makeRow('b'), makeRow('c')]
    expect(codes(rankCycleRows(rows))).toEqual(['a', 'b', 'c'])
    expect(codes(rankCycleRows(rows, {}))).toEqual(['a', 'b', 'c'])
  })

  it('rest 档内：本桶有机会（有箱 + 有候选）的排前面', () => {
    // 无 cum5d → 全落 rest；b 没箱没候选 → 沉到最后
    const rows = [makeRow('a'), makeRow('b', { box: false, candidates: 0 }), makeRow('c')]
    expect(codes(rankCycleRows(rows))).toEqual(['a', 'c', 'b'])
  })

  it('同档同机会：保持原始顺序（30s 轮询不抖动）', () => {
    const rows = [makeRow('a'), makeRow('b'), makeRow('c'), makeRow('d'), makeRow('e')]
    const cum5d = { a: 5, b: 4, c: 1, d: 0, e: -1 }
    const first = codes(rankCycleRows(rows, cum5d))
    const second = codes(rankCycleRows(rows, cum5d))
    expect(first).toEqual(second)
    // 中位（c）之后按原始顺序：b（涨 4）→ d（涨 0）
    expect(first.slice(3)).toEqual(['b', 'd'])
  })
})
