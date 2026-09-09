/**
 * 组合策略预览（WB-4）：复用 POST /options/strategy（与 agent 的
 * cn_get_option_strategy 同一端点）生成多腿组合，列出期权腿并支持「填进下单面板」
 * （preview 态，不自动下单——用户点提交委托才走双闸）。
 *
 * 与 toolview 卡的区别：toolview 槽是被动展示、无法回调到 T 板下单面板；此处是
 * T 板内自包含预览，规避跨组件桥接。扫描建议仍走 onScanUnderlying（fillComposer）。
 *
 * 本面板只消费 OptionStrategyResult 的强类型字段，不重算任何指标；缺失字段按格容错。
 * 本页技术与行情分析面，不构成投资建议。
 */
import { useState } from 'react'
import type { OptionStrategyLeg, OptionStrategyResult } from '@dshtrading/api'
import type { MarketLocaleKey } from './contract.ts'
import { fetchOptionStrategy } from './api.ts'
import { TEMPLATE_KEY } from './option-vocabulary.ts'
import css from './strategy-preview.module.css'

export type StrategyTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 模板顺序：默认 vertical（纯期权价差，不依赖底仓；covered_call/collar 需 holdingQty）。 */
const TEMPLATES = ['vertical', 'straddle', 'butterfly', 'covered_call', 'collar'] as const
type Template = (typeof TEMPLATES)[number]

function fmtNum(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

export interface StrategyPreviewProps {
  t: StrategyTranslate
  underlyingSymbol: string
  expiryMonth: string
  /** 把推荐腿填进 T 板下单面板（preview 态）。 */
  onLoadLeg: (leg: OptionStrategyLeg) => void
  onClose: () => void
}

export function StrategyPreview(props: StrategyPreviewProps): React.JSX.Element {
  const { t, underlyingSymbol, expiryMonth, onLoadLeg, onClose } = props
  const [template, setTemplate] = useState<Template>('vertical')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OptionStrategyResult | null>(null)

  const generate = (): void => {
    setLoading(true)
    setError(null)
    void fetchOptionStrategy({ underlying: underlyingSymbol, expiryMonth, template })
      .then((res) => {
        if (res.ok) {
          setResult(res.data)
          setError(null)
        } else {
          setResult(null)
          setError(`${res.code}${res.message ? ` · ${res.message}` : ''}`)
        }
      })
      .finally(() => { setLoading(false) })
  }

  // 仅展示期权腿（现货腿不可经 OptionOrderPanel 下单；备兑信息以徽章标注）。
  const optionLegs = result === null ? [] : result.legs.filter((l) => l.kind === 'option')

  return (
    <div className={css.panel} data-dshtrading-strategy-preview="">
      <div className={css.head}>
        <span className={css.title}>{t('options.strategy.title')}</span>
        <button
          type="button"
          className={css.close}
          aria-label={t('options.strategy.close')}
          title={t('options.strategy.close')}
          onClick={onClose}
        >
          {'✕'}
        </button>
      </div>

      <div className={css.controls}>
        <label className={css.tplLabel}>
          {t('options.strategy.template')}
          <select
            className={css.tplSelect}
            value={template}
            onChange={(e) => { setTemplate(e.target.value as Template); setResult(null); setError(null) }}
          >
            {TEMPLATES.map((tp) => (
              <option key={tp} value={tp}>{t(TEMPLATE_KEY[tp])}</option>
            ))}
          </select>
        </label>
        <button type="button" className={css.generate} onClick={generate} disabled={loading}>
          {loading ? t('options.strategy.loading') : t('options.strategy.generate')}
        </button>
      </div>

      {error !== null && (
        <div className={css.error}><span>{t('options.strategy.error')}</span><span className={css.errVal}>{error}</span></div>
      )}

      {result !== null && (
        <div className={css.body}>
          <div className={css.summary}>
            <span>{t('options.strategy.spot')} {fmtNum(result.spot)}</span>
            <span>{t('options.strategy.multiplier')} {result.multiplier}</span>
            <span>
              {t('options.strategy.entry')}
              <span className={css.entryVal}>
                {result.entry.debitCredit < 0
                  ? `${t('options.strategy.debit')} ${fmtNum(Math.abs(result.entry.debitCredit))}`
                  : `${t('options.strategy.credit')} ${fmtNum(result.entry.debitCredit)}`}
              </span>
            </span>
          </div>
          <div className={css.summary}>
            <span>{t('options.strategy.netDelta')} {fmtNum(result.greeks.net.delta)}</span>
            <span>{t('options.strategy.netTheta')} {fmtNum(result.greeks.net.theta)}</span>
            <span>{t('options.strategy.netVega')} {fmtNum(result.greeks.net.vega)}</span>
          </div>
          <div className={css.summary}>
            <span>{t('options.strategy.marginInitial')} {fmtNum(result.margin.totalInitial)}</span>
            {result.margin.note !== '' && <span className={css.note}>{result.margin.note}</span>}
          </div>

          {optionLegs.length === 0
            ? <div className={css.empty}>{t('options.strategy.noLegs')}</div>
            : (
              <table className={css.legs}>
                <thead>
                  <tr>
                    <th>{t('options.strategy.legOption')}</th>
                    <th>{t('options.strategy.legSide')}</th>
                    <th>{t('options.order.quantity')}</th>
                    <th>{t('options.strategy.legType')}</th>
                    <th>{t('options.strike')}</th>
                    <th>{t('options.strategy.legPremium')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {optionLegs.map((leg, i) => (
                    <tr key={leg.code ?? `leg-${i}`}>
                      <td className={css.code}>{leg.code ?? '—'}</td>
                      <td className={leg.side === 'buy' ? css.buy : css.sell}>
                        {leg.side === 'buy' ? t('trade.buy') : t('trade.sell')}
                      </td>
                      <td>{leg.qty}</td>
                      <td>{leg.optionType === 'C' ? t('options.side.call') : t('options.side.put')}</td>
                      <td>{leg.strike !== undefined ? String(leg.strike) : '—'}</td>
                      <td>{leg.premium !== undefined ? fmtNum(leg.premium) : '—'}</td>
                      <td className={css.action}>
                        {leg.covered === true && <span className={css.covered}>{t('options.strategy.legCovered')}</span>}
                        <button
                          type="button"
                          className={css.loadBtn}
                          disabled={leg.code === undefined}
                          onClick={() => { if (leg.code !== undefined) onLoadLeg(leg) }}
                        >
                          {t('options.strategy.loadToBoard')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

          {result.failures !== undefined && result.failures.length > 0 && (
            <div className={css.failures}>
              <span>{t('options.strategy.failures')}</span>
              <ul>
                {result.failures.map((f, i) => (
                  <li key={i}>{f.expiryMonth}: {f.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
