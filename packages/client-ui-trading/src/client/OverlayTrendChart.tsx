/**
 * 九标的 5 日走势叠加图（2026-09-09 WB-9）。
 *
 * 为什么是「同一坐标系叠加」而不是九条独立 sparkline：
 * 独立 sparkline 每条自己归一化到自己的 min/max，**九条线不可比**——看不出谁强谁弱，
 * 只能看出谁波动大。叠加图共用一个 Y 轴（统一以 T-5 首日收盘为 0%），
 * 线的**相对位置**就是强弱序，这才回答「买谁 / 避谁」。
 *
 * 视觉分层（对应诉求「最强 / 最弱 / 中间用较粗的线条」）：
 * - 最强（第 1 名）/ 最弱（末名）/ 中位 → 粗线 + 全不透明 + 末端挂名称标签；
 * - 其余 → 细线 + 低透明度（不抢戏，但保留形态）；
 * - 悬停图例 → 该线提到最前、其余压到 0.1，用于临时聚焦任意一条。
 *
 * 数据纪律：只用 `days[].changePct` 累乘成累计涨跌幅，**不重算** strengthScore /
 * IV 分位，**不画**箱体/目标价（箱体一律走 `cn_get_option_intraday_box`）。
 * 序列短的只画到实际长度，不补齐、不外推。
 *
 * 本图为技术与行情分析面，不构成投资建议。
 */
import { useState } from 'react'
import type { OptionOverviewRow } from '@dshtrading/api'
import type { ColorMode } from './color-mode.ts'
import { getColorPalette } from './color-mode.ts'
import type { MarketLocaleKey } from './contract.ts'
import { rankByCumulative } from './option-insight.ts'
import css from './options-overview.module.css'

export type OverlayTrendTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OverlayTrendChartProps {
  t: OverlayTrendTranslate
  colorMode: ColorMode
  rows: readonly OptionOverviewRow[]
  /** 点图例进 T 板（与表格行点击同一语义）。 */
  onPickRow?: ((row: OptionOverviewRow) => void) | undefined
  /** 图高（px，viewBox 单位同值）。 */
  height?: number
}

interface Series {
  readonly row: OptionOverviewRow
  readonly rank: number
  /** 累计涨跌幅序列（%），起点 0。 */
  readonly pts: readonly number[]
  readonly dates: readonly string[]
  readonly end: number | undefined
}

/** 强调名次级：最强 / 中位 / 最弱。 */
function emphasisOf(rank: number, total: number): 'strong' | 'weak' | 'median' | undefined {
  if (total <= 0) return undefined
  if (rank === 0) return 'strong'
  if (rank === total - 1) return total === 1 ? undefined : 'weak'
  if (rank === Math.floor(total / 2)) return 'median'
  return undefined
}

/** 绘制层：强调线画在上层（1），背景线在下层（0）。 */
function emphasisLayer(s: Series, total: number): number {
  return emphasisOf(s.rank, total) === undefined ? 0 : 1
}

function fmtPct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

const W = 680
const PAD_L = 38
const PAD_R = 62
const PAD_T = 10
const PAD_B = 20

export function OverlayTrendChart({
  t, colorMode, rows, onPickRow, height = 190,
}: OverlayTrendChartProps): React.JSX.Element {
  const [active, setActive] = useState<string | undefined>(undefined)
  const palette = getColorPalette(colorMode)

  const ranked = rankByCumulative(rows)
  const series: Series[] = ranked.map(({ row, rank, cum5d }) => {
    const days = row.days ?? []
    const pts: number[] = []
    let cum = 0
    for (const d of days) {
      cum = (1 + cum / 100) * (1 + (d.changePct ?? 0) / 100) * 100 - 100
      pts.push(cum)
    }
    return { row, rank, pts, dates: days.map(d => d.date), end: cum5d }
  })

  const withPts = series.filter(s => s.pts.length > 0)
  const maxLen = withPts.reduce((m, s) => Math.max(m, s.pts.length), 0)
  const xs = withPts.find(s => s.pts.length === maxLen)
  const axisDates = xs?.dates ?? []

  if (maxLen < 2 || withPts.length === 0) {
    return (
      <div className={css.overlay} data-dshtrading-overlay-trend="">
        <span className={css.overlayTitle}>{t('options.overview.overlayTitle')}</span>
        <span className={css.overlayEmpty}>{t('options.overview.overlayEmpty')}</span>
      </div>
    )
  }

  let lo = 0
  let hi = 0
  for (const s of withPts) {
    for (const v of s.pts) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const pad = Math.max(0.2, (hi - lo) * 0.08)
  const yLo = lo - pad
  const yHi = hi + pad

  const plotW = W - PAD_L - PAD_R
  const plotH = height - PAD_T - PAD_B
  const xAt = (i: number): number => PAD_L + (i / (maxLen - 1)) * plotW
  const yAt = (v: number): number => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * plotH

  return (
    <div className={css.overlay} data-dshtrading-overlay-trend="">
      <div className={css.overlayHead}>
        <span className={css.overlayTitle}>{t('options.overview.overlayTitle')}</span>
        <span className={css.overlayLegendHint}>{t('options.overview.overlayHint')}</span>
      </div>

      <svg
        className={css.overlaySvg}
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={t('options.overview.overlayTitle')}
      >
        {/* Y 刻度：上沿 / 0% / 下沿 */}
        {[yHi, 0, yLo].map((v, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yAt(v)}
              y2={yAt(v)}
              stroke={v === 0 ? 'var(--dsw-futu-border-default, #e3e6ea)' : 'transparent'}
              strokeDasharray={v === 0 ? '3 3' : undefined}
            />
            <text className={css.axisText} x={PAD_L - 6} y={yAt(v) + 3} textAnchor="end">
              {`${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
            </text>
          </g>
        ))}

        {/* X 日期刻度（只标首尾 + 中间，避免 5 格挤爆） */}
        {axisDates.map((d, i) => {
          if (i !== 0 && i !== maxLen - 1 && i !== Math.floor((maxLen - 1) / 2)) return null
          return (
            <text
              key={`x${d}${i}`}
              className={css.axisText}
              x={xAt(i)}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === maxLen - 1 ? 'end' : 'middle'}
            >
              {d.slice(5)}
            </text>
          )
        })}

        {/* 折线：非强调先画（在下），强调后画（在上） */}
        {[...withPts]
          .sort((a, b) => emphasisLayer(a, withPts.length) - emphasisLayer(b, withPts.length))
          .map((s) => {
            const key = s.row.underlying
            const emph = emphasisOf(s.rank, withPts.length)
            const isActive = active === key
            const dim = active !== undefined && !isActive
            const up = (s.end ?? 0) >= 0
            const color = emph === 'median'
              ? 'var(--dsw-futu-accent, #3b82f6)'
              : up ? palette.upColor : palette.downColor
            const width = isActive ? 2.6 : emph === undefined ? 1.1 : 2.4
            const opacity = dim ? 0.1 : emph === undefined ? 0.34 : isActive ? 1 : 0.95
            const points = s.pts.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(' ')
            const lastX = xAt(s.pts.length - 1)
            const lastY = yAt(s.pts[s.pts.length - 1] as number)
            return (
              <g key={key} opacity={opacity}>
                <polyline
                  points={points}
                  fill="none"
                  stroke={color}
                  strokeWidth={width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray={emph === 'median' ? '5 3' : undefined}
                />
                <circle cx={lastX} cy={lastY} r={isActive || emph !== undefined ? 2.8 : 1.8} fill={color} />
                {(emph !== undefined || isActive) && (
                  <text className={css.lineLabel} x={lastX + 5} y={lastY + 3.5} fill={color}>
                    {`${s.row.name} ${fmtPct(s.end)}`}
                  </text>
                )}
              </g>
            )
          })}
      </svg>

      {/* 图例：名次 / 名称 / 5 日累计；悬停聚焦，点击进 T 板 */}
      <div className={css.legend}>
        {series.map((s) => {
          const key = s.row.underlying
          const emph = emphasisOf(s.rank, series.length)
          const up = (s.end ?? 0) >= 0
          return (
            <button
              key={key}
              type="button"
              className={css.legendItem}
              data-emph={emph}
              data-active={active === key ? 'true' : undefined}
              onMouseEnter={() => { setActive(key) }}
              onMouseLeave={() => { setActive(undefined) }}
              onFocus={() => { setActive(key) }}
              onBlur={() => { setActive(undefined) }}
              onClick={() => { onPickRow?.(s.row) }}
              title={s.row.scanPrompt === '' ? undefined : t('options.overview.pickHint')}
            >
              <span className={css.legendRank}>{String(s.rank + 1)}</span>
              <span className={css.legendName}>{s.row.name}</span>
              <span className={css.legendVal} data-up={up ? 'true' : 'false'}>{fmtPct(s.end)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
