/**
 * CN ETF 期权 T 型报价板（2026-09-08 第一期只读面；2026-09-08 期权升格重构后由
 * QuoteStage「现货 ⇄ 期权」对等双透镜的「期权」透镜挂载，与 A 股现货平级）。
 *
 * 形态：ETF 联动操作条（查看标的 / 交易现货 / 把选中合约发给 Agent 下单）+ 到期月
 * 胶囊条（本地算，网关未起也能画）+ T 表（中间行权价、左认购右认沽）。数据全部
 * 来自桥 `GET /dshtrading/api/options/{expiries,chain}`，类型取 `@dshtrading/api`
 * ——不在 client 另造一份（交接契约 docs/options-bridge.md）。
 *
 * **ETF ↔ ETF 期权互联（本期目标）**：
 * - 顶部联动条把期权的「标的 ETF」做实——一键切回现货透镜（onViewSpot）、一键打开
 *   现货交易台（onTradeSpot），使期权分析与 ETF 现货交易闭环；
 * - T 表任意一档（认购/认沽）可点选为待下单合约，经 onSendLegToAgent 把合约要素
 *   交给 Agent 评估下单（dry-run 优先），期权下单链路在客户端即与现货交易打通。
 *
 * 降级纪律：
 * - 未挂 connector-options → 透镜整体不渲染（QuoteStage 的显隐判据），本组件不处理；
 * - TRADING_NETWORK → 提示启动网关；TRADING_NO_DATA → 空态 + 原文 message；
 * - 首个应答在途（loaded=false）→ 留白加载，不闪「不可用」。
 *
 * 本页只读分析，不构成投资建议。
 */
import { useState } from 'react'
import type { OptionChain, OptionExpiryMonth, OptionQuoteRow } from '@dshtrading/api'
import type { ColorMode } from './color-mode.ts'
import type { MarketLocaleKey } from './contract.ts'
import { directionColor, fmtClock, fmtCompact, fmtPercent, fmtPrice } from './format.ts'
import css from './options-stage.module.css'

export type OptionsStageTranslate = (key: MarketLocaleKey) => string

/** 用户在 T 表点选的待下单合约要素（交给 Agent 评估下单，dry-run 优先）。 */
export interface SelectedOptionLeg {
  side: 'call' | 'put'
  strike: number
  last?: number
  iv?: number
}

export interface OptionsStageProps {
  t: OptionsStageTranslate
  /** 标准四季月（本地算，不打网关）。 */
  months: readonly OptionExpiryMonth[]
  /** 当前选中到期月（YYMM）；null = 尚未选出（如名册未落地）。 */
  selectedMonth: string | null
  onSelectMonth: (month: string) => void
  /** T 型报价链；null = 未取到（原因见 failure）。 */
  chain: OptionChain | null
  /** 链取数失败；null = 无错误。 */
  failure: { code: string; message: string } | null
  /** 首个链应答是否已落地（区分「加载中」与「不可用」）。 */
  loaded: boolean
  colorMode: ColorMode
  /** 标的 ETF 代码（用于联动条展示与「查看现货」回跳）。 */
  underlyingSymbol: string
  /** 标的 ETF 名称（联动条展示，缺省回退代码）。 */
  underlyingName?: string
  /** 查看标的现货：切回现货透镜并定位该 ETF（由 QuoteStage 注入）。 */
  onViewSpot: () => void
  /** 交易现货 ETF：打开现货交易台预填该 ETF（由 QuoteStage 注入）。 */
  onTradeSpot: () => void
  /** 把选中合约要素交给 Agent 评估下单（dry-run 优先）；未注入（无 fillComposer）则不渲染按钮。 */
  onSendLegToAgent?: (leg: SelectedOptionLeg) => void
}

/** 行权价并集升序：认购/认沽挂出的档位未必对称（深市静态表尤其）。 */
function strikeOrder(chain: OptionChain): number[] {
  const set = new Set<number>()
  for (const row of chain.calls) set.add(row.strike)
  for (const row of chain.puts) set.add(row.strike)
  return [...set].sort((a, b) => a - b)
}

function rowOf(rows: readonly OptionQuoteRow[], strike: number): OptionQuoteRow | undefined {
  return rows.find(row => row.strike === strike)
}

/**
 * IV 显示：内核 BSM 反解的 sigma 是小数（0.2 = 20%）；链快照回填的 IV 同源。
 * 防御性接纳已乘百的数值（>1 视为百分数，不再放大）。
 */
function fmtIv(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return fmtPercent(value > 1 ? value : value * 100)
}

/** 快照时间（ISO → HH:mm:ss）；解析失败不显示，不拿 Date.now() 冒充。 */
function snapshotClock(snapshotAt: string | undefined): string | undefined {
  if (snapshotAt === undefined) return undefined
  const ms = Date.parse(snapshotAt)
  return Number.isFinite(ms) ? fmtClock(ms) : undefined
}

export function OptionsStage({
  t, months, selectedMonth, onSelectMonth, chain, failure, loaded, colorMode,
  underlyingSymbol, underlyingName, onViewSpot, onTradeSpot, onSendLegToAgent,
}: OptionsStageProps): React.JSX.Element {
  const strikes = chain === null ? [] : strikeOrder(chain)
  const clock = chain === null ? undefined : snapshotClock(chain.snapshotAt)
  /** 用户在 T 表点选的待下单合约（认购/认沽 + 行权价）。 */
  const [selectedLeg, setSelectedLeg] = useState<SelectedOptionLeg | null>(null)

  return (
    <div className={css.root} data-dshtrading-options-stage="">
      {/* ETF ↔ 期权 联动操作条：标的回跳 / 交易现货 / 合约下单（本期互联核心） */}
      <div className={css.actionBar}>
        <button
          type="button"
          className={css.underlyingChip}
          aria-label={t('options.viewSpot')}
          title={t('options.viewSpot')}
          onClick={onViewSpot}
        >
          <label>{t('options.underlying')}</label>
          <span className={css.underlyingName}>{underlyingName ?? underlyingSymbol}</span>
          <span className={css.underlyingCode}>{underlyingSymbol}</span>
        </button>
        <button
          type="button"
          className={css.tradeSpotBtn}
          onClick={onTradeSpot}
        >
          {t('options.tradeSpot')}
        </button>
        <span className={css.spacer} />
        {selectedLeg !== null && (
          <span className={css.legTag}>
            <span>{t('options.legSelected')}</span>
            <strong>{t(selectedLeg.side === 'call' ? 'options.side.call' : 'options.side.put')} @{fmtPrice(selectedLeg.strike)}</strong>
            <button
              type="button"
              className={css.legClear}
              aria-label={t('options.leg.clear')}
              title={t('options.leg.clear')}
              onClick={() => { setSelectedLeg(null) }}
            >
              ✕
            </button>
          </span>
        )}
        <button
          type="button"
          className={css.sendLegBtn}
          disabled={selectedLeg === null || onSendLegToAgent === undefined}
          onClick={() => { if (selectedLeg !== null && onSendLegToAgent !== undefined) onSendLegToAgent(selectedLeg) }}
        >
          {t('options.sendLegToAgent')}
        </button>
      </div>

      {/* 到期月胶囊：本地算，网关未起也画得出来 */}
      <div className={css.expiryBar} role="tablist" aria-label="option expiry months">
        {months.length === 0
          ? <span className={css.expiryHint}>{t('options.loading')}</span>
          : months.map(month => (
            <button
              key={month.expiryMonth}
              type="button"
              role="tab"
              aria-selected={month.expiryMonth === selectedMonth}
              className={css.expiryPill}
              data-active={month.expiryMonth === selectedMonth ? 'true' : undefined}
              title={month.expiryDate}
              onClick={() => { onSelectMonth(month.expiryMonth) }}
            >
              {month.expiryMonth}
            </button>
          ))}
      </div>

      {/* 状态行：标的现价 / 快照时间 / 数据源（字段缺省即隐藏，不补占位） */}
      {chain !== null && (
        <div className={css.metaRow}>
          {chain.spot !== undefined && (
            <span className={css.meta}><label>{t('options.spot')}</label>{fmtPrice(chain.spot)}</span>
          )}
          {clock !== undefined && (
            <span className={css.meta}><label>{t('options.snapshotAt')}</label>{clock}</span>
          )}
          <span className={css.meta}><label>{t('options.source')}</label>{String(chain.source)}</span>
          <span className={css.disclaimer}>{t('options.hint')}</span>
        </div>
      )}

      {/* 分诊：网络 → 无数据 → 加载中 → 不可用 → 空合约 → T 表 */}
      {failure !== null && failure.code === 'TRADING_NETWORK'
        ? <div className={css.notice}>{t('options.network')}</div>
        : failure !== null && failure.code === 'TRADING_NO_DATA'
          ? <div className={css.notice}>{t('options.noData')}</div>
          : !loaded
            ? <div className={css.notice}>{t('options.loading')}</div>
            : chain === null
              ? <div className={css.notice}>{t('options.unavailable')}</div>
              : strikes.length === 0
                ? <div className={css.notice}>{t('options.empty')}</div>
                : (
                  <div className={css.tableWrap}>
                    <table className={css.table}>
                      <thead>
                        <tr>
                          <th colSpan={4} className={css.sideHead}>{t('options.calls')}</th>
                          <th className={css.strikeHead}>{t('options.strike')}</th>
                          <th colSpan={4} className={css.sideHead}>{t('options.puts')}</th>
                        </tr>
                        <tr className={css.colHead}>
                          <th>{t('options.iv')}</th>
                          <th>{t('options.volume')}</th>
                          <th>{t('options.change')}</th>
                          <th>{t('options.last')}</th>
                          <th className={css.strikeHead} />
                          <th>{t('options.last')}</th>
                          <th>{t('options.change')}</th>
                          <th>{t('options.volume')}</th>
                          <th>{t('options.iv')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strikes.map(strike => {
                          const call = rowOf(chain.calls, strike)
                          const put = rowOf(chain.puts, strike)
                          const callPct = call?.changePct
                          const putPct = put?.changePct
                          const callSelected = selectedLeg?.side === 'call' && selectedLeg.strike === strike
                          const putSelected = selectedLeg?.side === 'put' && selectedLeg.strike === strike
                          const selectCall = (): void => {
                            setSelectedLeg({ side: 'call', strike, last: call?.last ?? call?.prevSettle, iv: call?.impliedVol })
                          }
                          const selectPut = (): void => {
                            setSelectedLeg({ side: 'put', strike, last: put?.last ?? put?.prevSettle, iv: put?.impliedVol })
                          }
                          return (
                            <tr key={strike} className={css.row}>
                              <td className={`${css.iv} ${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`} onClick={selectCall}>{fmtIv(call?.impliedVol)}</td>
                              <td className={`${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`} onClick={selectCall}>{call?.volume === undefined ? '—' : fmtCompact(call.volume)}</td>
                              <td
                                className={`${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`}
                                onClick={selectCall}
                                style={callPct === undefined ? undefined : { color: directionColor(callPct, colorMode) }}
                              >
                                {fmtPercent(callPct)}
                              </td>
                              <td className={`${css.last} ${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`} onClick={selectCall}>{fmtPrice(call?.last ?? call?.prevSettle)}</td>
                              <td className={css.strikeCell}>{fmtPrice(strike)}</td>
                              <td className={`${css.last} ${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`} onClick={selectPut}>{fmtPrice(put?.last ?? put?.prevSettle)}</td>
                              <td
                                className={`${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`}
                                onClick={selectPut}
                                style={putPct === undefined ? undefined : { color: directionColor(putPct, colorMode) }}
                              >
                                {fmtPercent(putPct)}
                              </td>
                              <td className={`${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`} onClick={selectPut}>{put?.volume === undefined ? '—' : fmtCompact(put.volume)}</td>
                              <td className={`${css.iv} ${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`} onClick={selectPut}>{fmtIv(put?.impliedVol)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
    </div>
  )
}
