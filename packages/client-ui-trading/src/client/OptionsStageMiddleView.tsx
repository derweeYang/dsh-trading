/**
 * 期权 T 板中栏直达视图（2026-09-12）：把 OptionsStage 从 QuoteStage 期权透镜
 * 升格为 MiddleStage 与行情 / 期权总览 / 期权预测平级的 tab，点 tab 即直达 T 板，
 * 不再先绕到期权总览卡片「进 T 板」。
 *
 * 自取数薄壳：读 selectionStore 拿当前标的 → fetchOptionsUnderlyings 判期权资格
 * → fetchOptionsExpiries / fetchOptionsChain 取数；回调走 stageActions
 * （selectInstrument / switchToQuote / switchToOverview / fillComposer），
 * 与 QuoteStage 透镜同源动作。未选中期权标的（7 只 ETF 之一）时给友好提示。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { OptionChain, OptionExpiryCalendar, OptionUnderlying } from '@dshtrading/api'
import { fetchOptionsUnderlyings, fetchOptionsExpiries, fetchOptionsChain } from './api.ts'
import { colorModeStore } from './color-mode.ts'
import { selectionStore } from './store.ts'
import { OptionsStage, type SelectedOptionLeg } from './OptionsStage.tsx'
import { stageActions, optionsOverviewStore } from './stage-actions.ts'
import type { StageViewProps } from './stage-views.ts'
import css from './options-stage-middle.module.css'

const OPTIONS_LIST_POLL_MS = 60000
const OPTIONS_CHAIN_POLL_MS = 30000

export function OptionsStageMiddleView({ t }: StageViewProps): React.JSX.Element {
  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)
  const instrument = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot).instrument

  const [underlyings, setUnderlyings] = useState<readonly OptionUnderlying[]>([])
  const [expiries, setExpiries] = useState<OptionExpiryCalendar | null>(null)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [chain, setChain] = useState<OptionChain | null>(null)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  // 期权标的名册（本地名册，网关未起也有）：判当前选中标的是否期权合格 + 取名称/乘数。
  useEffect(() => {
    let cancelled = false
    void fetchOptionsUnderlyings()
      .then((res) => { if (!cancelled && res.ok) setUnderlyings(res.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const underlying = useMemo(
    () => (instrument !== null ? underlyings.find(u => u.underlying === instrument.symbol) : undefined),
    [underlyings, instrument],
  )
  const eligible = underlying !== undefined

  // 到期月名册（本地算，网关未起也有）。
  const expiriesRef = useRef('')
  useEffect(() => {
    if (!eligible || instrument === null) { setExpiries(null); return }
    let cancelled = false
    const req = instrument.symbol
    expiriesRef.current = req
    void fetchOptionsExpiries(req)
      .then((res) => { if (!cancelled && expiriesRef.current === req) setExpiries(res.ok ? res.data : null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [eligible, instrument])

  // 选中月纠偏：落地后默认当月；换标的/换季后原选中月不在名册 → 回落第一个。
  useEffect(() => {
    const months = expiries?.months ?? []
    if (months.length === 0) {
      if (selectedMonth !== null) setSelectedMonth(null)
      return
    }
    const first = months[0]
    if (first !== undefined && (selectedMonth === null || !months.some(m => m.expiryMonth === selectedMonth))) {
      setSelectedMonth(first.expiryMonth)
    }
  }, [expiries, selectedMonth])

  // T 板链：仅已选出到期月才拉（网关未起时不空转）；换标的/换月清旧应答。
  const chainRef = useRef('')
  useEffect(() => {
    if (!eligible || instrument === null || selectedMonth === null) {
      setLoaded(false); setChain(null); setFailure(null)
      return
    }
    let cancelled = false
    const req = `${instrument.symbol}:${selectedMonth}`
    chainRef.current = req
    setLoaded(false)
    void fetchOptionsChain(instrument.symbol, selectedMonth)
      .then((res) => {
        if (cancelled || chainRef.current !== req) return
        if (res.ok) { setChain(res.data); setFailure(null) } else { setChain(null); setFailure({ code: res.code, message: res.message }) }
        setLoaded(true)
      })
      .catch(() => { if (!cancelled && chainRef.current === req) { setChain(null); setLoaded(true) } })
    return () => { cancelled = true }
  }, [eligible, instrument, selectedMonth])

  const onViewSpot = (): void => {
    if (instrument !== null) stageActions.current.selectInstrument?.(instrument)
    stageActions.current.switchToQuote?.()
  }
  const onTradeSpot = (): void => {
    if (instrument !== null) stageActions.current.selectInstrument?.(instrument)
    stageActions.current.switchToQuote?.()
  }
  const onBackToOverview = (): void => { stageActions.current.switchToOverview?.() }
  const onSendLegToAgent = stageActions.current.fillComposer !== undefined && instrument !== null
    ? (leg: SelectedOptionLeg): void => {
        const parts: string[] = [
          t('options.agentOrder.head', {
            symbol: instrument.symbol,
            name: underlying?.name ?? instrument.symbol,
            side: t(leg.side === 'call' ? 'options.side.call' : 'options.side.put'),
            strike: leg.strike,
          }),
        ]
        if (leg.last !== undefined) parts.push(t('options.agentOrder.last', { last: leg.last }))
        if (leg.iv !== undefined) parts.push(t('options.agentOrder.iv', { iv: leg.iv }))
        parts.push(t('options.agentOrder.tail'))
        parts.push(t('options.agentOrder.disclaimer'))
        void stageActions.current.fillComposer?.(parts.join(''))
      }
    : undefined
  const onScanUnderlying = stageActions.current.fillComposer !== undefined && instrument !== null
    ? (): void => {
        const cached = optionsOverviewStore.getSnapshot()?.rows.find(r => r.underlying === instrument.symbol)
        const prompt = cached !== undefined
          ? cached.scanPrompt
          : t('options.scan.fallbackPrompt', { symbol: instrument.symbol, name: underlying?.name ?? instrument.symbol })
        void stageActions.current.fillComposer?.(prompt)
      }
    : undefined

  if (instrument === null || !eligible) {
    return (
      <div className={css.root} data-dshtrading-options-stage-middle="">
        <div className={css.hint}>{t('options.stage.middle.emptyHint')}</div>
      </div>
    )
  }

  return (
    <div className={css.root} data-dshtrading-options-stage-middle="">
      <OptionsStage
        t={t}
        months={expiries?.months ?? []}
        selectedMonth={selectedMonth}
        onSelectMonth={setSelectedMonth}
        chain={chain}
        failure={failure}
        loaded={loaded}
        colorMode={colorMode}
        underlyingSymbol={instrument.symbol}
        underlyingName={underlying?.name}
        multiplier={underlying?.multiplier ?? 10000}
        onViewSpot={onViewSpot}
        onTradeSpot={onTradeSpot}
        onSendLegToAgent={onSendLegToAgent}
        onBackToOverview={onBackToOverview}
        onScanUnderlying={onScanUnderlying}
      />
    </div>
  )
}
