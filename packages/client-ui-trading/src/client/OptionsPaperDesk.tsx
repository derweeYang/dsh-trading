/**
 * 纸账户执行台（paper desk，2026-09-13）：近 N 日「候选 → 成交 → 打分」执行链路统计。
 *
 * **空数据不隐藏**：零成交、全 skipped、记录缺口（候选桶无 fill 行）都是有效诊断
 * 载荷——2026-09-10 的 7 条候选无记录、09-11 的 4 条全 no_quote 正是靠这三态划分
 * 才被审计出来。与 OptionsDetectedOpportunities 的「无数据即整节消失」语义相反。
 *
 * 页面不算口径：所有数字来自 `GET /options/paper/desk`（kit-cn loadPaperDesk 与
 * 盘后复盘 md 同源折叠）；本组件只做词表映射与渲染。本节是模拟盘诊断面，非投资建议。
 */
import type { OptionPaperDesk, PaperFill, PaperFillReason, PaperFillSkip } from '@dshtrading/api'
import type { MarketLocaleKey } from './contract.ts'
import { fmtClock, fmtPrice } from './format.ts'
import { VERDICT_KEY } from './option-vocabulary.ts'
import css from './options-paper-desk.module.css'

export type OptionsPaperDeskTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionsPaperDeskProps {
  t: OptionsPaperDeskTranslate
  /** 工作台快照；null = 未取到（原因见 failure）。取到后即使全 0 也照常渲染。 */
  desk: OptionPaperDesk | null
  failure: { code: string; message: string } | null
  /** 首个应答是否落地（区分「加载中」与「不可用」）。 */
  loaded: boolean
  /**
   * 页面级空态聚合（P2-8）：两条主数据源都没数据时由中栏薄壳统一出通知，本节
   * 不再自报加载/失败文案。**只静默 notice，永不静默已加载的内容**。
   */
  suppressNotice?: boolean | undefined
}

/** 推荐层 skipReason → 既有总览策略跳过词表；未知值回落原文（不炸渲染）。 */
const SKIP_REASON_KEY: Readonly<Record<string, MarketLocaleKey>> = {
  session: 'options.overview.strategy.skip.session',
  calibrated: 'options.overview.strategy.skip.calibrated',
  overlap: 'options.overview.strategy.skip.overlap',
  launch_failed: 'options.overview.strategy.skip.launch_failed',
}

/** 纸账层 PaperFillSkip 六值闭集 → 本节词表；未知值回落原文。 */
const PAPER_SKIP_KEY: Readonly<Record<PaperFillSkip, MarketLocaleKey>> = {
  duplicate_bucket: 'options.desk.paperskip.duplicate_bucket',
  no_quote: 'options.desk.paperskip.no_quote',
  no_forecast: 'options.desk.paperskip.no_forecast',
  no_cash: 'options.desk.paperskip.no_cash',
  bad_template: 'options.desk.paperskip.bad_template',
  one_fill: 'options.desk.paperskip.one_fill',
}

/** fill reason 词表；skipped 单独走 paper skip 词表（skip 字段才是原因）。 */
const FILL_REASON_KEY: Readonly<Record<Exclude<PaperFillReason, 'skipped'>, MarketLocaleKey>> = {
  signal: 'options.desk.fillreason.signal',
  invalidIf: 'options.desk.fillreason.invalidIf',
  close5: 'options.desk.fillreason.close5',
  session: 'options.desk.fillreason.session',
}

function mapLabel(t: OptionsPaperDeskTranslate, table: Readonly<Record<string, MarketLocaleKey>>, key: string): string {
  const localeKey = table[key]
  return localeKey === undefined ? key : t(localeKey)
}

/** Record 分布 → 「词×n」短语（键序已由桥侧排好）；空 → 占位破折号。 */
function describeCounts(
  t: OptionsPaperDeskTranslate,
  table: Readonly<Record<string, MarketLocaleKey>>,
  counts: Readonly<Record<string, number>>,
): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return '—'
  return entries.map(([key, count]) => `${mapLabel(t, table, key)}×${count}`).join(' ')
}

function fillResultLabel(t: OptionsPaperDeskTranslate, fill: PaperFill): string {
  if (fill.reason === 'skipped') {
    return fill.skip === undefined ? t('options.desk.fills.result') : mapLabel(t, PAPER_SKIP_KEY, fill.skip)
  }
  return mapLabel(t, FILL_REASON_KEY, fill.reason)
}

export function OptionsPaperDesk({ t, desk, failure, loaded, suppressNotice = false }: OptionsPaperDeskProps): React.JSX.Element {
  if (desk === null) {
    if (!loaded) {
      return suppressNotice ? <></> : <div className={css.notice}>{t('options.desk.loading')}</div>
    }
    return suppressNotice
      ? <></>
      : (
        <div className={css.notice}>
          <span>{t('options.desk.unavailable')}</span>
          {failure !== null && <span className={css.noticeDetail}>{failure.code}: {failure.message}</span>}
        </div>
      )
  }
  const { account, positions } = desk
  return (
    <section className={css.root} data-dshtrading-paper-desk="">
      <div className={css.head}>
        <span className={css.title}>{t('options.desk.title')}</span>
        <span className={css.hint}>{t('options.desk.hint')}</span>
      </div>
      <div className={css.accountStrip}>
        <span className={css.accountMetric}>
          <span className={css.metricLabel}>{t('options.desk.account.cash')}</span>
          <span className={css.metricValue}>{fmtPrice(account.cash)}</span>
        </span>
        <span className={css.accountMetric}>
          <span className={css.metricLabel}>{t('options.desk.account.initial')}</span>
          <span className={css.metricValue}>{fmtPrice(account.initialCash)}</span>
        </span>
        <span className={css.accountMetric}>
          <span className={css.metricLabel}>{t('options.desk.account.realized')}</span>
          <span className={css.metricValue}>{fmtPrice(account.realizedPnl)}</span>
        </span>
        <span className={css.accountMetric}>
          <span className={css.metricLabel}>{t('options.desk.account.equity')}</span>
          <span className={css.metricValue}>{fmtPrice(desk.equity)}</span>
        </span>
        <span className={css.accountMetric}>
          <span className={css.metricLabel}>{t('options.desk.account.positions')}</span>
          <span className={css.metricValue}>{positions.length}</span>
        </span>
        <span className={css.accountMetric}>
          <span className={css.metricLabel}>{t('options.desk.account.updated')}</span>
          <span className={css.metricValue}>{fmtClock(Date.parse(account.updatedAt))}</span>
        </span>
      </div>
      <table className={css.daysTable}>
        <thead>
          <tr>
            <th>{t('options.desk.col.date')}</th>
            <th>{t('options.desk.col.candidates')}</th>
            <th>{t('options.desk.col.filled')}</th>
            <th>{t('options.desk.col.gap')}</th>
            <th>{t('options.desk.col.skipReasons')}</th>
            <th>{t('options.desk.col.paperSkips')}</th>
            <th>{t('options.desk.col.verdicts')}</th>
          </tr>
        </thead>
        <tbody>
          {desk.days.map((day) => (
            <tr
              key={day.date}
              data-dshtrading-paper-desk-day={day.date}
              data-gap={day.gapBuckets}
              className={day.gapBuckets > 0 ? css.gapRow : undefined}
            >
              <td>{day.date}</td>
              <td>{day.candidates}</td>
              <td>{day.filled}</td>
              <td>{day.gapBuckets}</td>
              <td>{describeCounts(t, SKIP_REASON_KEY, day.skipReasons)}</td>
              <td>{describeCounts(t, PAPER_SKIP_KEY, day.paperSkips)}</td>
              <td title={`${t(VERDICT_KEY.hit)} ${day.verdicts.hit} / ${t(VERDICT_KEY.partial)} ${day.verdicts.partial} / ${t(VERDICT_KEY.miss)} ${day.verdicts.miss} / ${t(VERDICT_KEY.skipped)} ${day.verdicts.skipped}`}>
                {day.verdicts.hit}/{day.verdicts.partial}/{day.verdicts.miss}/{day.verdicts.skipped}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {desk.days.length === 0 && <div className={css.notice}>{t('options.desk.disclaimer')}</div>}
      <div className={css.fillsHead}>{t('options.desk.fills.title')}</div>
      {desk.recentFills.length === 0
        ? <div className={css.notice}>{t('options.desk.disclaimer')}</div>
        : (
          <table className={css.fillsTable}>
            <thead>
              <tr>
                <th>{t('options.desk.fills.time')}</th>
                <th>{t('options.desk.fills.underlying')}</th>
                <th>{t('options.desk.fills.template')}</th>
                <th>{t('options.desk.fills.result')}</th>
                <th>{t('options.desk.fills.premium')}</th>
                <th>{t('options.desk.fills.legs')}</th>
              </tr>
            </thead>
            <tbody>
              {desk.recentFills.map((fill) => (
                <tr key={fill.id}>
                  <td>{fmtClock(Date.parse(fill.asOf))}</td>
                  <td>{fill.underlying ?? '—'}</td>
                  <td>{fill.template ?? '—'}</td>
                  <td>{fillResultLabel(t, fill)}</td>
                  <td>{fmtPrice(fill.premiumCny)}</td>
                  <td>{fill.legs.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <div className={css.disclaimer}>{t('options.desk.disclaimer')}</div>
    </section>
  )
}
