/**
 * 期权总览派生层单测（2026-09-09 WB-9）。
 *
 * 这里锁的是「不失真」而不是「不崩」：风险标签必须从真实字段推导（缺 IV 就是盲区，
 * 不许猜值），解读/计划的来源必须如实标注（AI vs 规则），排序必须与图上终点一致。
 */
import { describe, expect, it } from 'vitest'
import type { OptionOverviewRow } from '@dshtrading/api'
import {
  composePlan,
  composeReading,
  cumulativeReturn,
  deriveRisks,
  rankByCumulative,
  sortByOpportunity,
  strategyExtras,
} from '../src/client/option-insight.ts'

/** key 直出（断言用 key 而非文案）。 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}|${JSON.stringify(params)}`

function row(overrides: Partial<OptionOverviewRow> = {}): OptionOverviewRow {
  return {
    underlying: '510050',
    name: '上证50ETF',
    exchange: 'SSE',
    days: [],
    scanPrompt: 's',
    ...overrides,
  }
}

const D5 = [
  { date: 'd1', changePct: 1.0, volumeSurge: false },
  { date: 'd2', changePct: -0.5, volumeSurge: false },
  { date: 'd3', changePct: 2.0, volumeSurge: false },
]

describe('cumulativeReturn / rankByCumulative', () => {
  it('累乘口径：+10% 再 -10% = -1%（算术和会误报 0%）', () => {
    expect(cumulativeReturn([
      { date: 'd1', changePct: 10, volumeSurge: false },
      { date: 'd2', changePct: -10, volumeSurge: false },
    ])).toBeCloseTo(-1, 6)
  })

  it('累乘口径：1% → -0.5% → 2% ≈ 2.5049%', () => {
    expect(cumulativeReturn(D5)).toBeCloseTo(2.5049, 3)
  })

  it('空序列返回 undefined（不伪造 0）', () => {
    expect(cumulativeReturn([])).toBeUndefined()
  })

  it('按 5 日累计降序，缺数据沉底——保证图上顺序与名次一致', () => {
    const ranked = rankByCumulative([
      row({ underlying: 'a', name: 'A', days: D5 }),
      row({ underlying: 'b', name: 'B', days: [] }),
      row({ underlying: 'c', name: 'C', days: [{ date: 'd1', changePct: 3, volumeSurge: false }] }),
    ])
    expect(ranked.map(r => r.row.underlying)).toEqual(['c', 'a', 'b'])
    expect(ranked.map(r => r.rank)).toEqual([0, 1, 2])
    expect(ranked[2]?.cum5d).toBeUndefined()
  })
})

describe('deriveRisks', () => {
  it('缺 IV → iv_missing（盲区），不猜一个中性值', () => {
    const kinds = deriveRisks(row({ days: D5 })).map(r => r.kind)
    expect(kinds).toContain('iv_missing')
    expect(kinds).not.toContain('iv_high')
  })

  it('IV 0.9 → iv_high；0.1 → iv_low；0.5 → 都不打', () => {
    expect(deriveRisks(row({ days: D5, ivPercentile: 0.9 })).map(r => r.kind)).toContain('iv_high')
    expect(deriveRisks(row({ days: D5, ivPercentile: 0.1 })).map(r => r.kind)).toContain('iv_low')
    const mid = deriveRisks(row({ days: D5, ivPercentile: 0.5 })).map(r => r.kind)
    expect(mid).not.toContain('iv_high')
    expect(mid).not.toContain('iv_low')
  })

  it('IV 已乘百（90）也按 90% 判高位', () => {
    expect(deriveRisks(row({ days: D5, ivPercentile: 90 })).map(r => r.kind)).toContain('iv_high')
  })

  it('有 edge 却无失效条件 → no_invalid（warn）', () => {
    const risks = deriveRisks(row({
      days: D5,
      strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b' },
    }))
    expect(risks.map(r => r.kind)).toContain('no_invalid')
    expect(risks.find(r => r.kind === 'no_invalid')?.severity).toBe('warn')
  })

  it('no_edge / skip 不算「无失效条件」——本来就没计划', () => {
    const noEdge = deriveRisks(row({
      days: D5,
      strategy: { opportunity: 'no_edge', noTrade: true, edge: 'e', bucketStart: 'b' },
    }))
    expect(noEdge.map(r => r.kind)).not.toContain('no_invalid')
  })

  it('covered_call 无底仓 → plan_unbacked；有底仓则消失', () => {
    const s = { opportunity: 'covered_yield' as const, template: 'covered_call' as const, edge: 'e', noTrade: false, bucketStart: 'b' }
    expect(deriveRisks(row({ days: D5, strategy: s })).map(r => r.kind)).toContain('plan_unbacked')
    expect(deriveRisks(row({ days: D5, heldQty: 10000, strategy: s })).map(r => r.kind)).not.toContain('plan_unbacked')
  })

  it('days 不足 3 根 → data_gap', () => {
    expect(deriveRisks(row({ days: D5.slice(0, 2) })).map(r => r.kind)).toContain('data_gap')
    expect(deriveRisks(row({ days: D5 })).map(r => r.kind)).not.toContain('data_gap')
  })

  it('warn 排 info 前面（最该看的顶到前面）', () => {
    const risks = deriveRisks(row({
      days: D5.slice(0, 1),
      divergence: 'weak_rally',
      strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b' },
    }))
    const first = risks[0]
    expect(first?.severity).toBe('warn')
  })
})

describe('composeReading', () => {
  it('无 logic → 规则解读，来源标 rule', () => {
    const r = composeReading(row({ days: D5, return5d: 2.49, volumeRatio: 0.8 }), t)
    expect(r.source).toBe('rule')
    expect(r.lines.join(' ')).toContain('options.insight.reading.volWeak')
  })

  it('有 logic → 用后端原文，来源标 ai，并保留 edge', () => {
    const r = composeReading(row({
      days: D5,
      strategy: {
        opportunity: 'theta_rent', edge: 'theta rich', noTrade: false, bucketStart: 'b',
        ...({ logic: '箱体未破\n收时间价值' } as Record<string, unknown>),
      } as never,
    }), t)
    expect(r.source).toBe('ai')
    expect(r.lines).toEqual(['箱体未破', '收时间价值'])
    expect(r.edge).toBe('theta rich')
  })

  it('价升量缩 → 规则解读给出背离提示（不是把它藏起来）', () => {
    const r = composeReading(row({ days: D5, return5d: 1.2, volumeRatio: 0.8, divergence: 'weak_rally' }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.weakRally')
  })
})

describe('composePlan', () => {
  it('有 playbook → 原样分行展示，来源 ai', () => {
    const p = composePlan(row({
      days: D5,
      strategy: {
        opportunity: 'theta_rent', template: 'vertical', edge: 'e', noTrade: false, bucketStart: 'b',
        invalidIf: 'spot < 2.90',
        ...({ playbook: '卖 2900 购\n买 2950 购' } as Record<string, unknown>),
      } as never,
    }), t)
    expect(p.source).toBe('ai')
    expect(p.steps).toEqual(['卖 2900 购', '买 2950 购'])
    expect(p.invalidIf).toBe('spot < 2.90')
  })

  it('无 playbook + 有 edge → 流程骨架，且不含价位（价位留给箱体）', () => {
    const p = composePlan(row({
      days: D5,
      strategy: { opportunity: 'theta_rent', template: 'vertical', edge: 'e', noTrade: false, bucketStart: 'b' },
    }), t)
    expect(p.source).toBe('rule')
    expect(p.steps.join(' ')).toContain('options.insight.plan.stepBox')
    expect(p.steps.join(' ')).toContain('options.insight.plan.stepPreview')
    expect(p.invalidIf).toBeUndefined()
  })

  it('无 edge → 观望骨架，不硬编计划', () => {
    const p = composePlan(row({ days: D5 }), t)
    expect(p.steps.join(' ')).toContain('options.insight.plan.stepWait')
  })

  it('covered_call 无底仓 → blocker 阻断，明确写在计划里', () => {
    const p = composePlan(row({
      days: D5,
      strategy: { opportunity: 'covered_yield', template: 'covered_call', edge: 'e', noTrade: false, bucketStart: 'b' },
    }), t)
    expect(p.blocker).toContain('options.insight.plan.blockerNoHolding')
    expect(p.steps.join(' ')).toContain('options.insight.plan.stepSwitchTemplate')
  })
})

describe('strategyExtras', () => {
  it('未投影时返回空对象；空串视为缺席', () => {
    expect(strategyExtras(row())).toEqual({})
    expect(strategyExtras(row({
      strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b', ...({ logic: '   ' } as Record<string, unknown>) } as never,
    }))).toEqual({})
  })

  it('非字符串字段不误读', () => {
    expect(strategyExtras(row({
      strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b', ...({ logic: 42 } as Record<string, unknown>) } as never,
    }))).toEqual({})
  })
})

describe('sortByOpportunity', () => {
  it('有信号 > 有持仓 > 强度高，缺信号沉底', () => {
    const ordered = sortByOpportunity([
      row({ underlying: 'plain', name: 'plain', days: D5, strengthScore: 5 }),
      row({ underlying: 'edge', name: 'edge', days: D5, strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b' } }),
      row({ underlying: 'held', name: 'held', days: D5, optionQty: 3 }),
    ])
    expect(ordered.map(r => r.underlying)).toEqual(['edge', 'held', 'plain'])
  })
})
