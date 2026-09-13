/**
 * T+1 预测跟踪回溯（2026-09-12）：单标的（或全局）历史时间线 + 统计矩阵 + 经验沉淀。
 *
 * 聚焦用户最关心的「分析过程 / 评估方法 / 命中复盘」：
 * - 左栏时间线：每条预测展示盘势/波动/置信度/分析因子/分析结论/评估方法，已回填的
 *   额外展开实际盘势、实际涨跌幅、波动率变化、命中判定、评分、复盘笔记与经验沉淀；
 *   未回填的给「回填实盘」按钮（开 settle 模态）。
 * - 右栏：累计统计（总数/已评估/盘势命中率/波动命中率/平均评分）、盘势与波动分类
 *   矩阵（预测次数 vs 命中次数）、经验沉淀列表（按引用次数降序，最常验证的靠前）。
 *
 * 纯展示：数据由 OptionsPredictionMiddleView 自取数后传入。本页技术与行情分析面，
 * 不构成投资建议。
 */
import type { MarketLocaleKey } from './contract.ts'
import type { MarketExpectation, OptionPrediction, OptionPredictionTrack, VolExpectation } from '@dshtrading/api'
import {
  MARKET_EXPECTATION_KEY, MARKET_EXPECTATION_ORDER, VOL_EXPECTATION_KEY,
} from './option-prediction-vocabulary.ts'
import { fmtPercent } from './format.ts'
import css from './options-prediction.module.css'

export type OptionsPredictionTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionsPredictionTrackProps {
  t: OptionsPredictionTranslate
  underlying?: string
  track: OptionPredictionTrack | null
  failure: { code: string; message: string } | null
  loaded: boolean
  onSettle: (prediction: OptionPrediction) => void
  onClearFocus?: () => void
}

type Verdict = 'hit' | 'partial' | 'miss' | 'pending'

function verdictOf(p: OptionPrediction): Verdict {
  if (p.outcome === undefined) return 'pending'
  const m = p.outcome.realizedMarket === 'na' ? null : p.outcome.hitMarket
  const v = p.outcome.realizedVol === 'na' ? null : p.outcome.hitVol
  const hits = [m, v].filter((x) => x === true).length
  const decided = [m, v].filter((x) => x !== null).length
  if (decided === 0) return 'pending'
  if (hits === decided && hits > 0) return 'hit'
  if (hits === 0) return 'miss'
  return 'partial'
}

function fmtReturn(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`
}
function fmtVolChange(v: number): string {
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

export function OptionsPredictionTrack(props: OptionsPredictionTrackProps): React.JSX.Element {
  const { t, underlying, track, failure, loaded, onSettle, onClearFocus } = props

  if (failure !== null) return <div className={css.notice}>{failure.code}: {failure.message}</div>
  if (!loaded) return <div className={css.notice}>{t('options.prediction.board.loading')}</div>
  if (track === null || track.predictions.length === 0) {
    return <div className={css.notice}>{t('options.prediction.track.empty')}</div>
  }

  const stats = track.stats

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('options.prediction.track.title')}</span>
        {underlying !== undefined
          ? (
            <>
              <span className={css.badge} data-kind="consolidation">{underlying}</span>
              {onClearFocus !== undefined && <button type="button" className={css.secondaryBtn} onClick={onClearFocus}>{t('options.prediction.tab.board')}</button>}
            </>
          )
          : <span className={css.subtitle}>{t('options.prediction.subtitle')}</span>}
      </div>

      <div className={css.trackLayout}>
        {/* 左栏：时间线 */}
        <div className={css.panel}>
          <span className={css.panelTitle}>{t('options.prediction.analysis')}</span>
          <div className={css.timeline}>
            {track.predictions.map((p) => {
              const verdict = verdictOf(p)
              return (
                <div key={p.id} className={css.tlItem}>
                  <div className={css.tlHead}>
                    <span className={css.tlDate}>{p.targetDate}</span>
                    <span className={css.tlVerdict} data-hit={verdict === 'hit'} data-pending={verdict === 'pending'}>{t(`options.prediction.track.${verdict}`)}</span>
                    <span className={css.badge} data-kind={p.marketExpectation}>{t(MARKET_EXPECTATION_KEY[p.marketExpectation])}</span>
                    <span className={css.badge} data-kind={p.volExpectation === 'up' ? 'breakout' : 'consolidation'}>{t(VOL_EXPECTATION_KEY[p.volExpectation])}</span>
                    <span className={css.confidence}>{t('options.prediction.confidence')} {Math.round(p.confidence * 100)}%</span>
                  </div>

                  {p.factors.length > 0 && (
                    <div className={css.factorList}>
                      {p.factors.map((f) => (
                        <div key={f.id} className={css.factorRow}>
                          <span className={css.factorDot} data-bias={f.bias} />
                          <span className={css.factorLabel}>{f.label}</span>
                          <span className={css.factorEv}>{f.evidence}</span>
                          {f.weight !== undefined && <span className={css.factorWeight}>·{fmtPercent(f.weight * 100)}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {p.thesis.trim() !== '' && <p className={css.tlText}><b>{t('options.prediction.thesis')}</b> {p.thesis}</p>}
                  {p.evaluationMethod.trim() !== '' && <p className={css.tlText}><b>{t('options.prediction.evaluationMethod')}</b> {p.evaluationMethod}</p>}

                  {p.outcome !== undefined && (
                    <div className={css.section}>
                      <p className={css.tlText}>
                        <b>{t('options.prediction.track.realizedMarket')}</b> {p.outcome.realizedMarket === 'na' ? t('options.prediction.track.na') : t(MARKET_EXPECTATION_KEY[p.outcome.realizedMarket])}
                        {' · '}<b>{t('options.prediction.track.realizedVol')}</b> {p.outcome.realizedVol === 'na' ? t('options.prediction.track.na') : t(VOL_EXPECTATION_KEY[p.outcome.realizedVol])}
                        {' · '}<b>{t('options.prediction.track.marketReturnPct')}</b> {fmtReturn(p.outcome.marketReturnPct)}
                        {' · '}<b>{t('options.prediction.track.volChange')}</b> {fmtVolChange(p.outcome.volChange)}
                        {' · '}<b>{t('options.prediction.track.score')}</b> {fmtPercent(p.outcome.score * 100)}
                      </p>
                      {p.outcome.retrospect.trim() !== '' && <p className={css.tlText}><b>{t('options.prediction.track.retrospect')}</b> {p.outcome.retrospect}</p>}
                      {p.outcome.knowledgeNotes.trim() !== '' && <p className={css.tlText}><b>{t('options.prediction.track.knowledgeNotes')}</b> {p.outcome.knowledgeNotes}</p>}
                    </div>
                  )}

                  {p.outcome === undefined && (
                    <button type="button" className={css.primaryBtn} onClick={() => { onSettle(p) }}>{t('options.prediction.track.settle')}</button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 右栏：统计 + 矩阵 + 经验沉淀 */}
        <div className={css.panel}>
          <span className={css.panelTitle}>{t('options.prediction.track.stats')}</span>
          <div className={css.statGrid}>
            <div className={css.statCell}><span className={css.statCellLabel}>{t('options.prediction.track.total')}</span><span className={css.statCellValue}>{stats.total}</span></div>
            <div className={css.statCell}><span className={css.statCellLabel}>{t('options.prediction.track.scored')}</span><span className={css.statCellValue}>{stats.scored}</span></div>
            <div className={css.statCell}><span className={css.statCellLabel}>{t('options.prediction.track.marketHitRate')}</span><span className={css.statCellValue}>{fmtPercent(stats.marketHitRate * 100)}</span></div>
            <div className={css.statCell}><span className={css.statCellLabel}>{t('options.prediction.track.volHitRate')}</span><span className={css.statCellValue}>{fmtPercent(stats.volHitRate * 100)}</span></div>
            <div className={css.statCell}><span className={css.statCellLabel}>{t('options.prediction.track.avgScore')}</span><span className={css.statCellValue}>{fmtPercent(stats.avgScore * 100)}</span></div>
          </div>

          <span className={css.panelTitle}>{t('options.prediction.track.marketMatrix')}</span>
          <div className={css.matrix}>
            {MARKET_EXPECTATION_ORDER.filter((m) => (stats.marketMatrix[m]?.predicted ?? 0) > 0).map((m) => (
              <MatrixRow key={m} t={t} label={t(MARKET_EXPECTATION_KEY[m])} cell={stats.marketMatrix[m]!} />
            ))}
          </div>

          <span className={css.panelTitle}>{t('options.prediction.track.volMatrix')}</span>
          <div className={css.matrix}>
            {(['up', 'down'] as const).filter((v) => (stats.volMatrix[v]?.predicted ?? 0) > 0).map((v) => (
              <MatrixRow key={v} t={t} label={t(VOL_EXPECTATION_KEY[v])} cell={stats.volMatrix[v]!} />
            ))}
          </div>

          <span className={css.panelTitle}>{t('options.prediction.track.knowledge')}</span>
          {track.knowledge.length === 0
            ? <span className={css.knowledgeMeta}>{t('options.prediction.track.knowledgeEmpty')}</span>
            : track.knowledge.map((k) => (
              <div key={k.id} className={css.knowledgeItem}>
                <span className={css.knowledgeLesson}>{k.lesson}</span>
                {k.condition.trim() !== '' && <span className={css.knowledgeCond}>{t('options.prediction.track.condition')}{'\uFF1A'}{k.condition}</span>}
                <span className={css.knowledgeMeta}>{t('options.prediction.track.usage')} {k.usage}</span>
              </div>
            ))}
        </div>
      </div>

      <span className={css.disclaimer}>{t('options.prediction.disclaimer')}</span>
    </div>
  )
}

function MatrixRow(props: {
  t: OptionsPredictionTranslate
  label: string
  cell: { predicted: number; hit: number }
}): React.JSX.Element {
  const { t, label, cell } = props
  const rate = cell.predicted === 0 ? 0 : cell.hit / cell.predicted
  return (
    <div className={css.matrixRow}>
      <span className={css.sectionLabel} style={{ minWidth: 44 }}>{label}</span>
      <div className={css.matrixBar}><div className={css.matrixFill} style={{ width: `${Math.round(rate * 100)}%` }} /></div>
      <span className={css.matrixCount}>{t('options.prediction.track.hit')} {cell.hit}/{cell.predicted}</span>
    </div>
  )
}
