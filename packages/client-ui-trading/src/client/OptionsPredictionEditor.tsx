/**
 * T+1 预测编辑器（2026-09-12）：结构化录入模态，两种模式。
 *
 * - `create`：新建一条 T+1 预测。盘势 6 类 + 波动 2 类选择、置信度滑块、动态
 *   因子增删（因子名 / 倾向 / 权重 / 证据）、分析结论、评估方法、目标交易日。
 * - `settle`：T+1 收盘回填实盘。只读展示原预测，录入实际盘势 / 实际波动
 *   （含「无法判定」）/ 实际涨跌幅 / 波动率变化 / 复盘笔记 / 经验沉淀；命中
 *   与评分由桥权威计算（前端只传原始实盘，避免双算）。
 *
 * 纯前端：通过 api.ts 的 createOptionPrediction / settleOptionPrediction 打桥；
 * 不自己持状态。本页技术与行情分析面，不构成投资建议。
 */
import { useState } from 'react'
import type { MarketLocaleKey } from './contract.ts'
import type {
  MarketExpectation, OptionPrediction, PredictionBias, PredictionFactor, VolExpectation,
} from '@dshtrading/api'
import {
  createOptionPrediction, settleOptionPrediction,
} from './api.ts'
import {
  MARKET_EXPECTATION_KEY, MARKET_EXPECTATION_ORDER, PREDICTION_BIAS_KEY, VOL_EXPECTATION_KEY,
} from './option-prediction-vocabulary.ts'
import css from './options-prediction.module.css'

export type OptionsPredictionTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 回填实盘时实际值的可选集（在预测域之上追加「无法判定」）。 */
const REALIZED_MARKET_OPTIONS: readonly (MarketExpectation | 'na')[] = [...MARKET_EXPECTATION_ORDER, 'na']
const REALIZED_VOL_OPTIONS: readonly (VolExpectation | 'na')[] = ['up', 'down', 'na']

interface FactorDraft {
  label: string
  bias: PredictionBias
  weight: string // 文本态，空=缺省
  evidence: string
}

function emptyFactor(): FactorDraft {
  return { label: '', bias: 'neutral', weight: '', evidence: '' }
}

/** 稳定 id（落盘后不变；桥不依赖它做幂等，仅作 React key）。 */
function fid(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface OptionsPredictionEditorProps {
  t: OptionsPredictionTranslate
  mode: 'create' | 'settle'
  /** create 模式预填标的（点看板某标的「新建」时带入）。 */
  preset?: { underlying?: string; underlyingName?: string; targetDate?: string }
  /** settle 模式回填的预测对象。 */
  prediction?: OptionPrediction
  onClose: () => void
  onSaved: (prediction: OptionPrediction) => void
}

export function OptionsPredictionEditor(props: OptionsPredictionEditorProps): React.JSX.Element {
  const { t, mode, preset, prediction, onClose, onSaved } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── create 字段态 ──
  const [underlying, setUnderlying] = useState(preset?.underlying ?? '')
  const [underlyingName, setUnderlyingName] = useState(preset?.underlyingName ?? '')
  const [targetDate, setTargetDate] = useState(preset?.targetDate ?? '')
  const [market, setMarket] = useState<MarketExpectation>('consolidation')
  const [vol, setVol] = useState<VolExpectation>('down')
  const [confidence, setConfidence] = useState(0.5)
  const [factors, setFactors] = useState<FactorDraft[]>([])
  const [thesis, setThesis] = useState('')
  const [evaluationMethod, setEvaluationMethod] = useState('')

  // ── settle 字段态 ──
  const [realizedMarket, setRealizedMarket] = useState<MarketExpectation | 'na'>('na')
  const [realizedVol, setRealizedVol] = useState<VolExpectation | 'na'>('na')
  const [marketReturnPct, setMarketReturnPct] = useState('')
  const [volChange, setVolChange] = useState('')
  const [retrospect, setRetrospect] = useState('')
  const [knowledgeNotes, setKnowledgeNotes] = useState('')

  const isCreate = mode === 'create'

  const createValid = !isCreate || (
    underlying.trim() !== ''
    && DATE_RE.test(targetDate)
    && market !== undefined
    && vol !== undefined
    && confidence >= 0 && confidence <= 1
  )

  const run = (): void => {
    if (busy) return
    setError(null)
    if (isCreate) {
      if (!createValid) { setError(t('options.prediction.create.invalid')); return }
      const draftedFactors: PredictionFactor[] = factors
        .filter((f) => f.label.trim() !== '')
        .map((f) => ({
          id: fid(),
          label: f.label.trim(),
          bias: f.bias,
          ...(f.weight.trim() !== '' ? { weight: Number(f.weight) } : {}),
          evidence: f.evidence.trim(),
        }))
      setBusy(true)
      void createOptionPrediction({
        underlying: underlying.trim(),
        ...(underlyingName.trim() !== '' ? { underlyingName: underlyingName.trim() } : {}),
        targetDate,
        marketExpectation: market,
        volExpectation: vol,
        confidence,
        factors: draftedFactors,
        thesis: thesis.trim(),
        evaluationMethod: evaluationMethod.trim(),
      }).then((res) => {
        setBusy(false)
        if (res.ok) onSaved(res.data)
        else setError(`${res.code}: ${res.message}`)
      }).catch((err: unknown) => { setBusy(false); setError(String(err)) })
    } else if (prediction !== undefined) {
      const retPct = marketReturnPct.trim() === '' ? 0 : Number(marketReturnPct)
      const vChg = volChange.trim() === '' ? 0 : Number(volChange)
      if (Number.isNaN(retPct) || Number.isNaN(vChg)) { setError(t('options.prediction.settle.invalidNumber')); return }
      setBusy(true)
      void settleOptionPrediction({
        id: prediction.id,
        realizedMarket,
        realizedVol,
        marketReturnPct: retPct,
        volChange: vChg,
        retrospect: retrospect.trim(),
        knowledgeNotes: knowledgeNotes.trim(),
      }).then((res) => {
        setBusy(false)
        if (res.ok) onSaved(res.data)
        else setError(`${res.code}: ${res.message}`)
      }).catch((err: unknown) => { setBusy(false); setError(String(err)) })
    }
  }

  return (
    <div className={css.overlay} onClick={onClose}>
      <div className={css.modal} onClick={(e) => { e.stopPropagation() }}>
        <span className={css.modalTitle}>
          {isCreate
            ? t('options.prediction.createTitle')
            : t('options.prediction.track.settleTitle', { underlying: prediction?.underlying ?? '' })}
        </span>

        {isCreate
          ? (
            <>
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.underlying')}</span>
                <input className={css.input} value={underlying} onChange={(e) => { setUnderlying(e.target.value) }} placeholder="510050" />
              </div>
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.underlying')} · {t('options.prediction.underlyingName.optional')}</span>
                <input className={css.input} value={underlyingName} onChange={(e) => { setUnderlyingName(e.target.value) }} placeholder="50ETF" />
              </div>
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.targetDate')}</span>
                <input className={css.input} value={targetDate} onChange={(e) => { setTargetDate(e.target.value) }} placeholder="2026-09-15" />
                <span className={css.fieldHint}>{t('options.prediction.targetDate.hint')}</span>
              </div>

              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.market.label')}</span>
                <div className={css.choiceRow}>
                  {MARKET_EXPECTATION_ORDER.map((m) => (
                    <button key={m} type="button" className={css.choice} data-kind={m} data-selected={market === m} onClick={() => { setMarket(m) }}>
                      {t(MARKET_EXPECTATION_KEY[m])}
                    </button>
                  ))}
                </div>
              </div>

              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.vol.label')}</span>
                <div className={css.choiceRow}>
                  {(['up', 'down'] as const).map((v) => (
                    <button key={v} type="button" className={css.choice} data-selected={vol === v} onClick={() => { setVol(v) }}>
                      {t(VOL_EXPECTATION_KEY[v])}
                    </button>
                  ))}
                </div>
              </div>

              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.confidence')} {Math.round(confidence * 100)}%</span>
                <div className={css.rangeRow}>
                  <input type="range" min={0} max={1} step={0.05} value={confidence} onChange={(e) => { setConfidence(Number(e.target.value)) }} />
                </div>
              </div>

              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.factors')}</span>
                <div className={css.section}>
                  {factors.map((f, i) => (
                    <div key={i} className={css.factorEdit}>
                      <input className={css.input} value={f.label} placeholder={t('options.prediction.factor.label')} onChange={(e) => { setFactors((arr) => arr.map((x, j) => j === i ? { ...x, label: e.target.value } : x)) }} />
                      <select className={css.select} value={f.bias} onChange={(e) => { setFactors((arr) => arr.map((x, j) => j === i ? { ...x, bias: e.target.value as PredictionBias } : x)) }}>
                        {(['bull', 'bear', 'neutral'] as const).map((b) => (<option key={b} value={b}>{t(PREDICTION_BIAS_KEY[b])}</option>))}
                      </select>
                      <input className={css.input} value={f.weight} placeholder="0.6" onChange={(e) => { setFactors((arr) => arr.map((x, j) => j === i ? { ...x, weight: e.target.value } : x)) }} />
                      <input className={css.input} value={f.evidence} placeholder={t('options.prediction.factor.evidence')} onChange={(e) => { setFactors((arr) => arr.map((x, j) => j === i ? { ...x, evidence: e.target.value } : x)) }} />
                      <button type="button" className={css.factorRemove} onClick={() => { setFactors((arr) => arr.filter((_, j) => j !== i)) }}>{t('options.prediction.factor.remove')}</button>
                    </div>
                  ))}
                  <button type="button" className={css.addFactor} onClick={() => { setFactors((arr) => [...arr, emptyFactor()]) }}>{t('options.prediction.factor.add')}</button>
                </div>
                <span className={css.fieldHint}>{t('options.prediction.factor.weight')} · {t('options.prediction.factor.evidence')}</span>
              </div>

              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.thesis')}</span>
                <textarea className={css.textarea} value={thesis} onChange={(e) => { setThesis(e.target.value) }} />
              </div>
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('options.prediction.evaluationMethod')}</span>
                <textarea className={css.textarea} value={evaluationMethod} onChange={(e) => { setEvaluationMethod(e.target.value) }} placeholder={t('options.prediction.evaluationMethod.placeholder')} />
              </div>
            </>
          )
          : (
            <SettleBody
              t={t}
              prediction={prediction}
              realizedMarket={realizedMarket}
              setRealizedMarket={setRealizedMarket}
              realizedVol={realizedVol}
              setRealizedVol={setRealizedVol}
              marketReturnPct={marketReturnPct}
              setMarketReturnPct={setMarketReturnPct}
              volChange={volChange}
              setVolChange={setVolChange}
              retrospect={retrospect}
              setRetrospect={setRetrospect}
              knowledgeNotes={knowledgeNotes}
              setKnowledgeNotes={setKnowledgeNotes}
            />
          )}

        {error !== null && <div className={css.notice}>{error}</div>}

        <div className={css.actions}>
          <button type="button" className={css.secondaryBtn} onClick={onClose}>{t('options.prediction.cancel')}</button>
          <button type="button" className={css.primaryBtn} disabled={busy || (isCreate && !createValid)} onClick={run}>
            {busy ? t('options.prediction.saving') : t('options.prediction.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettleBody(props: {
  t: OptionsPredictionTranslate
  prediction: OptionPrediction | undefined
  realizedMarket: MarketExpectation | 'na'
  setRealizedMarket: (v: MarketExpectation | 'na') => void
  realizedVol: VolExpectation | 'na'
  setRealizedVol: (v: VolExpectation | 'na') => void
  marketReturnPct: string
  setMarketReturnPct: (v: string) => void
  volChange: string
  setVolChange: (v: string) => void
  retrospect: string
  setRetrospect: (v: string) => void
  knowledgeNotes: string
  setKnowledgeNotes: (v: string) => void
}): React.JSX.Element {
  const { t, prediction } = props
  return (
    <>
      {prediction !== undefined && (
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('options.prediction.track.title')} · {prediction.targetDate}</span>
          <div className={css.expectRow}>
            <span className={css.badge} data-kind={prediction.marketExpectation}>{t(MARKET_EXPECTATION_KEY[prediction.marketExpectation])}</span>
            <span className={css.badge} data-kind={prediction.volExpectation === 'up' ? 'breakout' : 'consolidation'}>{t(VOL_EXPECTATION_KEY[prediction.volExpectation])}</span>
            <span className={css.confidence}>{t('options.prediction.confidence')} {Math.round(prediction.confidence * 100)}%</span>
          </div>
          {prediction.thesis.trim() !== '' && <p className={css.thesis}>{prediction.thesis}</p>}
        </div>
      )}

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('options.prediction.track.realizedMarket')}</span>
        <div className={css.choiceRow}>
          {REALIZED_MARKET_OPTIONS.map((m) => (
            <button key={m} type="button" className={css.choice} data-kind={m} data-selected={props.realizedMarket === m} onClick={() => { props.setRealizedMarket(m) }}>
              {m === 'na' ? t('options.prediction.track.na') : t(MARKET_EXPECTATION_KEY[m])}
            </button>
          ))}
        </div>
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('options.prediction.track.realizedVol')}</span>
        <div className={css.choiceRow}>
          {REALIZED_VOL_OPTIONS.map((v) => (
            <button key={v} type="button" className={css.choice} data-selected={props.realizedVol === v} onClick={() => { props.setRealizedVol(v) }}>
              {v === 'na' ? t('options.prediction.track.na') : t(VOL_EXPECTATION_KEY[v])}
            </button>
          ))}
        </div>
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('options.prediction.track.marketReturnPct')}</span>
        <input className={css.input} value={props.marketReturnPct} onChange={(e) => { props.setMarketReturnPct(e.target.value) }} placeholder="-1.23" />
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('options.prediction.track.volChange')}</span>
        <input className={css.input} value={props.volChange} onChange={(e) => { props.setVolChange(e.target.value) }} placeholder="0.05" />
        <span className={css.fieldHint}>{t('options.prediction.volChange.hint')}</span>
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('options.prediction.track.retrospect')}</span>
        <textarea className={css.textarea} value={props.retrospect} onChange={(e) => { props.setRetrospect(e.target.value) }} />
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('options.prediction.track.knowledgeNotes')}</span>
        <textarea className={css.textarea} value={props.knowledgeNotes} onChange={(e) => { props.setKnowledgeNotes(e.target.value) }} placeholder={t('options.prediction.knowledgeNotes.placeholder')} />
      </div>
    </>
  )
}
