/**
 * 检测到的期权机会（2026-09-13 WB-14）：把后端 `overview.opportunities` 只读展示出来。
 *
 * 数据来源与边界（前端只读，绝不现场算）：
 * - 后端（bridge/kit-cn，属 Cursor/Claude 泳道，task #11 尚未落地）把
 *   `data/options/recommendations/*.jsonl` 去重聚合进 `OptionOverview.opportunities`。
 * - 本组件定义的 `DetectedOpportunity` 视图模型与那份聚合快照一一对应；后端一发货，
 *   前端零改动即可渲染（`OptionsOverview` 只用 cast 把字段透传进来）。
 * - 中文文案（edgeZh/logicZh/playbookZh/invalidIfZh / pick.status / structure）都是
 *   运行时 JSON 数据，不是源码字面量，故不触发 i18n 审计的 CJK 扫描；唯一的源码中文
 *   走 `t(key)` 落在 locales.ts（字典文件豁免 CJK 扫描）。
 *
 * 渲染：一节标题 + 9 张机会卡（当前聚合结果），每张卡 = 卡头（标签/标的/检测桶/状态）
 * + 四段（钱在哪 / 可证伪假设 / 操作计划 / 失效条件）+ 已定价标的的腿表与风险指标。
 * 未定价标的只出状态徽章 + 一句「须经实时预填闸门」提示，不编造价位。
 */
import { useState } from 'react'
import type { MarketLocaleKey } from './contract.ts'
import css from './options-overview.module.css'

export type DetectedTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/* ── 视图模型（与后端 overview.opportunities 聚合快照对齐；后端落地前用 cast 透传）── */

export interface DetectedLeg {
  code: string
  side: 'sell' | 'buy' | string
  optionType: 'C' | 'P' | string
  strike: number
  last: number
  prevSettle: number
}

export interface DetectedPick {
  underlying: string
  regime: string
  regimeLabel: string
  template: string
  structure: string | null
  expiryMonth: string | null
  expiryDate: string | null
  maxContracts: number | null
  legs: DetectedLeg[]
  netCreditCnyPerSpread: number | null
  maxLossCnyPerSpread: number | null
  breakevenAtExpiry: number | null
  verification: string | null
  quoteSource: string | null
  status: string
}

export interface DetectedOpportunity {
  id: string
  date: string
  bucketStartUtc: string
  bucketStartCst: string
  session: string
  opportunity: string
  opportunityLabel: string
  noTrade: boolean
  underlyings: string[]
  picks: DetectedPick[]
  edge: string
  logic: string
  playbook: string
  invalidIf: string
  edgeZh: string
  logicZh: string
  playbookZh: string
  invalidIfZh: string
}

/** 在后端把字段加进 `@dshtrading/api` 的 `OptionOverview` 之前，用窄类型 cast 透传。 */
export interface OverviewDetectedShape {
  opportunities?: DetectedOpportunity[] | undefined
}

export interface OptionsDetectedOpportunitiesProps {
  t: DetectedTranslate
  /** 后端聚合快照；缺键时本组件整体不渲染（不整页空白）。 */
  opportunities: readonly DetectedOpportunity[] | undefined
}

/** 一段可证伪命题：标题 + 预格式化正文（保留源数据里的换行）。 */
function Block({ title, body }: { title: string; body: string }): React.JSX.Element {
  if (!body || body.trim() === '') return <></>
  return (
    <div className={css.section}>
      <span className={css.sectionTitle}>{title}</span>
      <p className={css.detectedProse}>{body}</p>
    </div>
  )
}

/** 单腿价表（已定价标的才有）。列名为英文交易术语（非 CJK，不触发 i18n 审计扫描）。 */
function LegsTable({ legs, t }: { legs: DetectedLeg[]; t: DetectedTranslate }): React.JSX.Element | null {
  if (legs.length === 0) return null
  return (
    <table className={css.detectedLegs}>
      <thead>
        <tr>
          <th>code</th>
          <th>side</th>
          <th>type</th>
          <th>strike</th>
          <th>last</th>
          <th>prevSettle</th>
        </tr>
      </thead>
      <tbody>
        {legs.map(leg => (
          <tr key={leg.code}>
            <td className={css.detectedCode}>{leg.code}</td>
            <td>{leg.side === 'sell' ? t('options.detected.sell') : t('options.detected.buy')}</td>
            <td>{leg.optionType}</td>
            <td className={css.detectedNum}>{leg.strike.toFixed(4)}</td>
            <td className={css.detectedNum}>{leg.last.toFixed(4)}</td>
            <td className={css.detectedNum}>{leg.prevSettle.toFixed(4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 风险指标行：净权利金 / 最大亏损 / 到期盈亏平衡（仅已定价且有值时出）。 */
function RiskMetrics({ pick, t }: { pick: DetectedPick; t: DetectedTranslate }): React.JSX.Element | null {
  if (pick.netCreditCnyPerSpread === null && pick.maxLossCnyPerSpread === null && pick.breakevenAtExpiry === null) {
    return null
  }
  return (
    <div className={css.metrics}>
      {pick.netCreditCnyPerSpread !== null && (
        <div className={css.metric}>
          <span className={css.metricLabel}>{t('options.detected.netCredit')}</span>
          <span className={css.metricValue}>{`¥${pick.netCreditCnyPerSpread}`}</span>
        </div>
      )}
      {pick.maxLossCnyPerSpread !== null && (
        <div className={css.metric}>
          <span className={css.metricLabel}>{t('options.detected.maxLoss')}</span>
          <span className={css.metricValue}>{`¥${pick.maxLossCnyPerSpread}`}</span>
        </div>
      )}
      {pick.breakevenAtExpiry !== null && (
        <div className={css.metric}>
          <span className={css.metricLabel}>{t('options.detected.breakeven')}</span>
          <span className={css.metricValue}>{pick.breakevenAtExpiry.toFixed(4)}</span>
        </div>
      )}
    </div>
  )
}

/** 单张机会卡。 */
function DetectedCard({
  o, t, expanded,
}: { o: DetectedOpportunity; t: DetectedTranslate; expanded: boolean }): React.JSX.Element {
  /** 已定价判定走数据（netCredit 非空即已定价），不写死 CJK 字面量（i18n 审计扫描源码字符串）。 */
  const pricedPick = o.picks.find(p => p.netCreditCnyPerSpread !== null)
  const priced = pricedPick !== undefined
  const statusText = pricedPick?.status ?? o.picks[0]?.status ?? ''
  return (
    <div className={css.detectedCard}>
      <div className={css.detectedCardHead}>
        <span className={css.detectedLabel}>{o.opportunityLabel}</span>
        {o.underlyings.map(u => (
          <span key={u} className={css.detectedBadge}>{u}</span>
        ))}
        <span className={css.detectedBucket}>
          {t('options.detected.bucket')} {o.bucketStartCst}
        </span>
        <span className={css.detectedStatus} data-tone={priced ? 'edge' : 'none'}>{statusText}</span>
      </div>

      {expanded && (
        <>
          <Block title={t('options.detected.edge')} body={o.edgeZh} />
          <Block title={t('options.detected.logic')} body={o.logicZh} />
          <Block title={t('options.detected.playbook')} body={o.playbookZh} />
          <Block title={t('options.detected.invalid')} body={o.invalidIfZh} />

          {o.picks.map((p, i) => (
            <div key={`${p.underlying}-${i}`} className={css.detectedPick}>
              <div className={css.detectedPickHead}>
                <span className={css.detectedCode}>{p.underlying}</span>
                {p.structure !== null && (
                  <span className={css.sourceBadge}>{`${t('options.detected.struct')} ${p.structure}`}</span>
                )}
                {p.expiryDate !== null && (
                  <span className={css.sourceBadge}>{p.expiryDate}</span>
                )}
              </div>
              {p.legs.length > 0
                ? (
                  <>
                    <span className={css.sectionTitle}>{t('options.detected.legs')}</span>
                    <LegsTable legs={p.legs} t={t} />
                    <RiskMetrics pick={p} t={t} />
                  </>
                )
                : <div className={css.blocker}>{t('options.detected.unpriced')}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

export function OptionsDetectedOpportunities({
  t, opportunities,
}: OptionsDetectedOpportunitiesProps): React.JSX.Element {
  const items = opportunities ?? []
  const [expanded, setExpanded] = useState(true)
  if (items.length === 0) return <></>

  return (
    <div className={css.detected}>
      <div className={css.detectedHead}>
        <span className={css.detectedTitle}>{t('options.detected.title')}</span>
        <span className={css.detectedHint}>{t('options.detected.hint')}</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.ghostBtn}
          aria-expanded={expanded}
          onClick={() => { setExpanded(!expanded) }}
        >
          {t(expanded ? 'options.detected.collapse' : 'options.detected.expandMore')}
        </button>
      </div>

      <div className={css.detectedCards}>
        {items.map(o => (
          <DetectedCard key={o.id} o={o} t={t} expanded={expanded} />
        ))}
      </div>

      <div className={css.detectedDisclaimer}>{t('options.detected.disclaimer')}</div>
    </div>
  )
}
