/**
 * 期权总览「机会 / 风险 / 解读 / 计划」派生层（2026-09-09 WB-9）。
 *
 * 定位：**纯函数 + 零 I/O + 零重算**。只把桥已经给到的字段翻译成人能执行的东西：
 * - 不重算 strengthScore / IV 分位 / 箱体（箱体一律走 `cn_get_option_intraday_box`，
 *   本文件绝不现场推导箱沿）；
 * - 不替代 LLM：后端账本若给了 `logic` / `playbook` 就原文展示（标 AI 来源），
 *   缺席时回落到**规则解读**并显式标注来源，绝不把规则生成的文字伪装成 AI 结论。
 *
 * 只进 client 半（src/client/**）——不参与 node 半桥。
 *
 * 本文件是技术与行情分析面，不构成投资建议。
 */
import type { OptionOverviewRow } from '@dshtrading/api'

/**
 * 后端 `OptionBarRecommendation` 已有 `logic`（解读）与 `playbook`（操作计划），
 * 但 `overviewStrategyOf()` 投影成 `OptionOverviewStrategy` 时只留了 `edge`（见
 * kit-cn/src/option-bar-ledger.ts:358）。后端补齐投影前，前端用宽容类型**预读**：
 * 字段到位即显示，缺席即回落。后端补完契约后可删掉本类型改为直接读强类型字段。
 */
export interface StrategyExtras {
  readonly logic?: string
  readonly playbook?: string
}

/** 取策略的 logic / playbook（兼容后端尚未投影的情况）。 */
export function strategyExtras(row: OptionOverviewRow): StrategyExtras {
  const s = row.strategy
  if (s === undefined) return {}
  const raw = s as unknown as StrategyExtras
  const logic = typeof raw.logic === 'string' && raw.logic.trim() !== '' ? raw.logic : undefined
  const playbook = typeof raw.playbook === 'string' && raw.playbook.trim() !== '' ? raw.playbook : undefined
  if (logic !== undefined && playbook !== undefined) return { logic, playbook }
  if (logic !== undefined) return { logic }
  if (playbook !== undefined) return { playbook }
  return {}
}

/* ── 风险标签 ───────────────────────────────────────────────────────── */

export type RiskKind =
  /** 价升量缩：涨势未获量能确认。 */
  | 'weak_rally'
  /** 价跌量增：抛压在放大。 */
  | 'accelerating_sell'
  /** IV 分位偏高：权利仓贵、义务仓 gamma 风险大。 */
  | 'iv_high'
  /** IV 分位偏低：卖方性价比差，买方低成本但事件驱动弱。 */
  | 'iv_low'
  /** 未开 IV（includeIv 未开或网关未起）：IV 维度盲区。 */
  | 'iv_missing'
  /** 有期权持仓敞口。 */
  | 'exposure'
  /** 模板需要底仓但无底仓（covered_call / collar 不可执行）。 */
  | 'plan_unbacked'
  /** 有 edge 但没给失效条件：计划不完整。 */
  | 'no_invalid'
  /** 5 日序列不足：强度与背离判定样本不够。 */
  | 'data_gap'

export type RiskSeverity = 'warn' | 'info'

export interface RiskFlag {
  readonly kind: RiskKind
  readonly severity: RiskSeverity
}

/** IV 分位阈值（0–1；>1 视为已乘百，先归一）。 */
export const IV_HIGH = 0.8
export const IV_LOW = 0.2
/** 5 日序列少于该条数视为样本不足（窗口本就 5 日）。 */
export const MIN_DAYS = 3

/** 需要底仓支撑的模板：无底仓时计划不可执行。 */
const HOLDING_BACKED_TEMPLATES: readonly string[] = ['covered_call', 'collar', 'protective_put']

function normIv(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return value > 1 ? value / 100 : value
}

/**
 * 风险标签（按严重度降序，warn 在前）。
 * 只认后端已给的字段：缺 IV 就是「IV 盲区」而不是猜一个值。
 */
export function deriveRisks(row: OptionOverviewRow): RiskFlag[] {
  const flags: RiskFlag[] = []
  const push = (kind: RiskKind, severity: RiskSeverity): void => { flags.push({ kind, severity }) }

  if (row.divergence === 'weak_rally') push('weak_rally', 'warn')
  if (row.divergence === 'accelerating_sell') push('accelerating_sell', 'warn')

  const iv = normIv(row.ivPercentile)
  if (iv === undefined && row.atmIv === undefined) push('iv_missing', 'info')
  else if (iv !== undefined && iv >= IV_HIGH) push('iv_high', 'warn')
  else if (iv !== undefined && iv <= IV_LOW) push('iv_low', 'info')

  if ((row.optionQty ?? 0) > 0) push('exposure', 'info')

  const template = row.strategy?.template
  if (template !== undefined && HOLDING_BACKED_TEMPLATES.includes(template) && (row.heldQty ?? 0) <= 0) {
    push('plan_unbacked', 'warn')
  }

  const s = row.strategy
  if (s !== undefined && s.skipReason === undefined && !s.noTrade && s.opportunity !== 'no_edge'
      && (s.invalidIf === undefined || s.invalidIf.trim() === '')) {
    push('no_invalid', 'warn')
  }

  if ((row.days?.length ?? 0) < MIN_DAYS) push('data_gap', 'info')

  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1))
}

/* ── 强弱排序 ───────────────────────────────────────────────────────── */

export interface RankedRow {
  readonly row: OptionOverviewRow
  /** 0 = 最强。按 5 日累计（图上终点）降序，保证视觉顺序与名次一致。 */
  readonly rank: number
  /** 5 日累计涨跌幅（%），与叠加图终点同口径；days 空则 undefined。 */
  readonly cum5d: number | undefined
}

/** 5 日累计涨跌幅：days[].changePct 累乘（与叠加图同一算法）。 */
export function cumulativeReturn(days: readonly { readonly changePct?: number }[]): number | undefined {
  if (days.length === 0) return undefined
  let idx = 1
  for (const d of days) idx *= 1 + (d.changePct ?? 0) / 100
  return (idx - 1) * 100
}

/**
 * 按 5 日累计排序（缺数据沉底），返回带名次的行。
 * 用累计值而非 strengthScore 排序：图上「谁在上面」必须和「谁排第一」一致，
 * 否则视觉与名次互相打架（strengthScore 含量能因子，会与曲线终点错位）。
 */
export function rankByCumulative(rows: readonly OptionOverviewRow[]): RankedRow[] {
  return rows
    .map((row) => ({ row, cum5d: cumulativeReturn(row.days ?? []) }))
    .sort((a, b) => {
      if (a.cum5d === undefined && b.cum5d === undefined) return 0
      if (a.cum5d === undefined) return 1
      if (b.cum5d === undefined) return -1
      return b.cum5d - a.cum5d
    })
    .map((item, index) => ({ row: item.row, rank: index, cum5d: item.cum5d }))
}

/* ── 解读 ───────────────────────────────────────────────────────────── */

export type ReadingSource = 'ai' | 'rule'

export interface Reading {
  readonly source: ReadingSource
  /** 要点（AI 来源时通常是一段原文，也按行拆开）。 */
  readonly lines: readonly string[]
  /** 后端 edge 摘要（机会的量化理由）。 */
  readonly edge?: string
}

export type InsightTranslate = (key: string, params?: Record<string, unknown>) => string

function pct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function ratio(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

/**
 * 规则解读（无后端 logic 时的诚实兜底）。
 * 只陈述**已给到的事实 + 该事实的通用含义**，不推断箱体、不给目标价、不喊方向。
 */
export function composeRuleReading(row: OptionOverviewRow, t: InsightTranslate): string[] {
  const lines: string[] = []
  const cum = cumulativeReturn(row.days ?? [])
  const r5 = row.return5d
  const vr = row.volumeRatio

  if (r5 !== undefined || cum !== undefined) {
    lines.push(t('options.insight.reading.trend', { r5: pct(r5), cum: pct(cum) }))
  }
  if (vr !== undefined) {
    lines.push(t(vr >= 1.2
      ? 'options.insight.reading.volStrong'
      : vr >= 1
        ? 'options.insight.reading.volOk'
        : 'options.insight.reading.volWeak', { vr: ratio(vr) }))
  }
  if (row.divergence === 'weak_rally') lines.push(t('options.insight.reading.weakRally'))
  if (row.divergence === 'accelerating_sell') lines.push(t('options.insight.reading.accelSell'))

  const iv = normIv(row.ivPercentile)
  if (iv !== undefined) {
    if (iv >= IV_HIGH) lines.push(t('options.insight.reading.ivHigh', { iv: `${(iv * 100).toFixed(0)}%` }))
    else if (iv <= IV_LOW) lines.push(t('options.insight.reading.ivLow', { iv: `${(iv * 100).toFixed(0)}%` }))
    else lines.push(t('options.insight.reading.ivMid', { iv: `${(iv * 100).toFixed(0)}%` }))
  } else if (row.atmIv !== undefined && Number.isFinite(row.atmIv)) {
    lines.push(t('options.insight.reading.atmIv', { iv: `${(row.atmIv * 100).toFixed(1)}%` }))
  } else {
    lines.push(t('options.insight.reading.ivMissing'))
  }

  if ((row.heldQty ?? 0) > 0 || (row.optionQty ?? 0) > 0) {
    lines.push(t('options.insight.reading.position', {
      held: row.heldQty === undefined ? '0' : String(row.heldQty),
      opt: row.optionQty === undefined ? '0' : String(row.optionQty),
    }))
  }

  const s = row.strategy
  if (s !== undefined) {
    if (s.skipReason !== undefined) {
      lines.push(t('options.insight.reading.skipped', { reason: s.skipReason }))
    } else if (s.noTrade || s.opportunity === 'no_edge') {
      lines.push(t('options.insight.reading.noEdge'))
    } else {
      lines.push(t('options.insight.reading.hasEdge', { opportunity: s.opportunity }))
    }
  }

  if ((row.days?.length ?? 0) < MIN_DAYS) lines.push(t('options.insight.reading.dataGap'))
  return lines
}

/** 组装解读：优先后端 logic（标 ai），否则规则解读（标 rule）。 */
export function composeReading(row: OptionOverviewRow, t: InsightTranslate): Reading {
  const extras = strategyExtras(row)
  const edge = row.strategy?.edge
  if (extras.logic !== undefined) {
    const lines = extras.logic.split('\n').map(s => s.trim()).filter(s => s !== '')
    return edge === undefined ? { source: 'ai', lines } : { source: 'ai', lines, edge }
  }
  const lines = composeRuleReading(row, t)
  return edge === undefined ? { source: 'rule', lines } : { source: 'rule', lines, edge }
}

/* ── 操作计划 ───────────────────────────────────────────────────────── */

export interface Plan {
  /** 来源：后端 playbook（ai）／前端骨架（rule）。 */
  readonly source: ReadingSource
  /** 计划条目。 */
  readonly steps: readonly string[]
  /** 失效条件（后端 invalidIf）；没有就是 undefined——不编造止损位。 */
  readonly invalidIf?: string
  /** 计划不可执行的原因（如无底仓却要备兑）。 */
  readonly blocker?: string
}

/**
 * 操作计划：优先后端 playbook（原样分行展示，不改写）——前端**不生成价格目标**，
 * 骨架态只给「下一步该干什么」的流程步骤，价位一律留给 T 板与箱体工具。
 */
export function composePlan(row: OptionOverviewRow, t: InsightTranslate): Plan {
  const extras = strategyExtras(row)
  const s = row.strategy
  const invalidIf = s?.invalidIf !== undefined && s.invalidIf.trim() !== '' ? s.invalidIf : undefined
  const base: Plan = { source: 'rule', steps: [], ...(invalidIf === undefined ? {} : { invalidIf }) }

  if (extras.playbook !== undefined) {
    const steps = extras.playbook.split('\n').map(s => s.trim()).filter(s => s !== '')
    return { source: 'ai', steps, ...(invalidIf === undefined ? {} : { invalidIf }) }
  }

  const steps: string[] = []
  const template = s?.template
  if (template !== undefined && HOLDING_BACKED_TEMPLATES.includes(template) && (row.heldQty ?? 0) <= 0) {
    const blocker = t('options.insight.plan.blockerNoHolding', { template })
    steps.push(t('options.insight.plan.stepSwitchTemplate'))
    return { source: 'rule', steps, blocker, ...(invalidIf === undefined ? {} : { invalidIf }) }
  }

  if (s !== undefined && s.skipReason === undefined && !s.noTrade && s.opportunity !== 'no_edge') {
    steps.push(t('options.insight.plan.stepBox', { template: template ?? '—' }))
    steps.push(t('options.insight.plan.stepPreview'))
    steps.push(t('options.insight.plan.stepSize'))
    steps.push(t('options.insight.plan.stepInvalid'))
  } else {
    steps.push(t('options.insight.plan.stepWait'))
    steps.push(t('options.insight.plan.stepWatchIv'))
  }
  return { ...base, steps }
}

/* ── 机会卡排序 ─────────────────────────────────────────────────────── */

/** 机会分：有 edge > 有持仓 > 强度高。用于卡片排序（不生成任何交易信号）。 */
export function opportunityScore(row: OptionOverviewRow): number {
  const s = row.strategy
  let score = 0
  if (s !== undefined && s.skipReason === undefined && !s.noTrade && s.opportunity !== 'no_edge') score += 100
  if ((row.optionQty ?? 0) > 0) score += 30
  if ((row.heldQty ?? 0) > 0) score += 10
  score += Math.min(20, Math.abs(row.strengthScore ?? 0))
  return score
}

export function sortByOpportunity(rows: readonly OptionOverviewRow[]): OptionOverviewRow[] {
  return [...rows].sort((a, b) => opportunityScore(b) - opportunityScore(a))
}
