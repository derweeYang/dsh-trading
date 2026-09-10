/**
 * 机会卡片区（2026-09-09 WB-9）：一标的一卡，**分析数据 / 解读 / 操作计划**三段齐全。
 *
 * 为什么要独立卡片而不是继续往表格里加列：表格一列只放得下一个值，而「机会」是
 * 一个**命题**——先有量化证据，再有解读，最后才落到动作。三段合一才可执行：
 * ① 分析数据（桥给的原始量化字段，不重算）；
 * ② 解读（后端账本 `logic` 优先，缺席时回落规则解读并显式标注来源，不伪装成 AI）；
 * ③ 操作计划（后端 `playbook` 优先，缺席时给流程骨架 + 失效条件；**不编造价位/目标价**）。
 *
 * 风险识别走 `deriveRisks`：把「价升量缩 / 价跌量增 / IV 极值 / 无底仓却要备兑 /
 * 无失效条件 / 样本不足」直接顶到卡头，避免只看到机会看不到代价。
 *
 * 出口只做两件事：进 T 板（看箱体与期权链）、问 AI（预填 composer，不下单）。
 * 本页为技术与行情分析面，不构成投资建议。
 */
import { useState } from 'react'
import type { OptionOverviewRow } from '@dshtrading/api'
import type { MarketLocaleKey } from './contract.ts'
import type { ColorMode } from './color-mode.ts'
import { directionColor, fmtCompact, fmtPercent, fmtPrice } from './format.ts'
import {
  composePlan,
  composeReading,
  deriveRisks,
  effectiveIvRegime,
  IV_HIGH,
  sortByOpportunity,
  type InsightTranslate,
} from './option-insight.ts'
import { IV_REGIME_KEY } from './option-vocabulary.ts'
import css from './options-overview.module.css'

export type OpportunityTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionsOpportunityBoardProps {
  t: OpportunityTranslate
  colorMode: ColorMode
  rows: readonly OptionOverviewRow[]
  /** 叠图给出的名次（underlying → rank），用于卡头显示「第 N 强」。 */
  ranks: ReadonlyMap<string, number>
  /** 进 T 板。 */
  onPickRow: (row: OptionOverviewRow) => void
  /** 问 AI：预填 composer（未注入 fillComposer 时不传 → 按钮不渲染）。 */
  onAskAi?: ((row: OptionOverviewRow) => void) | undefined
  /** 折叠阈值：超过该数只展示前 N 张，其余折叠。 */
  visibleLimit?: number
}

function ivText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const v = value > 1 ? value : value * 100
  return `${v.toFixed(0)}%`
}

/**
 * 年化 IV（0.22 → 22.0%）。与 `ivText` 分开：后者服务**分位**，
 * 这里服务**年化波动率**，两种量纲绝不能共用同一个数字格式与标签。
 */
function ivAnnual(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function num(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

/** 策略标签：skip → 跳过；no_edge → 观望；否则「模板 · 机会」。 */
function strategyLabel(row: OptionOverviewRow, t: OpportunityTranslate): { label: string; tone: 'edge' | 'none' | 'skip' } {
  const s = row.strategy
  if (s === undefined) return { label: t('options.overview.card.noSignal'), tone: 'none' }
  if (s.skipReason !== undefined) return { label: t(`options.overview.strategy.skip.${s.skipReason}`), tone: 'skip' }
  if (s.noTrade || s.opportunity === 'no_edge') return { label: t('options.overview.strategy.no_edge'), tone: 'none' }
  const opp = t(`options.overview.strategy.${s.opportunity}`)
  const template = s.template === undefined ? '' : t(`options.template.${s.template}`)
  return { label: template === '' ? opp : `${template} · ${opp}`, tone: 'edge' }
}

function Metric({ label, value, color, warn }: {
  label: string
  value: string
  color?: string | undefined
  warn?: boolean | undefined
}): React.JSX.Element {
  const style = color !== undefined
    ? { color }
    : warn === true ? { color: 'var(--dsw-futu-warning, #e6a23c)' } : undefined
  return (
    <span className={css.metric}>
      <span className={css.metricLabel}>{label}</span>
      <span className={css.metricValue} style={style}>{value}</span>
    </span>
  )
}

function Card({ row, rank, t, colorMode, onPickRow, onAskAi }: {
  row: OptionOverviewRow
  rank: number | undefined
  t: OpportunityTranslate
  colorMode: ColorMode
  onPickRow: (row: OptionOverviewRow) => void
  onAskAi: ((row: OptionOverviewRow) => void) | undefined
}): React.JSX.Element {
  const risks = deriveRisks(row)
  /** WB-10：宿主制度标签（strategy 投影优先，无 packet 回落行上）；缺席则不出这一项。 */
  const regime = effectiveIvRegime(row)
  // 契约适配：卡的 t 只认 MarketLocaleKey，解读层按 string key 取词。
  const it: InsightTranslate = (key, params) => t(key as MarketLocaleKey, params)
  const reading = composeReading(row, it)
  const plan = composePlan(row, it)
  const st = strategyLabel(row, t)
  const warnCount = risks.filter(r => r.severity === 'warn').length

  return (
    <div
      className={css.card}
      data-dshtrading-opportunity-card={row.underlying}
      /* WB-11：整卡可点进 T 板（围绕该标的的期权分析 + 交易策略），不再只能戳底部按钮 */
      onClick={() => { onPickRow(row) }}
      title={t('options.overview.pickHint')}
    >
      {/* 卡头：标的 / 名次 / 机会 / 风险 */}
      <div className={css.cardHead}>
        <span className={css.cardName}>{row.name}</span>
        <span className={css.cardCode}>{row.underlying}</span>
        {rank !== undefined && (
          <span className={css.cardRank} data-top={rank === 0 ? 'true' : undefined}>
            {t('options.overview.card.rank', { n: String(rank + 1) })}
          </span>
        )}
        <span className={css.spacer} />
        <span className={css.strategyTag} data-tone={st.tone}>{st.label}</span>
      </div>

      {risks.length > 0 && (
        <div className={css.riskRow}>
          {risks.map(r => (
            <span
              key={r.kind}
              className={css.riskTag}
              data-severity={r.severity}
              title={t(`options.insight.risk.${r.kind}` as MarketLocaleKey)}
            >
              {t(`options.insight.risk.${r.kind}` as MarketLocaleKey)}
            </span>
          ))}
          {warnCount > 0 && <span className={css.riskCount}>{t('options.overview.card.riskCount', { n: String(warnCount) })}</span>}
        </div>
      )}

      {/* ① 分析数据 */}
      <div className={css.section}>
        <span className={css.sectionTitle}>{t('options.overview.card.data')}</span>
        <div className={css.metrics}>
          <Metric label={t('options.overview.col.last')} value={fmtPrice(row.last)} />
          <Metric label={t('options.overview.col.change')} value={fmtPercent(row.changePct)} color={directionColor(row.changePct ?? 0, colorMode)} />
          <Metric label={t('options.overview.col.return5d')} value={fmtPercent(row.return5d)} color={directionColor(row.return5d ?? 0, colorMode)} />
          <Metric label={t('options.overview.col.volumeRatio')} value={num(row.volumeRatio)} />
          <Metric label={t('options.overview.col.strength')} value={num(row.strengthScore)} />
          {/* IV：有真分位才叫「IV 分位」；只有 atmIv 时改标年化「隐含波动率」，不再冒充分位 */}
          {row.ivPercentile !== undefined
            ? (
              <Metric
                label={t('options.overview.col.iv')}
                value={ivText(row.ivPercentile)}
                warn={(row.ivPercentile > 1 ? row.ivPercentile / 100 : row.ivPercentile) >= IV_HIGH}
              />
            )
            : <Metric label={t('options.iv')} value={ivAnnual(row.atmIv)} />}
          {regime !== undefined && (
            <Metric label={t('options.overview.col.ivRegime')} value={t(IV_REGIME_KEY[regime])} />
          )}
          <Metric label={t('options.overview.col.heldQty')} value={row.heldQty === undefined ? '—' : fmtCompact(row.heldQty)} />
          <Metric label={t('options.overview.col.optionQty')} value={row.optionQty === undefined ? '—' : String(row.optionQty)} />
        </div>
        <div className={css.t5}>
          {(row.days ?? []).slice(-5).map(day => (
            <span
              key={day.date}
              className={css.t5Box}
              data-surge={day.volumeSurge ? 'true' : undefined}
              style={{
                background: `color-mix(in srgb, ${day.changePct >= 0 ? 'var(--dsw-futu-up)' : 'var(--dsw-futu-down)'} ${Math.round(Math.min(85, 15 + (Math.min(Math.abs(day.changePct), 5) / 5) * 70))}%, transparent)`,
              }}
              title={`${day.date} ${fmtPercent(day.changePct)}${day.volumeSurge ? ` · ${t('options.overview.surge')}` : ''}`}
            >
              {fmtPercent(day.changePct)}
            </span>
          ))}
        </div>
      </div>

      {/* ② 解读：AI 来源 vs 规则来源，来源必须显式标注 */}
      <div className={css.section}>
        <span className={css.sectionTitle}>
          {t('options.overview.card.reading')}
          <span className={css.sourceBadge} data-source={reading.source}>
            {t(reading.source === 'ai' ? 'options.overview.card.sourceAi' : 'options.overview.card.sourceRule')}
          </span>
        </span>
        <ul className={css.lines}>
          {reading.lines.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
        {reading.edge !== undefined && (
          <span className={css.edge} title={reading.edge}>
            {t('options.overview.card.edge')} {reading.edge}
          </span>
        )}
        {reading.source === 'rule' && (
          <span className={css.fallbackHint}>{t('options.overview.card.logicMissing')}</span>
        )}
      </div>

      {/* ③ 操作计划 */}
      <div className={css.section}>
        <span className={css.sectionTitle}>
          {t('options.overview.card.plan')}
          <span className={css.sourceBadge} data-source={plan.source}>
            {t(plan.source === 'ai' ? 'options.overview.card.sourceAi' : 'options.overview.card.sourceRule')}
          </span>
        </span>
        {plan.blocker !== undefined && <div className={css.blocker}>{plan.blocker}</div>}
        <ol className={css.steps}>
          {plan.steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
        {plan.invalidIf === undefined
          ? <span className={css.invalidMissing}>{t('options.overview.card.invalidMissing')}</span>
          : <span className={css.invalid}>{t('options.overview.card.invalid')} {plan.invalidIf}</span>}
      </div>

      <div className={css.cardFoot}>
        {/* 两个按钮都 stopPropagation：动作与整卡点击同效，冒泡会双触发 */}
        <button
          type="button"
          className={css.scanRowBtn}
          onClick={(event) => { event.stopPropagation(); onPickRow(row) }}
        >
          {t('options.overview.card.openBoard')}
        </button>
        {onAskAi !== undefined && (
          <button
            type="button"
            className={css.ghostBtn}
            onClick={(event) => { event.stopPropagation(); onAskAi(row) }}
          >
            {t('options.overview.card.askAi')}
          </button>
        )}
      </div>
    </div>
  )
}

export function OptionsOpportunityBoard({
  t, colorMode, rows, ranks, onPickRow, onAskAi, visibleLimit = 3,
}: OptionsOpportunityBoardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const ordered = sortByOpportunity(rows)
  const shown = expanded ? ordered : ordered.slice(0, visibleLimit)
  const hidden = ordered.length - shown.length

  if (ordered.length === 0) return <div className={css.notice}>{t('options.overview.empty')}</div>

  return (
    <div className={css.board} data-dshtrading-opportunity-board="">
      <div className={css.boardHead}>
        <span className={css.overlayTitle}>{t('options.overview.boardTitle')}</span>
        <span className={css.overlayLegendHint}>{t('options.overview.boardHint')}</span>
      </div>
      <div className={css.cards}>
        {shown.map(row => (
          <Card
            key={row.underlying}
            row={row}
            rank={ranks.get(row.underlying)}
            t={t}
            colorMode={colorMode}
            onPickRow={onPickRow}
            onAskAi={onAskAi}
          />
        ))}
      </div>
      {hidden > 0 && (
        <button type="button" className={css.ghostBtn} onClick={() => { setExpanded(true) }}>
          {t('options.overview.card.expandMore', { n: String(hidden) })}
        </button>
      )}
      {expanded && ordered.length > visibleLimit && (
        <button type="button" className={css.ghostBtn} onClick={() => { setExpanded(false) }}>
          {t('options.overview.card.collapse')}
        </button>
      )}
    </div>
  )
}
