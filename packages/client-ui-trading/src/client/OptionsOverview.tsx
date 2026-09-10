/**
 * 九标的期权总览（2026-09-09 WB-1；WB-9 重构为「叠图 → 机会卡 → 明细表」三段）。
 *
 * 期权透镜的**落地页**——不再一进「期权」就画当前自选的 T 板。设计取舍：
 * - **只拉一条** `GET /options/overview`：桥已把现货/T-5/底仓/期权持仓聚合好；
 *   拼 tickers + klines + positions 是交接单明令禁止的（重复打上游 + 口径漂移）。
 * - **缺键按行容错**：桥侧「单行失败键缺席，不整页失败」，UI 跟着按单元格出「—」，
 *   不做整页空白，也不自己补算 strengthScore / IV 分位。
 * - **排序切 iv 才 includeIv=1**：九路 vol_analytics 会打爆网关，默认不打开。
 *
 * WB-9 三段式（回答「如何更容易捕捉机会、识别风险」）：
 * 1. **叠加走势图**：九条 5 日曲线共用一根 Y 轴——线的相对位置就是强弱序，
 *    最强/最弱/中位加粗，其余弱化；独立 sparkline 各自归一化，不可比，故被替代。
 * 2. **机会卡**：一标的一卡，分析数据 / 解读 / 操作计划三段齐全，风险标签顶到卡头。
 * 3. **明细表**：保留原始 12 列（WB-1 验收基线），默认展开、可折叠。
 *
 * 本页是技术与行情分析面，不构成投资建议；扫描按钮只预填聊天框，不下单。
 */
import { useState } from 'react'
import type {
  OptionOverview,
  OptionOverviewDay,
  OptionOverviewRow,
  OptionOverviewSort,
  OptionOverviewStrategy,
} from '@dshtrading/api'
import type { ColorMode } from './color-mode.ts'
import type { MarketLocaleKey } from './contract.ts'
import { directionColor, fmtCompact, fmtPercent, fmtPrice } from './format.ts'
import { Sparkline } from './Sparkline.tsx'
import { OverlayTrendChart } from './OverlayTrendChart.tsx'
import { OptionsOpportunityBoard } from './OptionsOpportunityBoard.tsx'
import { rankByCumulative, effectiveIvRegime } from './option-insight.ts'
import { IV_REGIME_KEY } from './option-vocabulary.ts'
import css from './options-overview.module.css'

export type OptionsOverviewTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionsOverviewProps {
  t: OptionsOverviewTranslate
  colorMode: ColorMode
  /** 总览快照；null = 未取到（原因见 failure）。 */
  overview: OptionOverview | null
  /** 取数失败；null = 无错误（NOT_IMPLEMENTED 由外层隐藏透镜，本组件不接该分支）。 */
  failure: { code: string; message: string } | null
  /** 首个应答是否落地（区分「加载中」与「不可用」）。 */
  loaded: boolean
  sort: OptionOverviewSort
  onSortChange: (sort: OptionOverviewSort) => void
  /** 排序应答在途（WB-11）：根节点降透明度，点击 IV 分位即刻有反馈。 */
  sorting?: boolean | undefined
  /** 点行进 T 板（外层解析 resolve → 切标的 → 切 pane）。 */
  onPickRow: (row: OptionOverviewRow) => void
  /** 总览「扫描标的」→ 预填 composer（未注入 fillComposer 时不传）。 */
  onScanAll?: (() => void) | undefined
  /** 行内「AI 扫描」→ 预填该标的 scanPrompt（未注入时不传）。 */
  onScanRow?: ((row: OptionOverviewRow) => void) | undefined
}

/** 排序控件三项（iv 会打开网关，标签上不必提示——提示在 hint 里）。 */
const SORT_KEYS: readonly { sort: OptionOverviewSort; key: MarketLocaleKey }[] = [
  { sort: 'strength', key: 'options.overview.sort.strength' },
  { sort: 'iv', key: 'options.overview.sort.iv' },
  { sort: 'holdings', key: 'options.overview.sort.holdings' },
]

/**
 * T-5 一格：色深按 |changePct|（0.15→0.85），放量（volumeSurge）加边框。
 * 用 color-mix 而不是写死 rgba——暗色主题下涨跌 token 会变，写死会漂。
 */
function dayCell(pct: number | undefined) {
  const label = pct === undefined ? '—' : fmtPercent(pct)
  if (pct === undefined || !Number.isFinite(pct)) {
    return { label, style: undefined, tone: 'flat' as const }
  }
  const tone = pct > 0 ? ('up' as const) : pct < 0 ? ('down' as const) : ('flat' as const)
  const alpha = Math.min(85, 15 + (Math.min(Math.abs(pct), 5) / 5) * 70)
  const token = tone === 'up' ? 'var(--dsw-futu-up)' : tone === 'down' ? 'var(--dsw-futu-down)' : 'var(--dsw-futu-flat)'
  return {
    label,
    tone,
    style: { background: `color-mix(in srgb, ${token} ${Math.round(alpha)}%, transparent)` },
  }
}

/** IV 分位（0–1）→ 百分比；>1 视为已乘百，不再放大。 */
function fmtIvPercentile(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${(value > 1 ? value : value * 100).toFixed(0)}%`
}

/**
 * 年化 IV（0–1）→ 百分比，保留一位。
 *
 * 为什么与分位分开格式化：`atmIv` 是**年化波动率**（0.22 = 22%），不是 22 分位。
 * 两值在旧代码里共用 `fmtIvPercentile` 挤在「IV 分位」列下，0.22 会被读成
 * 「22 分位」——这正是交接单要消灭的假分位（2026-09-10 WB-10）。
 */
function fmtIvAnnual(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 总览「推荐策略」列（WB-7）：只读展示后端 `row.strategy` 投影，前端绝不现场
 * 算箱体或调 `cn_get_option_strategy`。渲染优先级：
 *  1. skipReason 有值 → 跳过标签（盘中常见 overlap / launch_failed）；
 *  2. noTrade 或 opportunity=no_edge → 观望标签；
 *  3. 否则 `模板 · 机会`，tooltip 用后端给的 edge 原文。
 * 无 strategy 键 → 返回 null（调用方出「—」），不整列空白。
 */
function renderStrategy(
  row: OptionOverviewRow,
  s: OptionOverviewStrategy,
  t: OptionsOverviewTranslate,
): { label: string; title?: string; tone: 'edge' | 'none' | 'skip' } {
  if (s.skipReason !== undefined) {
    return { label: t(`options.overview.strategy.skip.${s.skipReason}`), tone: 'skip' }
  }
  if (s.noTrade || s.opportunity === 'no_edge') {
    /*
     * WB-11：观望时补一句「为何观望」。制度不明 → 定时桶不会落「收时间价值」。
     * 挂在 tooltip（信息级），不染成错误红条——unknown 是活牌的正确状态，不是故障。
     * 有 skipReason 时上面已返回，跳过词典不会被这句盖住。
     */
    const why = row.ivRegime === 'unknown' || s.ivRegime === 'unknown'
      ? t('options.insight.reading.ivUnknownBlocksTheta')
      : undefined
    return { label: t('options.overview.strategy.no_edge'), tone: 'none', ...(why === undefined ? {} : { title: why }) }
  }
  const opp = t(`options.overview.strategy.${s.opportunity}`)
  const template = s.template !== undefined ? t(`options.template.${s.template}`) : ''
  return {
    label: template ? `${template} · ${opp}` : opp,
    title: s.edge,
    tone: 'edge',
  }
}

/**
 * 走势列 / 排行条共用的 5 日指数序列：从 days[].changePct 累乘成归一化指数
 * （起点 1.0）。纯客户端可视化派生，不重算后端 strengthScore / 箱体。
 */
function trendValues(days: readonly OptionOverviewDay[]): number[] {
  let idx = 1
  const out: number[] = []
  for (const d of days) {
    idx *= 1 + (d.changePct ?? 0) / 100
    out.push(idx)
  }
  return out
}

export function OptionsOverview({
  t, colorMode, overview, failure, loaded, sort, onSortChange, onPickRow, onScanAll, onScanRow, sorting,
}: OptionsOverviewProps): React.JSX.Element {
  const rows = overview?.rows ?? []
  /** 明细表默认展开（WB-1 验收基线：9 行 / T-5 / 排序），可折叠让位给机会卡。 */
  const [showTable, setShowTable] = useState(true)
  const ranks = new Map(rankByCumulative(rows).map(item => [item.row.underlying, item.rank]))
  /** 排序切 iv 后九路 vol_analytics 仍可能全缺席 → 如实提示，不让「没反应」背锅。 */
  const ivMissing = sort === 'iv' && rows.length > 0
    && rows.every(row => row.ivPercentile === undefined && row.atmIv === undefined)

  return (
    <div className={css.root} data-dshtrading-options-overview="" data-sorting={sorting === true ? 'true' : undefined}>
      {/* 顶栏：排序 + 全表扫描 + 快照口径 */}
      <div className={css.bar}>
        <span className={css.title}>{t('options.overview.title')}</span>
        <div className={css.sortGroup} role="tablist" aria-label="overview sort">
          {SORT_KEYS.map(item => (
            <button
              key={item.sort}
              type="button"
              role="tab"
              aria-selected={sort === item.sort}
              className={css.sortPill}
              data-active={sort === item.sort ? 'true' : undefined}
              onClick={() => { onSortChange(item.sort) }}
            >
              {t(item.key)}
            </button>
          ))}
        </div>
        {sorting === true && <span className={css.sortingHint}>{t('options.overview.loading')}</span>}
        <span className={css.spacer} />
        {overview !== null && (
          <span className={css.asOf}>
            {t('options.overview.asOf')} {fmtCompact(rows.length)} · {String(overview.source)}
          </span>
        )}
        {onScanAll !== undefined && (
          <button
            type="button"
            className={css.scanAllBtn}
            onClick={onScanAll}
          >
            {t('options.overview.scanAll')}
          </button>
        )}
      </div>

      {/* 分诊：失败 → 加载中 → 不可用 → 空表 → 表格（不整页空白） */}
      {failure !== null
        ? <div className={css.notice}>{failure.code}: {failure.message}</div>
        : !loaded
          ? <div className={css.notice}>{t('options.overview.loading')}</div>
          : overview === null
            ? <div className={css.notice}>{t('options.overview.unavailable')}</div>
              : rows.length === 0
                ? <div className={css.notice}>{t('options.overview.empty')}</div>
                : (
                  <>
                    {/* IV 分位整体缺席（WB-11）：如实提示，不伪装成「点了没反应」 */}
                    {ivMissing && <div className={css.notice}>{t('options.overview.ivMissing')}</div>}
                    {/* ① 九标的 5 日叠加走势：共用 Y 轴，线的相对位置即强弱序 */}
                    <OverlayTrendChart
                      t={t}
                      colorMode={colorMode}
                      rows={rows}
                      onPickRow={onPickRow}
                    />
                    {/* ② 机会卡：分析数据 + 解读 + 操作计划 + 风险标签 */}
                    <OptionsOpportunityBoard
                      t={t}
                      colorMode={colorMode}
                      rows={rows}
                      ranks={ranks}
                      onPickRow={onPickRow}
                      onAskAi={onScanRow}
                    />
                    <button
                      type="button"
                      className={css.ghostBtn}
                      aria-expanded={showTable}
                      onClick={() => { setShowTable(!showTable) }}
                    >
                      {t(showTable ? 'options.overview.hideTable' : 'options.overview.showTable')}
                    </button>
                    {/* ③ 明细表（WB-1 基线，可折叠） */}
                    {showTable && (
                    <div className={css.tableWrap}>
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>{t('options.overview.col.name')}</th>
                        <th>{t('options.overview.col.last')}</th>
                        <th>{t('options.overview.col.change')}</th>
                        <th>{t('options.overview.col.return5d')}</th>
                        <th>{t('options.overview.col.volumeRatio')}</th>
                        <th>{t('options.overview.col.strength')}</th>
                        <th className={css.colTrend}>{t('options.overview.col.trend')}</th>
                        <th>{t('options.overview.col.iv')}</th>
                        {/* WB-10：宿主打标的 IV 制度，紧挨 IV 列；不替换 atmIv 数字 */}
                        <th title={t('options.overview.ivRegime.hint')}>{t('options.overview.col.ivRegime')}</th>
                        <th>{t('options.overview.col.heldQty')}</th>
                        <th>{t('options.overview.col.optionQty')}</th>
                        <th className={css.colStrategy}>{t('options.overview.col.strategy')}</th>
                        <th>{t('options.overview.col.t5')}</th>
                        {onScanRow !== undefined && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => {
                        const key = row.underlying
                        /** 宿主制度标签（strategy 投影优先，无 packet 回落行上）。 */
                        const regime = effectiveIvRegime(row)
                        return (
                          <tr
                            key={key}
                            className={css.row}
                            onClick={() => { onPickRow(row) }}
                            title={t('options.overview.pickHint')}
                          >
                            <td className={css.nameCell}>
                              <span className={css.name}>{row.name}</span>
                              <span className={css.code}>{row.underlying}</span>
                              {row.divergence !== undefined && (
                                <span className={css.divergence} data-kind={row.divergence}>
                                  {t(row.divergence === 'weak_rally'
                                    ? 'options.overview.divergence.weak_rally'
                                    : 'options.overview.divergence.accelerating_sell')}
                                </span>
                              )}
                            </td>
                            <td className={css.num}>{fmtPrice(row.last)}</td>
                            <td className={css.num} style={{ color: directionColor(row.changePct ?? 0, colorMode) }}>
                              {fmtPercent(row.changePct)}
                            </td>
                            <td className={css.num} style={{ color: directionColor(row.return5d ?? 0, colorMode) }}>
                              {fmtPercent(row.return5d)}
                            </td>
                            <td className={css.num}>{row.volumeRatio === undefined ? '—' : row.volumeRatio.toFixed(2)}</td>
                            <td className={css.num}>{row.strengthScore === undefined ? '—' : row.strengthScore.toFixed(2)}</td>
                            <td className={css.colTrend}>
                              <Sparkline values={trendValues(row.days)} width={84} height={22} up={(row.return5d ?? 0) >= 0} colorMode={colorMode} />
                            </td>
                            {/* IV 列：有真分位才出分位；只有 atmIv 时按年化格式化 + tooltip 声明不是分位 */}
                            {row.ivPercentile !== undefined
                              ? <td className={css.num}>{fmtIvPercentile(row.ivPercentile)}</td>
                              : (
                                <td
                                  className={css.num}
                                  data-iv-kind="annual"
                                  title={t('options.insight.reading.atmIv', { iv: fmtIvAnnual(row.atmIv) })}
                                >
                                  {fmtIvAnnual(row.atmIv)}
                                </td>
                              )}
                            {/* IV 制度徽章：闭集翻译，未知即「制度不明」，不猜贵贱 */}
                            <td className={css.num}>
                              {regime === undefined
                                ? '—'
                                : (
                                  <span
                                    className={css.strategyTag}
                                    data-tone="none"
                                    data-iv-regime={regime}
                                    title={t('options.overview.ivRegime.hint')}
                                  >
                                    {t(IV_REGIME_KEY[regime])}
                                  </span>
                                )}
                            </td>
                            <td className={css.num}>{row.heldQty === undefined ? '—' : fmtCompact(row.heldQty)}</td>
                            <td className={css.num}>{row.optionQty === undefined ? '—' : String(row.optionQty)}</td>
                            {/* 推荐策略：只读后端投影，前端不重算（WB-7） */}
                            <td className={css.colStrategy}>
                              {row.strategy === undefined
                                ? <span className={css.strategyTag} data-tone="none">—</span>
                                : (() => {
                                  const s = renderStrategy(row, row.strategy, t)
                                  return (
                                    <span
                                      className={css.strategyTag}
                                      data-tone={s.tone}
                                      title={s.title}
                                    >
                                      {s.label}
                                    </span>
                                  )
                                })()}
                            </td>
                            {/* T-5 量价矩阵：色深 = changePct，边框 = volumeSurge */}
                            <td className={css.t5Cell}>
                              <span className={css.t5}>
                                {(row.days ?? []).slice(-5).map(day => {
                                  const cell = dayCell(day.changePct)
                                  return (
                                    <span
                                      key={day.date}
                                      className={css.t5Box}
                                      data-surge={day.volumeSurge ? 'true' : undefined}
                                      style={cell.style}
                                      title={`${day.date} ${cell.label}${day.volumeSurge ? ` · ${t('options.overview.surge')}` : ''}`}
                                    >
                                      {cell.label}
                                    </span>
                                  )
                                })}
                              </span>
                            </td>
                            {onScanRow !== undefined && (
                              <td className={css.actionCell}>
                                <button
                                  type="button"
                                  className={css.scanRowBtn}
                                  onClick={(event) => { event.stopPropagation(); onScanRow(row) }}
                                >
                                  {t('options.overview.scanRow')}
                                </button>
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                    </div>
                    )}
                  </>
                )}

      <span className={css.hint}>{t('options.overview.hint')}</span>
    </div>
  )
}
