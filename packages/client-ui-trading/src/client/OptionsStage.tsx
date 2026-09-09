/**
 * CN ETF 期权 T 型报价板（2026-09-08 第一期只读面；2026-09-08 期权升格重构后由
 * QuoteStage「现货 ⇄ 期权」对等双透镜的「期权」透镜挂载，与 A 股现货平级）。
 *
 * 形态：ETF 联动操作条（查看标的 / 交易现货 / 底仓徽章）+ 到期月胶囊条（本地算，
 * 网关未起也能画）+ T 表（中间行权价、左认购右认沽；spot 回填时 ATM 高亮 +
 * 实/虚值分色）+ 合约点选下单面板（阶段 3 交易面）+ 期权持仓条（只读）。
 * 数据全部来自桥 `GET/POST /dshtrading/api/options/*`，类型取 `@dshtrading/api`
 * ——不在 client 另造一份（交接契约 docs/options-bridge.md）。
 *
 * **交易面语义（阶段 3）**：
 * - 下单默认请求实盘（dryRun: false），安全由服务缝双闸 fail-closed 兜底；
 *   闸门拒绝（TRADING_LIVE_TRADING_DISABLED 等）原文展示，不伪造 dry-run 成功；
 * - 回执 premiumAmount 已换算为权利金金额（元），直接显示，不再乘 multiplier；
 * - 义务仓（sell+open）保证金预估经 POST /options/strategy 的 margin 块
 *   （单腿 legs=[{kind:'option',side,qty,code}]），失败降级为「以回执为准」；
 * - 底仓 heldQty（统一资产台账聚合）→ 备兑可开张数 = floor(heldQty / multiplier)，
 *   认购腿上一键预填备兑开仓（sell + open + 张数）。
 *
 * 降级纪律：
 * - 未挂 connector-options → 透镜整体不渲染（QuoteStage 的显隐判据），本组件不处理；
 * - TRADING_NETWORK → 提示启动网关；TRADING_NO_DATA → 空态 + 原文 message；
 * - 首个应答在途（loaded=false）→ 留白加载，不闪「不可用」。
 *
 * 本页技术与行情分析面，不构成投资建议。
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  OptionChain, OptionExpiryMonth, OptionIntradayBoxRow, OptionOrder, OptionPosition, OptionQuoteRow,
} from '@dshtrading/api'
import type { ColorMode } from './color-mode.ts'
import type { MarketLocaleKey } from './contract.ts'
import { cancelOptionOrder, fetchOptionPositions, fetchOptionStrategy, placeOptionOrder } from './api.ts'
import { directionColor, fmtClock, fmtCompact, fmtPercent, fmtPrice } from './format.ts'
import { usePoll } from './usePoll.ts'
import { REGIME_KEY, SESSION_REASON_KEY, TEMPLATE_KEY } from './option-vocabulary.ts'
import css from './options-stage.module.css'

export type OptionsStageTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 用户在 T 表点选的待下单合约要素（下单主键 = 长代码 code）。 */
export interface SelectedOptionLeg {
  /** 期权长代码（规范主键，如 510050C2609M02850）。 */
  code: string
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
  underlyingName?: string | undefined
  /** 合约乘数（1 张 = multiplier 份 ETF；名册行带回，缺省 10000）。 */
  multiplier: number
  /** 底仓份额（统一资产台账聚合；无持仓缺省——备兑徽章与快捷预填的依据）。 */
  heldQty?: number | undefined
  /** 查看标的现货：切回现货透镜并定位该 ETF（由 QuoteStage 注入）。 */
  onViewSpot: () => void
  /** 交易现货 ETF：打开现货交易台预填该 ETF（由 QuoteStage 注入）。 */
  onTradeSpot: () => void
  /** 把选中合约要素交给 Agent 评估下单（dry-run 优先）；未注入（无 fillComposer）则不渲染按钮。 */
  onSendLegToAgent?: (leg: SelectedOptionLeg) => void
  /**
   * 本桶 5 分钟箱体（WB-3）。由上层给：优先闭环 `loop.latest.forecast`，闭环没有
   * 该标的行才降级 `GET /options/intraday-box`。本组件**不自己算箱体**——打分与
   * 校准在宿主/kit 侧，前端复制一份必然漂移。
   */
  forecast?: OptionIntradayBoxRow | null | undefined
  /** 返回九标的总览（保留排序状态；由 QuoteStage 持有 sort）。 */
  onBackToOverview?: () => void
  /** 用该标的的 scanPrompt 预填 composer（只填不发；未注入 fillComposer 则缺席）。 */
  onScanUnderlying?: (() => void) | undefined
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

/** 持仓/保证金等金额（元，千分位整数或两位小数）。 */
function fmtAmount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

// 期权持仓轮询：签名端点 + 个人账户面，15s 对齐交易台节奏（issue #40 同款）。
const OPTION_POSITIONS_POLL_MS = 15000

export function OptionsStage({
  t, months, selectedMonth, onSelectMonth, chain, failure, loaded, colorMode,
  underlyingSymbol, underlyingName, multiplier, heldQty, onViewSpot, onTradeSpot, onSendLegToAgent,
  forecast, onBackToOverview, onScanUnderlying,
}: OptionsStageProps): React.JSX.Element {
  const strikes = chain === null ? [] : strikeOrder(chain)
  const clock = chain === null ? undefined : snapshotClock(chain.snapshotAt)
  /** 用户在 T 表点选的待下单合约（认购/认沽 + 行权价 + 长代码）。 */
  const [selectedLeg, setSelectedLeg] = useState<SelectedOptionLeg | null>(null)

  // ATM 行（spot 回填时 |strike−spot| 最小档）：行级高亮 + 两侧实/虚值分色判据。
  const spot = chain?.spot
  const atmStrike = useMemo(() => {
    if (spot === undefined || strikes.length === 0) return undefined
    let best = strikes[0] ?? 0
    for (const strike of strikes) {
      if (Math.abs(strike - spot) < Math.abs(best - spot)) best = strike
    }
    return best
  }, [spot, strikes])

  // 底仓 → 备兑可开张数（floor(heldQty/multiplier)；不足 1 张不显示快捷入口）。
  const coveredLots = heldQty !== undefined && multiplier > 0 ? Math.floor(heldQty / multiplier) : 0

  // ── 期权持仓（只读，阶段 3）────────────────────────────────────
  const [positions, setPositions] = useState<readonly OptionPosition[] | null>(null)
  const [positionsAvailable, setPositionsAvailable] = useState(true)
  /** 下单/撤单后立即重拉（usePoll deps 变化即触发一次）。 */
  const [positionsTick, setPositionsTick] = useState(0)
  const underlying6 = underlyingSymbol.replace(/\.(SH|SZ)$/i, '')
  usePoll(async () => {
    const res = await fetchOptionPositions()
    if (res.ok) {
      setPositions(res.data)
      setPositionsAvailable(true)
    } else {
      setPositions(null)
      setPositionsAvailable(false)
    }
  }, OPTION_POSITIONS_POLL_MS, [positionsTick])
  const myPositions = useMemo(
    () => (positions ?? []).filter(row => row.underlying === underlying6),
    [positions, underlying6],
  )

  return (
    <div className={css.root} data-dshtrading-options-stage="">
      {/* ETF ↔ 期权 联动操作条：标的回跳 / 交易现货 / 底仓徽章 / 合约下单（互联核心） */}
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
        {/* 底仓徽章（阶段 4 互联）：统一资产台账聚合的 ETF 持仓 → 备兑可开张数。 */}
        {heldQty !== undefined && coveredLots > 0 && (
          <span className={css.heldBadge} title={t('options.held.badge', { qty: String(heldQty), n: String(coveredLots) })}>
            {t('options.held.badge', { qty: String(heldQty), n: String(coveredLots) })}
          </span>
        )}
        <span className={css.spacer} />
        {onBackToOverview !== undefined && (
          <button
            type="button"
            className={css.backBtn}
            onClick={onBackToOverview}
          >
            {t('options.overview.back')}
          </button>
        )}
        {onScanUnderlying !== undefined && (
          <button
            type="button"
            className={css.scanBtn}
            onClick={onScanUnderlying}
          >
            {t('options.overview.scanRow')}
          </button>
        )}
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

      {/* 5 分钟箱体条（WB-3）：只读展示。no_trade 只出示原因，不画假箱沿；
          候选模板是标签，不是下单按钮——下单仍走下面的点选 + 双闸。 */}
      {forecast !== undefined && forecast !== null && (
        <div className={css.boxBar}>
          <span className={css.boxLabel}>{t('options.box.title')}</span>
          {forecast.regime !== 'no_trade' && (
            <span className={css.boxTag} data-kind={forecast.regime}>{t(REGIME_KEY[forecast.regime])}</span>
          )}
          {forecast.boxLow !== undefined && forecast.boxHigh !== undefined
            ? (
              <span className={css.boxRange}>
                {t('options.cycle.box', { low: fmtPrice(forecast.boxLow), high: fmtPrice(forecast.boxHigh) })}
              </span>
            )
            : <span className={css.boxMuted}>{t('options.box.noTrade')}</span>}
          {forecast.regime === 'no_trade' && forecast.noTradeReason !== undefined && (
            <span className={css.boxMuted}>{t(SESSION_REASON_KEY[forecast.noTradeReason])}</span>
          )}
          {forecast.vwap !== undefined && (
            <span className={css.boxMuted}>{t('options.box.vwap')} {fmtPrice(forecast.vwap)}</span>
          )}
          {forecast.sigma1 !== undefined && (
            <span className={css.boxMuted}>{t('options.box.sigma')} {forecast.sigma1.toFixed(4)}</span>
          )}
          {forecast.atr14 !== undefined && (
            <span className={css.boxMuted}>{t('options.box.atr')} {fmtPrice(forecast.atr14)}</span>
          )}
          {forecast.candidates.map(candidate => (
            <span key={candidate.template} className={css.boxTag} title={candidate.reason}>
              {t(TEMPLATE_KEY[candidate.template])}
            </span>
          ))}
        </div>
      )}

      {/* 状态行：标的现价 / 快照时间 / 数据源 / 期权持仓（字段缺省即隐藏，不补占位） */}
      {chain !== null && (
        <div className={css.metaRow}>
          {chain.spot !== undefined && (
            <span className={css.meta}><label>{t('options.spot')}</label>{fmtPrice(chain.spot)}</span>
          )}
          {clock !== undefined && (
            <span className={css.meta}><label>{t('options.snapshotAt')}</label>{clock}</span>
          )}
          <span className={css.meta}><label>{t('options.source')}</label>{String(chain.source)}</span>
          <span className={css.meta}>
            <label>{t('options.positions')}</label>
            {!positionsAvailable
              ? t('options.positions.unavailable')
              : myPositions.length === 0
                ? t('options.positions.empty')
                : myPositions.map(row => (
                  <span
                    key={row.symbol}
                    className={css.positionChip}
                    data-side={row.quantity < 0 ? 'short' : 'long'}
                    title={`${row.symbol} · ${t(row.quantity < 0 ? 'options.positions.short' : 'options.positions.long')}${row.marginOccupied !== undefined ? ` · ${t('options.order.marginEst')}: ${fmtAmount(row.marginOccupied)}` : ''}`}
                  >
                    {row.optionType}{fmtPrice(row.strike)}×{row.quantity}
                  </span>
                ))}
          </span>
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
                          // 实/虚值（spot 回填时分色；spot 缺席 → undefined 不分色）：
                          // 认购 strike<spot 为实值、认沽 strike>spot 为实值（行权有利）。
                          const callMoney = spot === undefined || strike === spot ? undefined : strike < spot ? 'itm' : 'otm'
                          const putMoney = spot === undefined || strike === spot ? undefined : strike > spot ? 'itm' : 'otm'
                          // exactOptionalPropertyTypes：last/iv 缺席整键省略，不传 undefined。
                          const selectCall = (): void => {
                            const last = call?.last ?? call?.prevSettle
                            const iv = call?.impliedVol
                            setSelectedLeg({
                              code: call?.code ?? `${chain.underlying}C${chain.expiryMonth}M${String(Math.round(strike * 1000)).padStart(5, '0')}`,
                              side: 'call', strike,
                              ...(last !== undefined ? { last } : {}), ...(iv !== undefined ? { iv } : {}),
                            })
                          }
                          const selectPut = (): void => {
                            const last = put?.last ?? put?.prevSettle
                            const iv = put?.impliedVol
                            setSelectedLeg({
                              code: put?.code ?? `${chain.underlying}P${chain.expiryMonth}M${String(Math.round(strike * 1000)).padStart(5, '0')}`,
                              side: 'put', strike,
                              ...(last !== undefined ? { last } : {}), ...(iv !== undefined ? { iv } : {}),
                            })
                          }
                          return (
                            <tr key={strike} className={css.row} data-atm={strike === atmStrike ? 'true' : undefined}>
                              <td className={`${css.iv} ${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`} data-moneyness={callMoney} onClick={selectCall}>{fmtIv(call?.impliedVol)}</td>
                              <td className={`${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`} data-moneyness={callMoney} onClick={selectCall}>{call?.volume === undefined ? '—' : fmtCompact(call.volume)}</td>
                              <td
                                className={`${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`}
                                data-moneyness={callMoney}
                                onClick={selectCall}
                                style={callPct === undefined ? undefined : { color: directionColor(callPct, colorMode) }}
                              >
                                {fmtPercent(callPct)}
                              </td>
                              <td className={`${css.last} ${css.selectable}${callSelected ? ` ${css.cellSelected}` : ''}`} data-moneyness={callMoney} onClick={selectCall}>{fmtPrice(call?.last ?? call?.prevSettle)}</td>
                              <td className={css.strikeCell}>{fmtPrice(strike)}</td>
                              <td className={`${css.last} ${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`} data-moneyness={putMoney} onClick={selectPut}>{fmtPrice(put?.last ?? put?.prevSettle)}</td>
                              <td
                                className={`${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`}
                                data-moneyness={putMoney}
                                onClick={selectPut}
                                style={putPct === undefined ? undefined : { color: directionColor(putPct, colorMode) }}
                              >
                                {fmtPercent(putPct)}
                              </td>
                              <td className={`${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`} data-moneyness={putMoney} onClick={selectPut}>{put?.volume === undefined ? '—' : fmtCompact(put.volume)}</td>
                              <td className={`${css.iv} ${css.selectable}${putSelected ? ` ${css.cellSelected}` : ''}`} data-moneyness={putMoney} onClick={selectPut}>{fmtIv(put?.impliedVol)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

      {/* 下单面板（选中合约后出现；阶段 3 交易面） */}
      {selectedLeg !== null && (
        <OptionOrderPanel
          t={t}
          leg={selectedLeg}
          multiplier={multiplier}
          underlying={underlying6}
          coveredLots={selectedLeg.side === 'call' ? coveredLots : 0}
          onPlaced={() => { setPositionsTick(tick => tick + 1) }}
        />
      )}
    </div>
  )
}

/* ── 期权下单面板（阶段 3）────────────────────────────────────────── */

function OptionOrderPanel(props: {
  t: OptionsStageTranslate
  leg: SelectedOptionLeg
  multiplier: number
  /** 6 位 ETF 代码（strategy 保证金预估的 underlying）。 */
  underlying: string
  /** 备兑可开张数（仅认购腿传入 >0；0 = 不显示快捷入口）。 */
  coveredLots: number
  onPlaced: () => void
}): React.JSX.Element {
  const { t, leg, multiplier, underlying, coveredLots, onPlaced } = props
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [offset, setOffset] = useState<'open' | 'close'>('open')
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit')
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState(leg.last !== undefined ? String(leg.last) : '')
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<OptionOrder | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)

  const qtyNumber = Number(qty)
  const qtyValid = Number.isInteger(qtyNumber) && qtyNumber > 0
  const priceNumber = Number(price)
  const limitPriceValid = orderType === 'market' || (Number.isFinite(priceNumber) && priceNumber > 0)

  // 换合约：价格初值跟随最新价（上一合约的输入不留残影），回执/错误清场。
  useEffect(() => {
    setPrice(leg.last !== undefined ? String(leg.last) : '')
    setReceipt(null)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg.code])

  // 预估权利金：limit 用委托价 × 张数 × 乘数（回执 premiumAmount 同式换算）；
  // market 委托价未知 → 参考最新价估值，标注口径。
  const premiumEst = qtyValid && limitPriceValid
    ? (orderType === 'market'
        ? (leg.last !== undefined ? leg.last : NaN)
        : priceNumber) * qtyNumber * multiplier
    : NaN

  // 义务仓（sell+open）保证金预估：POST /options/strategy 单腿 margin 块
  // （沪深 ETF 标准 12%/7%；网关未起/计算失败 → null 显示「以回执为准」）。
  const [marginEst, setMarginEst] = useState<number | null>(null)
  useEffect(() => {
    if (side !== 'sell' || offset !== 'open' || !qtyValid) {
      setMarginEst(null)
      return
    }
    let cancelled = false
    void fetchOptionStrategy({
      underlying,
      legs: [{ kind: 'option', side: 'sell', qty: qtyNumber, code: leg.code }],
    }).then((res) => {
      if (!cancelled) setMarginEst(res.ok ? res.data.margin.totalInitial : null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg.code, side, offset, qty, underlying])

  const submit = (): void => {
    if (!qtyValid || !limitPriceValid || submitting) return
    setSubmitting(true)
    setReceipt(null)
    setError(null)
    void placeOptionOrder({
      symbol: leg.code,
      side,
      offset,
      orderType,
      quantity: qtyNumber,
      ...(orderType === 'limit' ? { price: priceNumber } : {}),
    }).then((res) => {
      if (res.order !== undefined) {
        setReceipt(res.order)
        onPlaced()
      } else if (res.error !== undefined) {
        setError(res.error)
      }
    }).finally(() => { setSubmitting(false) })
  }

  return (
    <div className={css.orderPanel} data-dshtrading-option-order="">
      <div className={css.orderHead}>
        <span className={css.orderTitle}>{t('options.order.title')}</span>
        <code className={css.orderCode}>{leg.code}</code>
        {/* 备兑快捷（认购腿 + 底仓足 1 张）：预填 sell+open+满额张数。 */}
        {coveredLots > 0 && (
          <button
            type="button"
            className={css.coverBtn}
            onClick={() => { setSide('sell'); setOffset('open'); setQty(String(coveredLots)) }}
          >
            {t('options.held.cover', { n: String(coveredLots) })}
          </button>
        )}
      </div>
      <div className={css.orderForm}>
        <div className={css.orderToggle} role="tablist" aria-label="order side">
          <button type="button" role="tab" aria-selected={side === 'buy'} className={css.orderOpt} data-active={side === 'buy' ? 'true' : undefined} onClick={() => { setSide('buy') }}>{t('trade.buy')}</button>
          <button type="button" role="tab" aria-selected={side === 'sell'} className={css.orderOpt} data-active={side === 'sell' ? 'true' : undefined} onClick={() => { setSide('sell') }}>{t('trade.sell')}</button>
        </div>
        <div className={css.orderToggle} role="tablist" aria-label="order offset">
          <button type="button" role="tab" aria-selected={offset === 'open'} className={css.orderOpt} data-active={offset === 'open' ? 'true' : undefined} onClick={() => { setOffset('open') }}>{t('options.order.offset.open')}</button>
          <button type="button" role="tab" aria-selected={offset === 'close'} className={css.orderOpt} data-active={offset === 'close' ? 'true' : undefined} onClick={() => { setOffset('close') }}>{t('options.order.offset.close')}</button>
        </div>
        <div className={css.orderToggle} role="tablist" aria-label="order type">
          <button type="button" role="tab" aria-selected={orderType === 'limit'} className={css.orderOpt} data-active={orderType === 'limit' ? 'true' : undefined} onClick={() => { setOrderType('limit') }}>{t('trade.limit')}</button>
          <button type="button" role="tab" aria-selected={orderType === 'market'} className={css.orderOpt} data-active={orderType === 'market' ? 'true' : undefined} onClick={() => { setOrderType('market') }}>{t('trade.market')}</button>
        </div>
        <label className={css.orderField}>
          <span>{t('options.order.quantity')}</span>
          <input
            inputMode="numeric"
            value={qty}
            onChange={(e) => { setQty(e.target.value) }}
            aria-invalid={!qtyValid}
          />
          <em>{t('options.order.unit')}</em>
        </label>
        {orderType === 'limit' && (
          <label className={css.orderField}>
            <span>{t('trade.price')}</span>
            <input
              inputMode="decimal"
              placeholder="0.0001"
              value={price}
              onChange={(e) => { setPrice(e.target.value) }}
            />
            <em>¥</em>
          </label>
        )}
        <span className={css.orderEst}>
          <label>{t('options.order.premiumEst')}</label>
          {Number.isFinite(premiumEst) ? `¥${fmtAmount(premiumEst)}` : '—'}
        </span>
        {side === 'sell' && offset === 'open' && (
          <span className={css.orderEst} title={t('options.order.marginEst')}>
            <label>{t('options.order.marginEst')}</label>
            {marginEst !== null ? `¥${fmtAmount(marginEst)}` : t('options.order.marginNa')}
          </span>
        )}
        <button
          type="button"
          className={css.orderSubmit}
          disabled={submitting || !qtyValid || !limitPriceValid}
          onClick={submit}
        >
          {submitting ? t('options.order.submitting') : t('options.order.submit')}
        </button>
      </div>
      {/* 回执 / 拒绝原文（双闸拒绝 TRADING_LIVE_TRADING_DISABLED 原文展示 + 开闸提示）。 */}
      {receipt !== null && (
        <div className={css.orderReceipt} data-state="ok">
          {t('options.order.placed')} · {t(receipt.dryRun ? 'options.order.dryRunTag' : 'options.order.liveTag')} · ID {receipt.id}
          {receipt.premiumAmount !== undefined && <> · {t('options.order.premiumAmount')} ¥{fmtAmount(receipt.premiumAmount)}</>}
        </div>
      )}
      {error !== null && (
        <div className={css.orderReceipt} data-state="error">
          {t('options.order.rejected')}: {error.code}: {error.message}
          {error.code === 'TRADING_LIVE_TRADING_DISABLED' && <> ({t('options.order.gateHint')})</>}
        </div>
      )}
      {!qtyValid && qty !== '' && <div className={css.orderReceipt} data-state="error">{t('options.order.qtyInvalid')}</div>}
    </div>
  )
}

/** 撤单句柄（导出供持仓/委托列表复用；当前面板回执内联，暂无独立挂单列表）。 */
export async function cancelOptionOrderAndRefresh(orderId: string, symbol?: string): Promise<boolean> {
  return cancelOptionOrder(orderId, symbol)
}
