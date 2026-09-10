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

  it('仅有 atmIv 不打 iv_missing，也不把年化 IV 当成分位高低', () => {
    const kinds = deriveRisks(row({ days: D5, atmIv: 0.21 })).map(r => r.kind)
    expect(kinds).not.toContain('iv_missing')
    expect(kinds).not.toContain('iv_high')
    expect(kinds).not.toContain('iv_low')
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
        logic: '箱体未破\n收时间价值',
      },
    }), t)
    expect(r.source).toBe('ai')
    expect(r.lines).toEqual(['箱体未破', '收时间价值'])
    expect(r.edge).toBe('theta rich')
  })

  it('logic 为空白串 → 视作缺席，回落规则解读', () => {
    const r = composeReading(row({
      days: D5,
      return5d: 2.49,
      volumeRatio: 0.8,
      strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b', logic: '   ' },
    }), t)
    expect(r.source).toBe('rule')
    expect(r.lines.join(' ')).toContain('options.insight.reading.volWeak')
  })

  it('价升量缩 → 规则解读给出背离提示（不是把它藏起来）', () => {
    const r = composeReading(row({ days: D5, return5d: 1.2, volumeRatio: 0.8, divergence: 'weak_rally' }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.weakRally')
  })

  /** WB-10：有宿主 ivRegime 就照词典陈述，绝不用 atmIv 反推高低。 */
  it('ivRegime=rich → 出制度词典，不掺 atmIv 高低推断', () => {
    const r = composeReading(row({ days: D5, atmIv: 0.22, ivRegime: 'rich' }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.ivRegime.rich')
    expect(r.lines.join(' ')).not.toContain('options.insight.reading.atmIv')
  })

  it('ivRegime=cheap → 出制度词典', () => {
    const r = composeReading(row({ days: D5, ivRegime: 'cheap' }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.ivRegime.cheap')
  })

  it('ivRegime=skew_put → 出制度词典（不开前端算法）', () => {
    const r = composeReading(row({ days: D5, atmIv: 0.3, ivRegime: 'skew_put' }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.ivRegime.skew_put')
  })

  /** 验收红线：只有 atmIv 的行 → 显示「制度不明」+ 年化 IV，不显示假分位 / 「偏低」。 */
  it('ivRegime=unknown + atmIv=0.22 → 显示「制度不明」+ 年化 IV，不出现「分位/偏低」', () => {
    const r = composeReading(row({ days: D5, atmIv: 0.22, ivRegime: 'unknown' }), t)
    const text = r.lines.join(' ')
    expect(text).toContain('options.insight.reading.atmIv')
    expect(text).not.toContain('分位')
    expect(text).not.toContain('偏低')
    expect(text).not.toContain('options.insight.reading.ivRegime.rich')
    expect(text).not.toContain('options.insight.reading.ivRegime.cheap')
  })

  it('ivRegime=unknown + 无 atmIv → 落 iv_missing（盲区），不猜值', () => {
    const r = composeReading(row({ days: D5, ivRegime: 'unknown' }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.ivMissing')
    expect(r.lines.join(' ')).not.toContain('分位')
  })

  it('strategy.ivRegime 优先于行上 ivRegime（契约回落方向）', () => {
    const r = composeReading(row({
      days: D5,
      ivRegime: 'unknown',
      strategy: { opportunity: 'theta_rent', edge: 'e', noTrade: false, bucketStart: 'b', ivRegime: 'rich' },
    }), t)
    expect(r.lines.join(' ')).toContain('options.insight.reading.ivRegime.rich')
  })
})

describe('composeReading — WB-11 观望解释', () => {
  it('no_edge + 制度 unknown → 多一句「为何观望」，信息级不是错误', () => {
    const r = composeReading(row({
      days: D5,
      atmIv: 0.22,
      ivRegime: 'unknown',
      strategy: { opportunity: 'no_edge', edge: 'e', noTrade: false, bucketStart: 'b' },
    }), t)
    const text = r.lines.join(' ')
    expect(text).toContain('options.insight.reading.noEdge')
    expect(text).toContain('options.insight.reading.ivUnknownBlocksTheta')
  })

  it('no_edge + 制度明确（cheap）→ 不补 unknown 句', () => {
    const r = composeReading(row({
      days: D5,
      ivRegime: 'cheap',
      strategy: { opportunity: 'no_edge', edge: 'e', noTrade: false, bucketStart: 'b' },
    }), t)
    expect(r.lines.join(' ')).not.toContain('options.insight.reading.ivUnknownBlocksTheta')
  })

  it('skipReason 优先：不补 IV 句，skip 才是真原因', () => {
    const r = composeReading(row({
      days: D5,
      ivRegime: 'unknown',
      strategy: { opportunity: 'no_edge', edge: 'e', noTrade: false, bucketStart: 'b', skipReason: 'overlap' },
    }), t)
    const text = r.lines.join(' ')
    expect(text).toContain('options.insight.reading.skipped')
    expect(text).not.toContain('options.insight.reading.ivUnknownBlocksTheta')
  })
})

describe('composePlan', () => {
  it('有 playbook → 原样分行展示，来源 ai', () => {
    const p = composePlan(row({
      days: D5,
      strategy: {
        opportunity: 'theta_rent', template: 'vertical', edge: 'e', noTrade: false, bucketStart: 'b',
        invalidIf: 'spot < 2.90',
        playbook: '卖 2900 购\n买 2950 购',
      },
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

describe('composePlan 的 playbook 缺席回落', () => {
  it('playbook 为空白串 → 视作缺席，走流程骨架且不含价位', () => {
    const p = composePlan(row({
      days: D5,
      strategy: { opportunity: 'theta_rent', template: 'vertical', edge: 'e', noTrade: false, bucketStart: 'b', playbook: '  ' },
    }), t)
    expect(p.source).toBe('rule')
    expect(p.steps.join(' ')).toContain('options.insight.plan.stepBox')
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
