/**
 * T+1 预测看板（2026-09-12）：每个标的展示最新一条 T+1 预测（盘势 6 类 +
 * 波动 2 类 + 置信度 + 分析过程摘要 + 累计命中）。点卡进入该标的跟踪回溯。
 *
 * 纯展示：数据由 OptionsPredictionMiddleView 自取数后传入；不自己打桥。
 * 本页技术与行情分析面，不构成投资建议。
 */
import type { MarketLocaleKey } from './contract.ts'
import type { OptionPrediction, OptionPredictionBoard } from '@dshtrading/api'
import {
  MARKET_EXPECTATION_KEY, VOL_EXPECTATION_KEY, MARKET_EXPECTATION_ORDER, PREDICTION_BIAS_KEY,
} from './option-prediction-vocabulary.ts'
import { fmtPercent } from './format.ts'
import css from './options-prediction.module.css'

export type OptionsPredictionTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionsPredictionBoardProps {
  t: OptionsPredictionTranslate
  board: OptionPredictionBoard | null
  failure: { code: string; message: string } | null
  loaded: boolean
  onOpenTrack: (underlying?: string) => void
  onNew: () => void
}

function PredictionCard(props: {
  t: OptionsPredictionTranslate
  underlying: string
  name?: string
  latest?: OptionPrediction
  marketHitRate?: number
  volHitRate?: number
  total: number
  onOpen: () => void
}): React.JSX.Element {
  const { t, underlying, name, latest, marketHitRate, volHitRate, total, onOpen } = props
  return (
    <div className={css.card} data-underlying={underlying} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      <div className={css.cardHead}>
        <span className={css.cardName}>{name ?? underlying}</span>
        <span className={css.cardCode}>{underlying}</span>
      </div>

      {latest === undefined
        ? <span className={css.notice}>{t('options.prediction.board.noPrediction')}</span>
        : (
          <>
            <div className={css.expectRow}>
              <span className={css.sectionLabel}>{t('options.prediction.market.label')}</span>
              <span className={css.badge} data-kind={latest.marketExpectation}>
                {t(MARKET_EXPECTATION_KEY[latest.marketExpectation])}
              </span>
              <span className={css.badge} data-kind={latest.volExpectation === 'up' ? 'breakout' : 'consolidation'}>
                {t(VOL_EXPECTATION_KEY[latest.volExpectation])}
              </span>
              <span className={css.confidence}>{t('options.prediction.confidence')} {fmtPercent(latest.confidence * 100)}</span>
            </div>

            {latest.factors.length > 0 && (
              <div className={css.factorList}>
                {latest.factors.slice(0, 3).map((factor) => (
                  <div key={factor.id} className={css.factorRow}>
                    <span className={css.factorDot} data-bias={factor.bias} />
                    <span className={css.factorLabel}>{factor.label}</span>
                    <span className={css.factorEv}>{factor.evidence}</span>
                    {factor.weight !== undefined && <span className={css.factorWeight}>·{fmtPercent(factor.weight * 100)}</span>}
                  </div>
                ))}
                {latest.factors.length > 3 && (
                  <span className={css.factorEv}>+{latest.factors.length - 3}</span>
                )}
              </div>
            )}

            {latest.thesis.trim() !== '' && <p className={css.thesis}>{latest.thesis}</p>}

            <div className={css.statRow}>
              <span>{t('options.prediction.board.marketHit')} <b>{marketHitRate === undefined ? '—' : fmtPercent(marketHitRate * 100)}</b></span>
              <span>{t('options.prediction.board.volHit')} <b>{volHitRate === undefined ? '—' : fmtPercent(volHitRate * 100)}</b></span>
              <span>{t('options.prediction.board.total')} <b>{total}</b></span>
            </div>
          </>
        )}
    </div>
  )
}

export function OptionsPredictionBoard({ t, board, failure, loaded, onOpenTrack, onNew }: OptionsPredictionBoardProps): React.JSX.Element {
  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('options.prediction.title')}</span>
        <span className={css.subtitle}>{t('options.prediction.subtitle')}</span>
        <span className={css.spacer} />
        <button type="button" className={css.primaryBtn} onClick={onNew}>{t('options.prediction.new')}</button>
      </div>

      {failure !== null
        ? <div className={css.notice}>{failure.code}: {failure.message}</div>
        : !loaded
          ? <div className={css.notice}>{t('options.prediction.board.loading')}</div>
          : board === null || board.rows.length === 0
            ? <div className={css.notice}>{t('options.prediction.board.empty')}</div>
            : (
              <div className={css.cards}>
                {board.rows.map((row) => (
                  <PredictionCard
                    key={row.underlying}
                    t={t}
                    underlying={row.underlying}
                    name={row.underlyingName}
                    latest={row.latest}
                    marketHitRate={row.marketHitRate}
                    volHitRate={row.volHitRate}
                    total={row.total}
                    onOpen={() => { onOpenTrack(row.underlying) }}
                  />
                ))}
              </div>
            )}

      <span className={css.hint}>{t('options.prediction.board.hint')}</span>
      <span className={css.disclaimer}>{t('options.prediction.disclaimer')}</span>
    </div>
  )
}

/** 供编辑器复用：盘势预期固定顺序（涨跌居中 breakout/consolidation）。 */
export { MARKET_EXPECTATION_ORDER, PREDICTION_BIAS_KEY }
