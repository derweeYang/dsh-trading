/**
 * 行情面板主体（中栏 quote 视图）：富途牛牛视觉风格。
 * 顶部报价头 + K线图 + 周期胶囊条 + 技术指标选择器 +
 * 主图指标读数行（副图指标读数在 TvChart 各自 pane 内）+
 * 底部横向指标快捷词条带 + 底部市场指数状态栏。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  fetchKlines, fetchTickers, fetchOrderbook, fetchRecentTrades,
  fetchTradePositions, fetchTradeBalances, fetchTradeOpenOrders, fetchTradeFills, placeGuiOrder,
  fetchOptionsUnderlyings, fetchOptionsExpiries, fetchOptionsChain, fetchOptionsResolve,
  fetchOptionsOverview, fetchOptionsCycleLoop, fetchOptionsIntradayBox,
  type TradeRowsReason,
} from './api.ts'
import { setHoldingsPanelOpen } from './holdings-store.ts'
import { tradeModeStore, writeTradeMode } from './trade-mode-store.ts'
import { TvChart, toBar, toVolume } from './TvChart.tsx'
import type { TvChartCapture, TvIndicatorGroup } from './TvChart.tsx'
import { composeQuoteMessage } from './compose-quote.ts'
import { composeQuoteDataSection, type QuoteDataSectionCopy } from './compose-quote-data.ts'
import type { QuoteMessageCopy } from './compose-quote.ts'
import type { SendImageInput, FillComposerFn } from './fill-composer.ts'
import { FundamentalsStage } from './FundamentalsStage.tsx'
import { OptionsStage, type SelectedOptionLeg } from './OptionsStage.tsx'
import { OptionsOverview } from './OptionsOverview.tsx'
import { OptionsCycleLoop } from './OptionsCycleLoop.tsx'
import { OrderbookPane } from './OrderbookPane.tsx'
import { OrderPanel } from './OrderPanel.tsx'
import { paperTradingStore } from './paper-trading-store.ts'
import { computeRangeStats } from './range-stats.ts'
import { IconChevronDown, IconIndicators, IconSend } from './icons.tsx'
import type { MarketLocaleKey } from './contract.ts'
import {
  INTRADAY_INTERVALS, changePercent, directionColor,
  fmtChange, fmtClock, fmtCompact, fmtPercent, fmtPrice, scaleLocaleOf,
} from './format.ts'
import { indicators, isCustomIndicator } from './indicator-registry.ts'
import type { IndicatorDefinition, IndicatorInstance } from '@dshtrading/indicators'
import type {
  OptionChain, OptionCycleLoop, OptionExpiryCalendar, OptionIntradayBoxRow, OptionOverview,
  OptionOverviewRow, OptionOverviewSort, OptionUnderlying,
} from '@dshtrading/api'
import { effectiveInstanceParams, isInstanceVisibleOn, symbolScopeKey } from '@dshtrading/indicators'
import { MARKET_INTERVALS } from './store.ts'
import type { SelectionState } from './store.ts'
import type { ChartState } from './chart-state.ts'
import type { AccountBalance, Instrument, Order, Orderbook, Position, TradeFill, TradeTick } from './types.ts'
import { colorModeStore } from './color-mode.ts'
import { MARKET_INDICES, getMarketSessionStatus } from './market-status.ts'
import type { Kline, MarketId, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import { fetchNews, fetchFundamentals } from './api.ts'
import { composeResearchSection } from './compose-research.ts'
import type { ClientNewsItem } from './api.ts'
import { NewsFeedPane } from './NewsFeedPane.tsx'
import { MarkerTooltip } from './MarkerTooltip.tsx'
import type { MarkerHoverInfo } from './TvChart.tsx'
import { createMarkerStateStore } from './marker-state.ts'
import { isAnnouncementSource } from './news-source.ts'
import type { ChartSignalMarkerInput, ChartKnowledgeMarkerInput } from './TvChart.tsx'
import css from './quote-stage.module.css'

const INTERVAL_KEY_PREFIX = 'dshtrading.interval.'
const ORDERBOOK_OPEN_KEY = 'dshtrading.orderbook.open'
const TRADE_DESK_OPEN_KEY = 'dshtrading.tradeDesk.open'
const TICKER_POLL_MS = 5000
const KLINE_RESYNC_MS = 30000
// 盘口/分笔轮询（issue #39）：竖栏打开才拉；一次刷新 = depth + trades 两请求，
// 4s 在「盯盘时效」与公共端点限频之间取衡。
const ORDERBOOK_POLL_MS = 4000
// 交易台只读轮询（issue #40）：15s 慢节奏（签名端点 + 个人账户面，无盯盘时效要求）。
const TRADE_DESK_POLL_MS = 15000
// CN ETF 期权（2026-09-08 第一期只读面）：名册与到期月是连接器本地静态算
// （不打网关），10min 足够；T 板链 30s 对齐 ticker 节奏，且仅「期权」页签
// 激活时才拉——网关未起时不空转（契约见 docs/options-bridge.md）。
const OPTIONS_LIST_POLL_MS = 600000
const OPTIONS_CHAIN_POLL_MS = 30000
// 九标的总览（2026-09-09 WB-1）：桥侧聚合 9×(ticker + 日K)，比单标的重一个量级 →
// 60s，且仅在期权透镜停在总览页时拉（T 板页靠缓存，不重复打上游）。
const OPTIONS_OVERVIEW_POLL_MS = 60000
// 5 分钟闭环（WB-6）：宿主每 30s 已对齐一次桶，页面 30s 跟上即可；再快只是重读内存环。
const OPTIONS_CYCLE_LOOP_POLL_MS = 30000
// 盘中周期 K 线根数（曾按市场区分 crypto 300 / 其余 500；市场收敛后统一 500）。
// 日 K 深度需求由 1d 分支单独走 DAILY_LIMIT。
const KLINE_LIMIT_DEFAULT = 500
// 日 K（头部参考 + 日线图表）：750 根 ≈ 三年交易日；OKX 超出单请求 300 的部分由连接器 after 游标翻页补足。
const DAILY_LIMIT = 750

const INTERVAL_KEY: Record<string, MarketLocaleKey> = {
  '1m': 'interval.1m',
  '3m': 'interval.3m',
  '5m': 'interval.5m',
  '10m': 'interval.10m',
  '15m': 'interval.15m',
  '30m': 'interval.30m',
  '1h': 'interval.1h',
  '4h': 'interval.4h',
  '1d': 'interval.1d',
  '1w': 'interval.1w',
  '1M': 'interval.1M',
}

export type Translate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export type UseStoreState<TState> = <TSelected>(selector: (state: TState) => TSelected) => TSelected

export interface QuoteStageProps {
  t: Translate
  useSelection: UseStoreState<SelectionState>
  useChart: UseStoreState<ChartState>
  toggleIndicator: (id: string) => void
  setIndicatorParams: (id: string, params: Record<string, number>, scopeKey?: string) => void
  /**
   * 按标的可见性（symbol visibility）：visible=false 记隐藏、true 清该标的隐藏。
   * scopeKey = `${market}:${symbol}`；缺省（无聚焦标的）由 shell 忽略——调用方
   * 在该情形应退回 toggleIndicator 全局语义。
   */
  setIndicatorVisible: (id: string, visible: boolean, scopeKey?: string) => void
  /** 全局移除：卸载所有标的上的该指标实例（原 togglePreset 全局关语义）。 */
  removeIndicator: (id: string) => void
  /** 删除自定义指标（issue #30 删除入口；仅自定义行渲染按钮）。 */
  deleteIndicator: (id: string) => Promise<boolean>
  /**
   * 切换全局标的（2026-09-09 WB-1）：期权总览点行 → resolve → 切到该 ETF 现货，
   * T 板数据按全局 symbol 取，所以必须改选择而不是只在本地记一个 underlying。
   * 未注入（宿主未接该面）时总览行点击不跳转——退化为「只可看、不可进」。
   */
  selectInstrument?: (instrument: Instrument) => void
  /** 行情上下文 → 会话输入框（只填入不发送；shell 注入，缺席时按钮不渲染）。 */
  fillComposer?: FillComposerFn
}

/** 市场收敛后唯一市场 cn（曾为四市场推断；符号形态判断保留作规范化注释参考）。 */
function inferMarketFromSymbol(symbol?: string): MarketId | undefined {
  if (!symbol) return undefined
  return 'cn'
}

type SendState = 'idle' | 'sending' | 'sent' | 'error'

/** 信号 reason 的币种符号（市场收敛后人民币）。 */
const CURRENCY_SYMBOL: Record<MarketId, string> = { cn: '¥' }

export function QuoteStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, setIndicatorVisible, removeIndicator, deleteIndicator, selectInstrument, fillComposer }: QuoteStageProps) {
  const instrument = useSelection(value => value.instrument)
  const market: MarketId | undefined = instrument?.market === 'cn'
    ? 'cn'
    : inferMarketFromSymbol(instrument?.symbol)
  const symbol = instrument?.symbol
  const activeMarket: MarketId = market ?? 'cn'

  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)
  // 数值紧凑单位 locale（亿/万 vs K/M/B）：词典哨兵键判定，随语言切换响应。
  const numLocale = scaleLocaleOf(t)

  const instances = useChart(state => state.instances)
  // symbol visibility：按标的可见实例——唯一过滤点。图表调度、读数行、发 Agent
  // 快照（标题/读数）、快捷词条、选择器勾选态全部消费它（隐藏 ≠ 取消激活，
  // 实例仍在名册，raw `instances` 仅供「全局移除」按钮判定存在性）。
  const visibleInstances = useMemo(
    () => instances.filter(instance => isInstanceVisibleOn(instance, market, symbol)),
    [instances, market, symbol],
  )
  // 复选框/快捷词条共用的按标的开关（symbol visibility）：关→记隐藏；开→清隐藏；
  // 未挂载→全局挂载；无聚焦标的（market/symbol 缺失）退回全局开关语义。
  const toggleIndicatorVisible = (id: string): void => {
    const raw = instances.find(candidate => candidate.id === id)
    const isVisible = raw !== undefined && isInstanceVisibleOn(raw, market, symbol)
    if (market === undefined || symbol === undefined) {
      toggleIndicator(id)
      return
    }
    const scopeKey = symbolScopeKey(market, symbol)
    if (isVisible) setIndicatorVisible(id, false, scopeKey)
    else if (raw !== undefined) setIndicatorVisible(id, true, scopeKey)
    else toggleIndicator(id)
  }
  // 指标名册修订号：插件晚于首帧合并 definition 时触发重渲染。
  const rosterVersion = useSyncExternalStore(indicators.subscribe, indicators.getVersion)

  const [chartInterval, setIntervalFor] = useState<string>(() => {
    if (market === undefined) return '1d'
    return readInterval(market)
  })
  const [daily, setDaily] = useState<Kline[] | null>(null)
  const [klines, setKlines] = useState<Kline[] | null>(null)
  const [kError, setKError] = useState<string | null>(null)
  const [ticker, setTicker] = useState<Ticker | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editingIndicator, setEditingIndicator] = useState<string | null>(null)
  const [sendState, setSendState] = useState<SendState>('idle')
  // 统一「发送给 Agent」下拉菜单开合（2026-09-04 入口收敛）。
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  /** 当前标的的 6 位期权代码（`510050.SH` → `510050`）；非 CN 或非 6 位码 → undefined。 */
  const optionUnderlying = useMemo(() => {
    if (market !== 'cn' || symbol === undefined) return undefined
    const code = symbol.replace(/\.(SH|SZ)$/i, '').toUpperCase()
    return /^\d{6}$/.test(code) ? code : undefined
  }, [market, symbol])
  /** 注册标的名册（连接器静态表，不打网关）；空 = 未挂 connector-options 或取数失败。 */
  const [optionsUnderlyings, setOptionsUnderlyings] = useState<readonly OptionUnderlying[]>([])
  /** 名册命中当前标的 → 「期权」页签可显示（docs/options-bridge.md 显隐判据）。 */
  const optionsAvailable = optionUnderlying !== undefined
    && optionsUnderlyings.some(item => item.underlying === optionUnderlying)
  /** 当前标的的名册行：期权交易面的合约乘数与底仓 heldQty 来源（阶段 3/4 互联）。
   *  未命中 → undefined（此时 optionsAvailable=false，期权透镜不渲染）。 */
  const optionUnderlyingRow = useMemo(
    () => optionUnderlying === undefined
      ? undefined
      : optionsUnderlyings.find(item => item.underlying === optionUnderlying),
    [optionsUnderlyings, optionUnderlying],
  )
  /** 标准四季月（本地算，网关未起也画得出到期胶囊）。 */
  const [optionExpiries, setOptionExpiries] = useState<OptionExpiryCalendar | null>(null)
  /** 选中到期月（YYMM）。 */
  const [optionMonth, setOptionMonth] = useState<string | null>(null)
  /** T 型报价链与失败原因（按错误码分诊）。 */
  const [optionChain, setOptionChain] = useState<OptionChain | null>(null)
  const [optionFailure, setOptionFailure] = useState<{ code: string; message: string } | null>(null)
  /** 首个链应答是否落地（区分「加载中」与「不可用」）。 */
  const [optionChainLoaded, setOptionChainLoaded] = useState(false)

  /* ── 期权总览 / 5 分钟闭环（2026-09-09 WB-1 / WB-6）────────────────── */
  /** 期权透镜内页：总览（落地页）| T 板（点行进入）。 */
  const [optionPane, setOptionPane] = useState<'overview' | 'chain'>('overview')
  const [overviewSort, setOverviewSort] = useState<OptionOverviewSort>('strength')
  const [optionsOverview, setOptionsOverview] = useState<OptionOverview | null>(null)
  const [optionOverviewFailure, setOptionOverviewFailure] = useState<{ code: string; message: string } | null>(null)
  const [optionOverviewLoaded, setOptionOverviewLoaded] = useState(false)
  const [optionsLoop, setOptionsLoop] = useState<OptionCycleLoop | null>(null)
  const [optionLoopFailure, setOptionLoopFailure] = useState<{ code: string; message: string } | null>(null)
  const [optionLoopLoaded, setOptionLoopLoaded] = useState(false)
  /** 闭环无该标的行时的降级箱体（WB-3；正常路径用 loop.latest.forecast）。 */
  const [optionFallbackBox, setOptionFallbackBox] = useState<OptionIntradayBoxRow | null>(null)

  /** 行情板块页签（图表 | 基本面 | 新闻 | 公告）：跨标的保持。
   *  期权不再埋在此处——升格为与现货平级的「现货 ⇄ 期权」双透镜（见 lens）。
   *  「衍生品」页签（crypto 专属）已随市场收敛移除。 */
  const [stageTab, setStageTab] = useState<'chart' | 'fundamentals' | 'options' | 'news' | 'announcements'>('chart')
  /** 「现货 ⇄ 期权」对等双透镜（2026-09-08 期权升格重构）：仅带期权标的（optionsAvailable）
   *  启用；期权从 6 个次级页签升格为与 A 股现货平级的一级切换。非期权标的恒 'spot'。 */
  const [lens, setLens] = useState<'spot' | 'options'>('spot')
  /**
   * 透镜可用性判据（WB-1 起放宽）：**挂了 connector-options（名册非空）就给透镜**，
   * 不再要求当前自选正好是那 9 只 ETF——否则用户停在 600519 时连总览都进不去。
   * 名册命中当前标的（optionsAvailable）只决定能不能进 T 板。
   */
  const optionsMounted = optionsUnderlyings.length > 0
  const activeLens = optionsMounted ? lens : 'spot'
  /** T 板需要当前标的是注册标的；否则期权透镜只落总览（渲染期归一，不等 effect）。 */
  const optionPaneView: 'overview' | 'chain' = optionPane === 'chain' && optionsAvailable ? 'chain' : 'overview'
  // 渲染期页签归一（issue #54 评审 L3）：期权是注册标的专属，切到非注册标的
  // （或未挂 connector-options）时渲染直接按图表页签处理——不等 useEffect 纠偏。
  const viewTab = stageTab === 'options' && !optionsAvailable ? 'chart' : stageTab
  /** 盘口竖栏（issue #39）：开关跨标的/会话记忆；数据 null = 数据源未提供（降级提示）。 */
  const [orderbookOpen, setOrderbookOpen] = useState<boolean>(() => readOrderbookOpen())
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null)
  const [orderbookLoading, setOrderbookLoading] = useState(false)
  const [trades, setTrades] = useState<TradeTick[] | null>(null)
  /** 交易工作台（issue #40）：默认关（安全敏感面）；只读数据 null = 服务未挂载/凭证缺失。 */
  const [tradeDeskOpen, setTradeDeskOpen] = useState<boolean>(() => readTradeDeskOpen())
  /** 右侧栏资产面板（2026-09-05 起取代底部资产抽屉）：默认展开，开关跨会话记忆。 */
  const [tradePositions, setTradePositions] = useState<Position[] | null>(null)
  const [tradeBalances, setTradeBalances] = useState<AccountBalance[] | null>(null)
  // 挂单/成交行已随 crypto 衍生品面板移除消费端；state 仅保留写入端供刷新管道填充。
  const [, setTradeOrders] = useState<Order[] | null>(null)
  const [, setTradeFills] = useState<TradeFill[] | null>(null)
  /** 交易面不可用原因（2026-09-04）：positions 为探针，区分「市场未挂交易连接器」与「凭证缺失」。 */
  // positions 仍作探针以驱动 reason 分类（balances 列展示用）；持仓/汇总面已
  // 迁右缘资产面板（holdings-store 自管数据），不再消费这里的 reason。
  const [, setTradeDataReason] = useState<TradeRowsReason>('unavailable')
  const [, setBalancesDataReason] = useState<TradeRowsReason>('unavailable')

  /** 全局交易模式（trade-mode-store 单例：右栏资产面板跨树共享同一份；
   *  issue #65 契约 §6.4 缺省 paper 语义由 store 承载）。 */
  const tradeMode = useSyncExternalStore(tradeModeStore.subscribe, tradeModeStore.getSnapshot)

  // 监听模拟账本变动
  const [paperTick, setPaperTick] = useState(0)
  useEffect(() => {
    return paperTradingStore.subscribe(() => {
      setPaperTick((t) => t + 1)
    })
  }, [])

  const handleToggleTradeMode = (mode: 'live' | 'paper') => {
    writeTradeMode(mode)
    if (mode === 'paper') {
      // 切换到模拟盘时，若交易台未开，自动打开方便体验
      if (!tradeDeskOpen) {
        setTradeDeskOpen(true)
        writeTradeDeskOpen(true)
      }
    }
  }

  // 标的行情价格变动时实时更新模拟持仓浮盈
  useEffect(() => {
    if (ticker?.price && symbol) {
      paperTradingStore.updatePrices({ [symbol]: ticker.price })
    }
  }, [ticker?.price, symbol])

  const activePositions = tradeMode === 'paper' ? paperTradingStore.getPositions() : tradePositions
  const activeBalances = tradeMode === 'paper' ? paperTradingStore.getBalances() : tradeBalances
  const paperCash = paperTradingStore.getAccount().cash
  void paperTick // 模拟账本 subscribe 通知的重渲染驱动（paper 行直读 store）

  // 当前标的持仓量与可用现金计算（供下单面板精确计算 25%/50%/75%/100% 比例填单）
  const currentPosition = useMemo(() => {
    if (!symbol) return undefined
    const list = activePositions ?? []
    return list.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase() && p.side === 'long')
  }, [symbol, activePositions])

  const currentPositionSize = currentPosition?.size ?? 0

  const availableCash = useMemo(() => {
    if (tradeMode === 'paper') {
      return paperCash
    }
    if (!activeBalances || activeBalances.length === 0) return 0
    const found = activeBalances.find((b) => b.asset.toUpperCase() === 'CNY')
      ?? activeBalances.find((b) => /USD|USDT|CNY|HKD|CASH/i.test(b.asset))
      ?? activeBalances[0]
    return found ? found.free : 0
  }, [tradeMode, paperCash, activeBalances])
  /** 区间统计：框选模式开 + 已选逻辑下标区间（TvChart 上报，面板消费）。 */
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeSelection, setRangeSelection] = useState<{ start: number; end: number } | null>(null)
  /** TvChart 注册的截图回调（图表未渲染/已卸载 = null）。 */
  const captureRef = useRef<(() => TvChartCapture | null) | null>(null)

  // ── 新闻与公告（issue #37）────────────────────────────────────
  const [newsItems, setNewsItems] = useState<ClientNewsItem[] | null>(null)
  const [newsUnavailable, setNewsUnavailable] = useState<string[]>([])

  // ── K 线标记（issue #41）──────────────────────────────────────
  const [markerStore] = useState(() => createMarkerStateStore())
  const markerState = useSyncExternalStore(markerStore.subscribe, markerStore.getSnapshot)
  const [markerHover, setMarkerHover] = useState<MarkerHoverInfo | null>(null)

  const [clock, setClock] = useState(() => formatStatusBarClock(Date.now()))
  const [indexTickers, setIndexTickers] = useState<Record<string, Ticker>>({})

  // 状态栏秒级时钟
  useEffect(() => {
    const timer = setInterval(() => { setClock(formatStatusBarClock(Date.now())) }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 市场时段状态（随秒钟与激活市场自动刷新）
  const sessionStatus = useMemo(() => {
    return getMarketSessionStatus(activeMarket, Date.now())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarket, clock])

  const indexDefs = MARKET_INDICES[activeMarket] ?? []

  // 底部大盘指数轮询：按当前激活市场拉取对应核心指数
  usePoll(async () => {
    if (indexDefs.length === 0) return
    try {
      const symbols = indexDefs.map(def => def.symbol)
      const outcome = await fetchTickers(activeMarket, symbols)
      const next: Record<string, Ticker> = {}
      for (const sym of symbols) {
        const res = outcome[sym]
        if (res?.ok) next[sym] = res.ticker
      }
      setIndexTickers(next)
    } catch {
      /* 下轮重试 */
    }
  }, TICKER_POLL_MS, [activeMarket])

  // 周期记忆（每市场独立）；切标的时读该市场的上次周期。
  useEffect(() => {
    if (market !== undefined) setIntervalFor(readInterval(market))
  }, [market])

  // K线取数 = poll：挂载/换标的/换周期立即触发，此后 30s resync。
  const requestRef = useRef('')
  usePoll(async () => {
    if (!market || !symbol) return
    const request = `${market}:${symbol}:${chartInterval}`
    requestRef.current = request
    try {
      const rows = await fetchKlines(market, symbol, chartInterval, chartInterval === '1d' ? DAILY_LIMIT : KLINE_LIMIT_DEFAULT)
      if (requestRef.current !== request) return
      setKlines(rows)
      setKError(null)
    } catch (error) {
      if (requestRef.current !== request) return
      setKError(String((error as { message?: string })?.message ?? error))
    }
  }, KLINE_RESYNC_MS, [market, symbol, chartInterval])

  // 日K参考（头部涨跌/昨收）：每标的只拉一次。
  useEffect(() => {
    if (!market || !symbol) return
    let cancelled = false
    fetchKlines(market, symbol, '1d', DAILY_LIMIT)
      .then((rows) => { if (!cancelled) setDaily(rows) })
      .catch(() => { /* 头部统计缺省 */ })
    return () => { cancelled = true }
  }, [market, symbol])

  // CN ETF 期权（2026-09-08 第一期只读面）：名册 → 到期月 → T 板链三段。
  // 名册：仅 CN 拉（连接器静态表，不打网关）；失败即空数组 → 页签不显示，不报错横幅。
  usePoll(async () => {
    if (market !== 'cn') {
      setOptionsUnderlyings([])
      return
    }
    const res = await fetchOptionsUnderlyings()
    setOptionsUnderlyings(res.ok ? res.data : [])
  }, OPTIONS_LIST_POLL_MS, [market])

  // 到期月：注册标的命中才拉（本地算，网关未起也有）；切标的丢弃旧应答（竞态守卫）。
  const optionExpiriesRequestRef = useRef('')
  usePoll(async () => {
    if (!optionsAvailable || optionUnderlying === undefined) return
    const request = optionUnderlying
    optionExpiriesRequestRef.current = request
    const res = await fetchOptionsExpiries(request)
    if (optionExpiriesRequestRef.current !== request) return
    setOptionExpiries(res.ok ? res.data : null)
  }, OPTIONS_LIST_POLL_MS, [optionsAvailable, optionUnderlying])

  // 选中月纠偏：到期月落地后默认当月；换标的/换季后原选中月不在名册 → 回落第一个。
  useEffect(() => {
    const months = optionExpiries?.months ?? []
    if (months.length === 0) {
      if (optionMonth !== null) setOptionMonth(null)
      return
    }
    const first = months[0]
    if (first === undefined) return
    if (optionMonth === null || !months.some(month => month.expiryMonth === optionMonth)) {
      setOptionMonth(first.expiryMonth)
    }
  }, [optionExpiries, optionMonth])

  // T 板链：仅「期权」页签激活 + 已选出到期月才拉（网关未起时不空转）。
  const optionChainRequestRef = useRef('')
  usePoll(async () => {
    if (activeLens !== 'options' || !optionsAvailable || optionUnderlying === undefined || optionMonth === null) return
    const request = `${optionUnderlying}:${optionMonth}`
    optionChainRequestRef.current = request
    const res = await fetchOptionsChain(optionUnderlying, optionMonth)
    if (optionChainRequestRef.current !== request) return
    if (res.ok) {
      setOptionChain(res.data)
      setOptionFailure(null)
    } else {
      setOptionChain(null)
      setOptionFailure({ code: res.code, message: res.message })
    }
    setOptionChainLoaded(true)
  }, OPTIONS_CHAIN_POLL_MS, [activeLens, optionsAvailable, optionUnderlying, optionMonth])

  // 换标的/换月：回到「加载中」，避免上一份链与旧错误码残留（评审 L2 同款纪律）。
  useEffect(() => {
    setOptionChainLoaded(false)
    setOptionChain(null)
    setOptionFailure(null)
  }, [optionUnderlying, optionMonth])

  /* ── 期权总览（WB-1）：只拉一条 /options/overview ────────────────── */
  // 仅在透镜停在总览页时轮询（T 板页吃缓存：scanPrompt 与「返回总览」都要用）。
  // includeIv 只在排序切 iv 时打开——否则九路 vol_analytics 会打爆网关。
  const overviewRequestRef = useRef('')
  usePoll(async () => {
    if (activeLens !== 'options' || optionPaneView !== 'overview') return
    const request = `${overviewSort}:${overviewSort === 'iv' ? '1' : '0'}`
    overviewRequestRef.current = request
    const res = await fetchOptionsOverview({ sort: overviewSort, includeIv: overviewSort === 'iv' })
    if (overviewRequestRef.current !== request) return
    if (res.ok) {
      setOptionsOverview(res.data)
      setOptionOverviewFailure(null)
    } else {
      setOptionsOverview(null)
      setOptionOverviewFailure({ code: res.code, message: res.message })
    }
    setOptionOverviewLoaded(true)
  }, OPTIONS_OVERVIEW_POLL_MS, [activeLens, optionPaneView, overviewSort])

  /* ── 5 分钟闭环（WB-6）：页面不算箱体，只读宿主已算好的 loop ───────── */
  usePoll(async () => {
    if (activeLens !== 'options') return
    const res = await fetchOptionsCycleLoop()
    if (res.ok) {
      setOptionsLoop(res.data)
      setOptionLoopFailure(null)
    } else {
      setOptionsLoop(null)
      setOptionLoopFailure({ code: res.code, message: res.message })
    }
    setOptionLoopLoaded(true)
  }, OPTIONS_CYCLE_LOOP_POLL_MS, [activeLens])

  /** 当前标的在闭环里的行（T 板箱体条与周期卡的 SSOT）。 */
  const optionCycleRow = useMemo(
    () => optionUnderlying === undefined
      ? undefined
      : optionsLoop?.rows.find(row => row.underlying === optionUnderlying),
    [optionsLoop, optionUnderlying],
  )
  /** T 板箱体条数据源：优先 loop 的本桶预报，闭环没该标的行才降级单独拉箱体。 */
  const optionForecast = optionCycleRow?.latest?.forecast ?? optionFallbackBox
  /** underlying → 名称（闭环行只有代码，名字从总览借，避免再打一次行情）。 */
  const optionNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const row of optionsOverview?.rows ?? []) map[row.underlying] = row.name
    return map
  }, [optionsOverview])

  // 降级拉箱：仅在「闭环已答且没有该标的行」时触发一次，不与宿主打分引擎抢算。
  useEffect(() => {
    if (activeLens !== 'options' || optionUnderlying === undefined || !optionLoopLoaded) return
    if (optionCycleRow !== undefined || optionsLoop === null) {
      if (optionCycleRow !== undefined) setOptionFallbackBox(null)
      return
    }
    let cancelled = false
    void fetchOptionsIntradayBox({ underlying: optionUnderlying }).then((res) => {
      const row = res.ok ? res.data.rows.find(item => item.underlying === optionUnderlying) : undefined
      if (!cancelled) setOptionFallbackBox(row ?? null)
    })
    return () => { cancelled = true }
  }, [activeLens, optionUnderlying, optionLoopLoaded, optionCycleRow, optionsLoop])

  // 盘口/分笔轮询（issue #39）：竖栏打开 + 图表页签时才拉，省上游配额。
  usePoll(async () => {
    if (!orderbookOpen || stageTab !== 'chart' || market === undefined || symbol === undefined) return
    setOrderbookLoading(true)
    try {
      const [book, recentTrades] = await Promise.all([
        fetchOrderbook(market, symbol),
        fetchRecentTrades(market, symbol, 50),
      ])
      setOrderbook(book)
      setTrades(recentTrades)
    } finally {
      setOrderbookLoading(false)
    }
  }, ORDERBOOK_POLL_MS, [orderbookOpen, stageTab, market, symbol])

  // 交易台只读轮询（issue #40，面板打开时）：positions 为主探针——
  // 服务未注册（400）或凭证缺失（ok:false）都置 null，分区按语义降级。
  const refreshTradeDesk = async (m: MarketId = activeMarket) => {
    const [positionRows, balanceRows, orderRows, fillRows] = await Promise.all([
      fetchTradePositions(m),
      fetchTradeBalances(m),
      fetchTradeOpenOrders(m),
      fetchTradeFills(m),
    ])
    setTradePositions(positionRows.rows)
    setTradeDataReason(positionRows.reason)
    setTradeBalances(balanceRows.rows)
    setBalancesDataReason(balanceRows.reason)
    setTradeOrders(orderRows.rows)
    setTradeFills(fillRows.rows)
  }

  usePoll(async () => {
    if (stageTab !== 'chart') return
    await refreshTradeDesk(activeMarket)
  }, TRADE_DESK_POLL_MS, [stageTab, activeMarket])


  const onSubmitGuiOrder = async (input: Parameters<typeof placeGuiOrder>[1]): Promise<Awaited<ReturnType<typeof placeGuiOrder>>> => {
    if (tradeMode === 'paper') {
      try {
        const curPrice = ticker?.price ?? 0
        const order = paperTradingStore.placeOrder({
          symbol: input.symbol,
          side: input.side,
          type: input.type,
          quantity: input.quantity,
          ...(input.price !== undefined ? { price: input.price } : {}),
          currentPrice: curPrice,
          market: activeMarket, // issue #65：模拟持仓记录市场（统一台账盯市/币种推导）
        })
        setHoldingsPanelOpen(true)
        return { order }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
    return placeGuiOrder(activeMarket, input).then((res) => {
      // 下单成功（真交易）→ 自动展开资产面板看最新委托，并立即刷新账户面。
      if (res.order) {
        setHoldingsPanelOpen(true)
        void refreshTradeDesk(activeMarket)
      }
      return res
    })
  }

  // 页签市场归一：期权是注册标的专属——切到非注册标的（或未挂
  // connector-options）→ 回图表页签。（衍生品页签已随市场收敛移除。）
  useEffect(() => {
    if (stageTab === 'options' && !optionsAvailable) setStageTab('chart')
  }, [stageTab, optionsAvailable])

  // 统一填入反馈（2026-09-04 入口收敛）：sending/sent/error 状态由「发送给 Agent」
  // 按钮整体承载，行情快照与资金面快照共用同一套反馈。
  const fillRequestRef = useRef<AbortController | null>(null)
  const fillFeedbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    setSendState('idle')
    return () => {
      fillRequestRef.current?.abort()
      fillRequestRef.current = null
      clearTimeout(fillFeedbackRef.current)
    }
  }, [market, symbol, fillComposer])

  const runFill = (text: string | ((signal: AbortSignal) => Promise<string>), image?: SendImageInput): void => {
    if (fillComposer === undefined || fillRequestRef.current !== null) return
    const fillTarget = fillComposer.captureTarget?.() ?? fillComposer
    const request = new AbortController()
    fillRequestRef.current = request
    clearTimeout(fillFeedbackRef.current)
    setSendState('sending')
    void (async () => {
      try {
        const body = typeof text === 'string' ? text : await text(request.signal)
        if (request.signal.aborted) return
        await fillTarget(body, image)
        if (!request.signal.aborted) {
          setSendState('sent')
          fillFeedbackRef.current = setTimeout(() => { setSendState('idle') }, 2000)
        }
      } catch (error: unknown) {
        if (!request.signal.aborted) {
          console.warn('[dsh-trading] fill composer from quote failed:', error)
          setSendState('error')
          fillFeedbackRef.current = setTimeout(() => { setSendState('idle') }, 2600)
        }
      } finally {
        if (fillRequestRef.current === request) fillRequestRef.current = null
      }
    })()
  }

  // 换标的：立即清场
  useEffect(() => {
    setKlines(null)
    setDaily(null)
    setTicker(null)
    setHoverIndex(null)
    setKError(null)
    setOrderbook(null)
    setTrades(null)
    setNewsItems(null)
    setNewsUnavailable([])
    setMarkerHover(null)
  }, [market, symbol])

  // ticker 轮询：头部价格 + 尾随合并最后一根 K 线
  usePoll(async () => {
    if (market === undefined || symbol === undefined) return
    try {
      const outcome = await fetchTickers(market, [symbol])
      const result = outcome[symbol]
      if (result?.ok) {
        setTicker(result.ticker)
        setKlines(prev => prev === null ? prev : withTickerBar(prev, result.ticker))
      }
    } catch { /* 下轮再试 */ }
  }, TICKER_POLL_MS, [market, symbol])

  // 新闻情报流轮询（issue #37）：处于 news/announcements 或开启事件图钉时 60s 轮询；symbol/market 变化时立即重拉。
  const NEWS_POLL_MS = 60000
  const newsRequestRef = useRef('')
  usePoll(async () => {
    if ((stageTab !== 'news' && stageTab !== 'announcements' && !markerState.showKnowledgeEvents) || market === undefined || symbol === undefined) return
    const request = `${market}:${symbol}`
    newsRequestRef.current = request
    try {
      const result = await fetchNews(market, symbol, 50)
      // 竞态守卫：慢响应回来时已切标的 → 丢弃，旧新闻不得覆盖新标的（对齐 klines poll 的 requestRef 模式）。
      if (newsRequestRef.current !== request) return
      if (result !== null) {
        setNewsItems(result.items)
        setNewsUnavailable(result.unavailable)
      }
    } catch { /* 下轮重试 */ }
  }, NEWS_POLL_MS, [market, symbol, stageTab, markerState.showKnowledgeEvents])

  const stats = useMemo(() => {
    const last = daily !== null && daily.length > 0 ? daily[daily.length - 1] : undefined
    const klinePrevClose = daily !== null && daily.length >= 2 ? daily[daily.length - 2]?.close : undefined
    // 昨收/涨跌优先用快照官方锚点（ticker.prevClose/changePercent）：
    // 日 K 序列可能缺最新收盘 bar（Yahoo 补齐滞后，见 connector-yahoo），倒数第二根
    // 会错位一个交易日（2026-09-01 AAPL 实证：显示 314.58 而非 319.70）。
    const prevClose = ticker?.prevClose ?? klinePrevClose
    const price = ticker?.price ?? klines?.[klines.length - 1]?.close
    const change = price !== undefined && prevClose !== undefined ? price - prevClose : undefined
    const pct = ticker?.changePercent ?? changePercent(price, prevClose)
    return { last, prevClose, price, change, pct }
  }, [daily, ticker, klines])

  // 区间统计：框选模式 ESC 退出（连同清空选区）。
  useEffect(() => {
    if (!rangeMode) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setRangeMode(false)
      setRangeSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rangeMode])

  const rangeStats = useMemo(
    () => (rangeSelection !== null && klines !== null ? computeRangeStats(klines, rangeSelection.start, rangeSelection.end) : null),
    [rangeSelection, klines],
  )

  // 指标调度：可见实例 × klines → 渲染输入（symbol visibility 过滤后的实例才参与）
  const indicatorGroups = useMemo(() => {
    if (klines === null) return []
    const groups: Array<TvIndicatorGroup & { id: string; pane: 'main' | 'sub'; title: string }> = []
    for (const instance of visibleInstances) {
      const definition = indicators.get(instance.id)
      if (definition === undefined) continue
      groups.push({
        id: instance.id,
        title: definition.title,
        pane: definition.pane,
        key: indicators.instanceKey(instance),
        // issue #72：命中 symbolParams["market:symbol"] 覆盖时该套参数整体替代全局 params；
        // 计算前按当前 schema clamp——re-author 改 schema 后 stale 覆盖的旧键/越界值不直通 compute。
        outputs: definition.compute(klines, indicators.clampParams(definition, effectiveInstanceParams(instance, market, symbol))),
      })
    }
    return groups
  }, [klines, visibleInstances, rosterVersion, market, symbol])

  const mainOverlays = useMemo(() => indicatorGroups.filter(group => group.pane === 'main'), [indicatorGroups])
  const subIndicators = useMemo(() => indicatorGroups.filter(group => group.pane === 'sub'), [indicatorGroups])

  const bars = useMemo(() => klines?.map(toBar) ?? [], [klines])
  const volumes = useMemo(() => klines?.map(k => toVolume(k, colorMode)) ?? [], [klines, colorMode])

  const readoutIndex = hoverIndex ?? (klines !== null && klines.length > 0 ? klines.length - 1 : null)
  const readoutCandle = klines !== null && readoutIndex !== null ? klines[readoutIndex] : undefined
  // 读数行昨收跟随十字光标：悬停历史K线取当前周期序列的前一根收盘价（日K下即该日
  // 昨收）；未悬停或悬停最新一根沿用官方锚点 ticker.prevClose（日K补齐滞后时序列
  // 倒数第二根会错位一个交易日，见上方 stats 注释）；序列首根无前一根则留空。
  const readoutPrevClose = klines === null || readoutIndex === null
    ? stats.prevClose
    : readoutIndex <= 0
      ? undefined
      : readoutIndex >= klines.length - 1
        ? stats.prevClose
        : klines[readoutIndex - 1]?.close

  // 所有可用指标（供底部词条栏横向快捷展示）
  const allDefinitions = useMemo(() => indicators.list(), [rosterVersion])

  // 策略信号标记数据（issue #41）：在当前 K 线序列上实时计算 EMA(12, 26) 交叉信号（过滤预热期与边缘噪音）。
  const signalMarkers = useMemo<readonly ChartSignalMarkerInput[] | undefined>(() => {
    if (!bars || bars.length < 30) return undefined
    const cur = CURRENCY_SYMBOL[activeMarket]
    const k12 = 2 / (12 + 1)
    const k26 = 2 / (26 + 1)
    let ema12 = bars[0]?.close ?? 0
    let ema26 = bars[0]?.close ?? 0
    const signals: ChartSignalMarkerInput[] = []
    let prevDiff: number | null = null

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      if (!bar) continue
      ema12 = bar.close * k12 + ema12 * (1 - k12)
      ema26 = bar.close * k26 + ema26 * (1 - k26)
      const diff = ema12 - ema26
      if (i >= 26 && prevDiff !== null) {
        if (prevDiff <= 0 && diff > 0) {
          signals.push({
            time: bar.time,
            action: 'entry',
            price: bar.close,
            reason: t('marker.signal.entryReason', { cur, price: bar.close.toFixed(2) }),
          })
        } else if (prevDiff >= 0 && diff < 0) {
          signals.push({
            time: bar.time,
            action: 'exit',
            price: bar.close,
            reason: t('marker.signal.exitReason', { cur, price: bar.close.toFixed(2) }),
          })
        }
      }
      prevDiff = diff
    }
    return signals.length > 0 ? signals : undefined
  }, [bars, t])

  // 知识事件标记数据（issue #41）：从当前标的的官方公告与知识事件中提取，按时间柱精准锚定（同 K 线柱去重聚合，避免边缘挤压）。
  const knowledgeMarkers = useMemo<readonly ChartKnowledgeMarkerInput[] | undefined>(() => {
    if (!newsItems || newsItems.length === 0 || !bars || bars.length === 0) return undefined
    // 仅针对属于该标的的官方公告/交易所公报打图钉，排除泛财经媒体与宏观回退要闻
    const announcements = newsItems.filter(it => isAnnouncementSource(it.source))
    if (announcements.length === 0) return undefined

    // 计算当前 K 线的平均周期步长（如日 K=86400s，周 K=604800s，月 K≈2592000s）
    const barStep = bars.length > 1 ? Math.abs((bars[bars.length - 1]?.time ?? 0) - (bars[0]?.time ?? 0)) / (bars.length - 1) : 86400
    const tolerance = Math.max(barStep * 0.8, 43200)
    const barMap = new Map<number, { title: string; count: number; url: string }>()

    for (const item of announcements) {
      const ts = Math.floor(new Date(item.publishedAt).getTime() / 1000)
      if (Number.isNaN(ts)) continue

      let bestBarTime: number | null = null
      let minDiff = Infinity
      for (const bar of bars) {
        const diff = Math.abs(bar.time - ts)
        if (diff < minDiff && diff <= tolerance) {
          minDiff = diff
          bestBarTime = bar.time
        }
      }

      if (bestBarTime !== null) {
        const existing = barMap.get(bestBarTime)
        if (existing) {
          existing.count += 1
        } else {
          barMap.set(bestBarTime, { title: item.title, count: 1, url: item.url })
        }
      }
    }

    const markers: ChartKnowledgeMarkerInput[] = []
    for (const [time, info] of barMap.entries()) {
      markers.push({
        time,
        title: info.count > 1 ? t('marker.knowledge.batched', { title: info.title, count: String(info.count) }) : info.title,
        cardId: info.url,
        credibility: 'high',
      })
    }
    return markers.length > 0 ? markers : undefined
  }, [newsItems, bars, t])

  // 完整标的上下文：先固定行情与截图，再按点击时标的补齐新闻/公告/基本面。
  // 只填入文本 + PNG，不自动发送；单源失败在正文标明，切标的取消旧采集。
  // market/symbol 在函数体内收窄（闭包对 TS 不透传 narrowing），先落成常量。
  const onSendToAgent = (): void => {
    if (fillComposer === undefined || sendState === 'sending') return
    if (market === undefined || symbol === undefined) return
    const activeMarket: MarketId = market
    const activeSymbol: string = symbol
    const capture = captureRef.current?.() ?? null
    const input = {
      name: instrument?.name,
      symbol: activeSymbol,
      marketLabel: t(TAB_KEY[activeMarket]),
      intervalLabel: t(INTERVAL_KEY[chartInterval] ?? 'interval.1d'),
      price: stats.price,
      change: stats.change,
      pct: stats.pct,
      prevClose: stats.prevClose,
      candle: readoutCandle,
      indicatorTitles: visibleInstances.map(instance => indicators.get(instance.id)?.title ?? instance.id),
      withScreenshot: capture !== null,
    }
    // exactOptionalPropertyTypes：undefined 字段直接剔除而非显式传 undefined。
    // deltaWrap 用 '|' 作分隔哨兵拆包裹符对（词典值单字符串无法表达成对括号）。
    const [deltaOpen = '(', deltaClose = ')'] = t('compose.deltaWrap').split('|')
    const copy: QuoteMessageCopy = {
      opener: t('compose.opener'),
      prevClose: t('compose.prevClose'),
      priceLine: t('compose.priceLine'),
      candleLine: t('compose.candleLine'),
      indicatorsLine: t('compose.indicatorsLine'),
      listSeparator: t('compose.listSeparator'),
      deltaWrap: [deltaOpen, deltaClose],
      prevSep: t('compose.prevSep'),
      volumeLocale: numLocale,
      withScreenshotTail: t('compose.withScreenshot'),
      withoutScreenshotTail: t('compose.withoutScreenshot'),
    }
    const text = composeQuoteMessage(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as unknown as Parameters<typeof composeQuoteMessage>[0], copy)
    // 数据位置段（2026-09-05，owner 裁决）：K 线数据不内联——告知当前图表
    // 序列的时间范围 + 取数位置（<market>_get_klines 同参复取），分析由
    // Agent 调工具、写代码完成；已开指标则直接透出计算后的当根读数（与
    // readoutCandle 同根、图表 legend 同源同参，owner：只给参数让他复算
    // 属多此一举）。序列未就绪（klines === null）时省略整段。
    const dataCopy: QuoteDataSectionCopy = {
      header: t('compose.data.header'),
      range: t('compose.data.range'),
      locate: t('compose.data.locate'),
      indicators: t('compose.data.indicators'),
    }
    const dataSection = klines !== null && klines.length > 0 && readoutIndex !== null
      ? composeQuoteDataSection({
          market: activeMarket,
          symbol: activeSymbol,
          interval: chartInterval,
          klines,
          indicatorReadouts: indicatorGroups.map(group => ({
            title: group.title,
            outputs: group.outputs.map(output => ({ key: output.key, value: output.values[readoutIndex] })),
          })),
          klinesTool: `${activeMarket}_get_klines`,
        }, dataCopy)
      : ''
    const capturedAt = new Date().toISOString()
    runFill(async signal => {
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), 15000)
      const fetchSignal = AbortSignal.any([signal, timeout.signal])
      try {
        const [news, fundamentals] = await Promise.all([
          fetchNews(activeMarket, activeSymbol, 50, fetchSignal),
          fetchFundamentals(activeMarket, activeSymbol, fetchSignal),
        ])
        const research = composeResearchSection({ news, fundamentals, capturedAt }, {
          header: t('compose.research.header'), announcements: t('compose.research.announcements'),
          news: t('compose.research.news'), fundamentals: t('compose.research.fundamentals'),
          unavailable: t('compose.research.unavailable'), empty: t('compose.research.empty'),
          sourcesUnavailable: t('compose.research.sourcesUnavailable'), guidance: t('compose.research.guidance'),
          omitted: t('compose.research.omitted'),
        })
        return [text, dataSection, research].filter(Boolean).join('\n\n')
      } finally {
        clearTimeout(timer)
      }
    }, capture === null ? undefined : {
      dataUrl: capture.dataUrl,
      name: `${activeSymbol}-${chartInterval}.png`,
      width: capture.width,
      height: capture.height,
    })
  }

  // 空态：未选择标的（空态之后的渲染路径依赖 market/symbol 非空，提前收窄）。
  if (market === undefined || symbol === undefined) {
    return (
      <div className={css.root}>
        <div className={css.empty}>
          <div className={css.emptyMain}>{t('quote.empty')}</div>
          <div>{t('quote.emptyHint')}</div>
        </div>
      </div>
    )
  }

  const intervals = MARKET_INTERVALS[market] ?? ['1d']
  const color = directionColor(stats.pct ?? 0, colorMode)

  const rawName = instrument?.name
  const isPlaceholderName = !rawName || rawName === symbol || /\(A股\)|\(港股\)/.test(rawName) // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
  const tickerName = (ticker as { name?: string })?.name
  const displayName = (!isPlaceholderName ? rawName : (tickerName || rawName || symbol))

  /* ── WB-1 点行进 T 板：resolve → 切全局标的 → 进 chain 页 ───────── */
  const onPickOverviewRow = (row: OptionOverviewRow): void => {
    if (selectInstrument === undefined) return
    void fetchOptionsResolve(row.spotSymbol ?? row.underlying).then((res) => {
      const spot = res.ok ? res.data.link?.spotSymbol : undefined
      if (spot === undefined) return
      selectInstrument({ market: 'cn', symbol: spot, name: row.name })
      setOptionPane('chain')
    })
  }

  /* ── WB-2 扫描入口：只预填 composer，不下单 ─────────────────────── */
  const scanAll = fillComposer === undefined || optionsOverview === null
    ? undefined
    : (): void => { void fillComposer(optionsOverview.scanAllPrompt) }
  const scanRow = fillComposer === undefined
    ? undefined
    : (row: OptionOverviewRow): void => { void fillComposer(row.scanPrompt) }
  /** T 板操作条：用总览缓存里该标的的 scanPrompt；缓存没有则先拉一次再找。 */
  const scanUnderlying = fillComposer === undefined || optionUnderlying === undefined
    ? undefined
    : (): void => {
        const cached = optionsOverview?.rows.find(item => item.underlying === optionUnderlying)
        if (cached !== undefined) {
          void fillComposer(cached.scanPrompt)
          return
        }
        void fetchOptionsOverview({ sort: overviewSort }).then((res) => {
          if (!res.ok) return
          const found = res.data.rows.find(item => item.underlying === optionUnderlying)
          if (found !== undefined) void fillComposer(found.scanPrompt)
        })
      }

  /** 期权合约 → Agent 下单请求文案（dry-run 优先；ETF ↔ 期权互联在客户端即打通）。
   *  文案走词典（options.agentOrder.*），骨架拼接在 zh/en 两侧对齐。 */
  const sendLegToAgent = fillComposer !== undefined
    ? (leg: SelectedOptionLeg): void => {
        const parts: string[] = [
          t('options.agentOrder.head', {
            symbol: symbol ?? '',
            name: displayName,
            side: t(leg.side === 'call' ? 'options.side.call' : 'options.side.put'),
            strike: leg.strike,
          }),
        ]
        if (leg.last !== undefined) parts.push(t('options.agentOrder.last', { last: leg.last }))
        if (leg.iv !== undefined) parts.push(t('options.agentOrder.iv', { iv: leg.iv }))
        parts.push(t('options.agentOrder.tail'))
        parts.push(t('options.agentOrder.disclaimer'))
        void fillComposer(parts.join(''))
      }
    : undefined

  return (
    <div className={css.root} data-dshtrading-quote-stage="">
      {/* 顶部报价头与二级 Sub-Tab 导航（图表 | 基本面） */}
      <div className={css.header}>
        <div className={css.ident}>
          <span className={css.name}>{displayName}</span>
          <span className={css.code}>{symbol}</span>
          <span className={css.marketTag}>{t(TAB_KEY[market])}</span>
        </div>
        <span className={css.price} style={{ color }}>{fmtPrice(stats.price)}</span>
        <span className={css.changes} style={{ color }}>
          <span>{fmtChange(stats.change)}</span>
          <span>{fmtPercent(stats.pct)}</span>
        </span>
        {/* 「现货 ⇄ 期权」对等双透镜（2026-09-08 期权升格）：与次级页签视觉区分的
            胶囊组，期权与 A 股现货平级。2026-09-09 起显隐判据是「挂了期权连接器」
            （名册非空）而非「当前标的是那 9 只」——透镜落地页是九标的总览，停在
            个股时也要能进。能不能进 T 板才看当前标的（optionsAvailable）。 */}
        {optionsMounted && (
          <div className={css.lensToggle} role="tablist" aria-label="spot or options lens">
            <button
              type="button"
              role="tab"
              aria-selected={activeLens === 'spot'}
              className={css.lensTab}
              data-active={activeLens === 'spot' ? 'true' : undefined}
              onClick={() => { setLens('spot'); if (stageTab === 'options') setStageTab('chart') }}
            >
              {t('lens.spot')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeLens === 'options'}
              className={css.lensTab}
              data-active={activeLens === 'options' ? 'true' : undefined}
              onClick={() => { setLens('options'); setOptionPane('overview') }}
            >
              {t('lens.options')}
            </button>
          </div>
        )}
        {/* 次级板块页签（图表 | 基本面 | 新闻 | 公告）：现货透镜下随报价头同行；期权透镜下整体隐藏 */}
        {activeLens !== 'options' && (
        <div className={css.stageTabs} role="tablist" aria-label="quote section">
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'chart'}
            className={css.stageTab}
            data-active={stageTab === 'chart' ? 'true' : undefined}
            onClick={() => { setStageTab('chart') }}
          >
            {t('quote.tab.chart')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'fundamentals'}
            className={css.stageTab}
            data-active={stageTab === 'fundamentals' ? 'true' : undefined}
            onClick={() => { setStageTab('fundamentals') }}
          >
            {t('quote.tab.fundamentals')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'news'}
            className={css.stageTab}
            data-active={stageTab === 'news' ? 'true' : undefined}
            onClick={() => { setStageTab('news') }}
          >
            {t('quote.tab.news')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'announcements'}
            className={css.stageTab}
            data-active={stageTab === 'announcements' ? 'true' : undefined}
            onClick={() => { setStageTab('announcements') }}
          >
            {t('quote.tab.announcements')}
          </button>
        </div>
        )}
        <span className={css.meta}>
          {ticker !== null && <span>{t('quote.updated')} {fmtClock(ticker.timestamp)}</span>}
        </span>
        {/* 统一「发送给 Agent」入口（2026-09-04 收敛）：报价头常驻，所有页签可见。
            主按钮一键填行情快照；下拉菜单承载资金面快照（crypto 且快照在位）——
            取代图表工具栏「发给 Agent」与衍生品条「分析资金面」双入口。 */}
        {fillComposer !== undefined && (
          <div className={css.sendWrap}>
            <button
              type="button"
              className={css.sendButton}
              data-state={sendState === 'idle' ? undefined : sendState}
              disabled={sendState === 'sending'}
              title={t('quote.sendToAgentHint')}
              onClick={onSendToAgent}
            >
              <IconSend size={13} />
              {sendState === 'sent'
                ? t('quote.sendSent')
                : sendState === 'error'
                  ? t('quote.sendFailed')
                  : sendState === 'sending'
                    ? t('quote.sendSending')
                    : t('quote.sendToAgent')}
            </button>
            <button
              type="button"
              className={css.sendCaret}
              aria-expanded={sendMenuOpen}
              aria-haspopup="menu"
              aria-label={t('quote.sendMenuOpen')}
              title={t('quote.sendMenuOpen')}
              onClick={() => { setSendMenuOpen(open => !open) }}
            >
              <IconChevronDown size={11} />
            </button>
            {sendMenuOpen && (
              <>
                <button type="button" className={css.sendBackdrop} aria-label={t('quote.sendMenuOpen')} onClick={() => { setSendMenuOpen(false) }} />
                <div className={css.sendMenu} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={css.sendMenuItem}
                    title={t('quote.sendToAgentHint')}
                    onClick={() => {
                      setSendMenuOpen(false)
                      onSendToAgent()
                    }}
                  >
                    {t('quote.sendMenuSnapshot')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 统计行情概览（图表页签专属：基本面页签有自己的信息网格） */}
      {viewTab === 'chart' && (
        <div className={css.stats}>
          <span className={css.stat}><label>{t('quote.prevClose')}</label>{fmtPrice(readoutPrevClose)}</span>
          <span className={css.stat}><label>{t('quote.open')}</label>{fmtPrice(readoutCandle?.open)}</span>
          <span className={css.stat}><label>{t('quote.high')}</label>{fmtPrice(readoutCandle?.high)}</span>
          <span className={css.stat}><label>{t('quote.low')}</label>{fmtPrice(readoutCandle?.low)}</span>
          <span className={css.stat}><label>{t('quote.volume')}</label>{fmtCompact(readoutCandle?.volume, numLocale)}</span>
        </div>
      )}

      {/* 周期胶囊条 + 指标弹层按钮（图表页签） */}
      {viewTab === 'chart' && (
        <div className={css.toolbar}>
          <div className={css.intervalTabs} role="tablist" aria-label="interval">
            {intervals.map(entry => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={entry === chartInterval}
                className={css.intervalTab}
                data-active={entry === chartInterval ? 'true' : undefined}
                onClick={() => {
                  setIntervalFor(entry)
                  writeInterval(market, entry)
                }}
              >
                {t(INTERVAL_KEY[entry] ?? 'interval.1d')}
              </button>
            ))}
          </div>

        <div className={css.toolbarActions}>
          {/* 交易工作台开关（issue #40；支持接入了交易注册面的各市场） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={tradeDeskOpen ? 'true' : undefined}
            aria-pressed={tradeDeskOpen}
            onClick={() => {
              setTradeDeskOpen((open) => {
                writeTradeDeskOpen(!open)
                return !open
              })
            }}
          >
            {t('trade.toggle')}
          </button>
          {/* 盘口竖栏开关（issue #39；紧挨区间统计左侧） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={orderbookOpen ? 'true' : undefined}
            aria-pressed={orderbookOpen}
            onClick={() => {
              setOrderbookOpen((open) => {
                writeOrderbookOpen(!open)
                return !open
              })
            }}
          >
            {t('orderbook.toggle')}
          </button>
          {/* 策略信号标记开关（issue #41） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={markerState.showSignals ? 'true' : undefined}
            aria-pressed={markerState.showSignals}
            title={t('marker.signal.toggleTitle')}
            onClick={() => markerStore.toggleSignals()}
          >
            {t('marker.signal.toggle')}
          </button>
          {/* 知识事件图钉开关（issue #41） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={markerState.showKnowledgeEvents ? 'true' : undefined}
            aria-pressed={markerState.showKnowledgeEvents}
            title={t('marker.knowledge.toggleTitle')}
            onClick={() => markerStore.toggleKnowledgeEvents()}
          >
            {t('marker.knowledge.toggle')}
          </button>
          {/* 区间统计（同花顺式框选统计；紧挨「技术指标」按钮左侧） */}
            <button
              type="button"
              className={css.pickerButton}
              data-active={rangeMode ? 'true' : undefined}
              aria-pressed={rangeMode}
              title={t('quote.rangeStatsHint')}
              onClick={() => {
                setRangeMode((open) => {
                  if (open) setRangeSelection(null)
                  return !open
                })
              }}
            >
              {t('quote.rangeStats')}
            </button>
            <div className={css.indicatorAnchor}>
              <button
                type="button"
                className={css.pickerButton}
                aria-expanded={pickerOpen}
                aria-haspopup="dialog"
                onClick={() => { setPickerOpen(open => !open) }}
              >
                <IconIndicators size={13} />
                {t('indicator.picker')}
              </button>
              {pickerOpen && (
                <IndicatorPicker
                  t={t}
                  instances={visibleInstances}
                  activeInstances={instances}
                  editingIndicator={editingIndicator}
                  scopeKey={market !== undefined && symbol !== undefined ? symbolScopeKey(market, symbol) : undefined}
                  symbolLabel={symbol}
                  onToggle={(id) => {
                    toggleIndicatorVisible(id)
                    setEditingIndicator(null)
                  }}
                  onEdit={(id) => { setEditingIndicator(current => current === id ? null : id) }}
                  onApply={(id, params) => {
                    // issue #72：当前标的已有参数覆盖 → 写覆盖；否则写全局 params。
                    const scopeKey = market !== undefined && symbol !== undefined ? symbolScopeKey(market, symbol) : undefined
                    const instance = visibleInstances.find(candidate => candidate.id === id)
                    const hasOverride = scopeKey !== undefined && instance?.symbolParams?.[scopeKey] !== undefined
                    setIndicatorParams(id, params, hasOverride ? scopeKey : undefined)
                    setEditingIndicator(null)
                  }}
                  onRemoveGlobal={(id) => {
                    removeIndicator(id)
                    setEditingIndicator(null)
                  }}
                  onDelete={(id) => { void deleteIndicator(id) }}
                  onClose={() => {
                    setPickerOpen(false)
                    setEditingIndicator(null)
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 主图指标悬停/最新读数分量（各分量独立着色）。VOL/MACD 等副图指标
          的读数在 TvChart 各自 pane 内渲染，不进主图读数行。 */}
      {viewTab === 'chart' && mainOverlays.length > 0 && (
        <div className={css.indicatorReadout}>
          {mainOverlays.flatMap(group => outputReadouts(group, readoutIndex))}
        </div>
      )}

      {viewTab === 'chart' && kError !== null && <div className={css.error}>{t('quote.loadFailedColon', { error: kError })}</div>}

      {/* 图表主舞台 / 基本面页签（互斥挂载）；crypto 图表下方挂衍生品指标条（issue #38），
          右侧可折叠盘口竖栏（issue #39） */}
      {activeLens !== 'options' && viewTab === 'chart' ? (
        <div className={css.chartRow}>
          <div className={css.chartColumn}>
            <div className={css.chartBox}>
            {klines !== null && bars.length > 0 && (
              <TvChart
                bars={bars}
                volumes={volumes}
                dataKey={`${market}:${symbol}:${chartInterval}`}
                intraday={INTRADAY_INTERVALS.has(chartInterval)}
                colorMode={colorMode}
                mainOverlays={mainOverlays}
                subIndicators={subIndicators}
                readoutIndex={readoutIndex}
                onHoverIndex={setHoverIndex}
                onCaptureReady={(capture) => { captureRef.current = capture }}
                rangeSelectionMode={rangeMode}
                selection={rangeSelection}
                onRangeSelect={setRangeSelection}
                signalMarkers={markerState.showSignals ? signalMarkers : undefined}
                knowledgeMarkers={markerState.showKnowledgeEvents ? knowledgeMarkers : undefined}
                onMarkerHover={setMarkerHover}
                markerTexts={{ entry: t('trade.buy'), exit: t('trade.sell') }}
                numLocale={numLocale}
              />
            )}
            {rangeMode && rangeStats !== null && (
              <div className={css.rangePanel} role="dialog" aria-label={t('quote.rangeStats')}>
                <div className={css.rangePanelHead}>
                  <span>{t('quote.rangeStats')}</span>
                  <button
                    type="button"
                    className={css.rangePanelClose}
                    aria-label={t('range.closePanel')}
                    onClick={() => { setRangeSelection(null) }}
                  >
                    ×
                  </button>
                </div>
                <div className={css.rangePanelSpan}>
                  {fmtDay(rangeStats.startTime)} ~ {fmtDay(rangeStats.endTime)}
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.change')}</span>
                  <span style={{ color: directionColor(rangeStats.changePercent, colorMode) }}>
                    {fmtPercent(rangeStats.changePercent)}
                  </span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.changeAbs')}</span>
                  <span style={{ color: directionColor(rangeStats.change, colorMode) }}>
                    {fmtChange(rangeStats.change)}
                  </span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.high')}</span>
                  <span>{fmtPrice(rangeStats.rangeHigh)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.low')}</span>
                  <span>{fmtPrice(rangeStats.rangeLow)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.amplitude')}</span>
                  <span>{fmtPercent(rangeStats.amplitudePercent)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.volume')}</span>
                  <span>{fmtCompact(rangeStats.volume, numLocale)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.bars')}</span>
                  <span>{rangeStats.bars}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.upDays')}</span>
                  <span>{rangeStats.upBars}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.downDays')}</span>
                  <span>{rangeStats.downBars}</span>
                </div>
              </div>
            )}
            {/* 标记悬停 Tooltip：绝对定位在 chartBox（position:relative）内，
                坐标系与 TvChart 回报的容器坐标一致 */}
            {markerHover !== null && (
              <MarkerTooltip
                x={markerHover.x}
                y={markerHover.y}
                containerWidth={markerHover.containerWidth}
                containerHeight={markerHover.containerHeight}
                t={t}
                signal={markerHover.signal ? {
                  action: markerHover.signal.action,
                  price: markerHover.signal.price,
                  reason: markerHover.signal.reason,
                  time: markerHover.signal.time,
                } : undefined}
                knowledge={markerHover.knowledge ? {
                  title: markerHover.knowledge.title,
                  credibility: markerHover.knowledge.credibility,
                  cardId: markerHover.knowledge.cardId,
                } : undefined}
              />
            )}
            </div>
          </div>
          {(orderbookOpen || tradeDeskOpen) && (
            <div className={css.rightSidebar}>
              {orderbookOpen && (
                <OrderbookPane
                  t={t}
                  orderbook={orderbook}
                  trades={trades}
                  orderbookLoading={orderbookLoading}
                  colorMode={colorMode}
                  onClose={() => {
                    setOrderbookOpen(false)
                    writeOrderbookOpen(false)
                  }}
                />
              )}
              {tradeDeskOpen && (
                <OrderPanel
                  t={t}
                  symbol={symbol ?? ''}
                  market={activeMarket}
                  suggestedPrice={ticker?.price}
                  colorMode={colorMode}
                  tradeMode={tradeMode}
                  paperCash={paperCash}
                  availableCash={availableCash}
                  currentPositionSize={currentPositionSize}
                  onResetPaper={() => {
                    paperTradingStore.resetAccount()
                  }}
                  onToggleTradeMode={handleToggleTradeMode}
                  onSubmit={onSubmitGuiOrder}
                  onClose={() => {
                    setTradeDeskOpen(false)
                    writeTradeDeskOpen(false)
                  }}
                />
              )}
            </div>
          )}
        </div>
      ) : activeLens === 'options' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {optionPaneView === 'overview'
            ? (
              <>
                <OptionsOverview
                  t={t}
                  colorMode={colorMode}
                  overview={optionsOverview}
                  failure={optionOverviewFailure}
                  loaded={optionOverviewLoaded}
                  sort={overviewSort}
                  onSortChange={setOverviewSort}
                  onPickRow={onPickOverviewRow}
                  {...(scanAll !== undefined ? { onScanAll: scanAll } : {})}
                  {...(scanRow !== undefined ? { onScanRow: scanRow } : {})}
                />
                <OptionsCycleLoop
                  t={t}
                  loop={optionsLoop}
                  failure={optionLoopFailure}
                  loaded={optionLoopLoaded}
                  names={optionNames}
                />
              </>
            )
            : (
              <OptionsStage
                t={t}
                months={optionExpiries?.months ?? []}
                selectedMonth={optionMonth}
                onSelectMonth={setOptionMonth}
                chain={optionChain}
                failure={optionFailure}
                loaded={optionChainLoaded}
                colorMode={colorMode}
                underlyingSymbol={symbol ?? ''}
                underlyingName={displayName}
                multiplier={optionUnderlyingRow?.multiplier ?? 10000}
                heldQty={optionUnderlyingRow?.heldQty}
                forecast={optionForecast}
                onBackToOverview={() => { setOptionPane('overview') }}
                onViewSpot={() => { setLens('spot'); setStageTab('chart') }}
                onTradeSpot={() => { setTradeDeskOpen(true) }}
                {...(scanUnderlying !== undefined ? { onScanUnderlying: scanUnderlying } : {})}
                {...(sendLegToAgent !== undefined ? { onSendLegToAgent: sendLegToAgent } : {})}
              />
            )}
        </div>
      ) : viewTab === 'fundamentals' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <FundamentalsStage t={t} useSelection={useSelection} />
        </div>
      ) : viewTab === 'news' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <NewsFeedPane
            items={newsItems}
            unavailable={newsUnavailable}
            fullHeight
            filterType="media"
            t={t}
            fillComposer={fillComposer}
          />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <NewsFeedPane
            items={newsItems}
            unavailable={newsUnavailable}
            fullHeight
            filterType="exchange"
            t={t}
            fillComposer={fillComposer}
          />
        </div>
      )}

      {/* 底部横向指标词条带（图表页签） */}
      {stageTab === 'chart' && (
        <div className={css.quickIndicatorBar} role="toolbar" aria-label="Quick indicators">
          {allDefinitions.map(def => {
            const active = visibleInstances.some(inst => inst.id === def.id)
            return (
              <button
                key={def.id}
                type="button"
                className={css.quickIndicatorTag}
                data-active={active ? 'true' : undefined}
                onClick={() => toggleIndicatorVisible(def.id)}
                title={`${def.title} (${def.pane === 'main' ? t('indicator.group.main') : t('indicator.group.sub')})`}
              >
                {def.title}
              </button>
            )
          })}
        </div>
      )}

      {/* 底部富途式市场状态栏 */}
      <div className={css.statusBar} role="status">
        <span className={css.statusSession}>
          <span className={css.statusDot} style={{ background: sessionStatus.color }} />
          {t(sessionStatus.statusKey)}
        </span>
        {indexDefs.map(def => {
          const indexTicker = indexTickers[def.symbol]
          const price = indexTicker?.price
          const prevClose = (indexTicker as { prevClose?: number })?.prevClose
          const pct = (indexTicker as { changePercent?: number })?.changePercent ?? changePercent(price, prevClose)
          const color = directionColor(pct ?? 0, colorMode)
          return (
            <span key={def.symbol} className={css.indexGroup}>
              <span className={css.indexName}>{t(def.nameKey)}</span>
              {price !== undefined ? (
                <span style={{ color, fontWeight: 600 }}>
                  {fmtPrice(price)} {fmtPercent(pct)}
                </span>
              ) : (
                <span style={{ color: 'var(--dsw-futu-text-muted, #8e95a3)' }}>—</span>
              )}
            </span>
          )
        })}
        <span className={css.statusClock}>{clock}</span>
      </div>
    </div>
  )
}

function IndicatorPicker(props: {
  t: Translate
  /** 当前标的可见实例（勾选态/参数编辑的数据源）。 */
  instances: IndicatorInstance[]
  /** 全量激活名册（含对当前标的隐藏的实例）——「全局移除」按钮的存在性判定。 */
  activeInstances: IndicatorInstance[]
  editingIndicator: string | null
  /** 当前标的的 scope 键（`${market}:${symbol}`）；undefined = 无聚焦标的。 */
  scopeKey?: string | undefined
  /** 当前标的 symbol（覆盖提示文案用）。 */
  symbolLabel?: string | undefined
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onApply: (id: string, params: Record<string, number>) => void
  onRemoveGlobal: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t, instances, activeInstances, editingIndicator, scopeKey, symbolLabel, onToggle, onEdit, onApply, onRemoveGlobal, onDelete, onClose } = props
  const definitions = indicators.list()
  const empty = definitions.length === 0
  return (
    <>
      <div className={css.pickerBackdrop} onClick={onClose} aria-hidden="true" />
      <div className={css.pickerPanel} role="dialog" aria-label={t('indicator.picker')}>
        <div className={css.pickerTitle}>{t('indicator.picker')}</div>
        {empty ? (
          <div className={css.pickerGroupTitle}>{t('indicator.empty')}</div>
        ) : (
          <>
            <PickerGroup
              title={t('indicator.group.main')}
              definitions={definitions.filter(definition => definition.pane === 'main')}
              instances={instances}
              activeInstances={activeInstances}
              editingIndicator={editingIndicator}
              scopeKey={scopeKey}
              symbolLabel={symbolLabel}
              t={t}
              onToggle={onToggle}
              onEdit={onEdit}
              onApply={onApply}
              onRemoveGlobal={onRemoveGlobal}
              onDelete={onDelete}
            />
            <PickerGroup
              title={t('indicator.group.sub')}
              definitions={definitions.filter(definition => definition.pane === 'sub')}
              instances={instances}
              activeInstances={activeInstances}
              editingIndicator={editingIndicator}
              scopeKey={scopeKey}
              symbolLabel={symbolLabel}
              t={t}
              onToggle={onToggle}
              onEdit={onEdit}
              onApply={onApply}
              onRemoveGlobal={onRemoveGlobal}
              onDelete={onDelete}
            />
          </>
        )}
      </div>
    </>
  )
}

function PickerGroup(props: {
  title: string
  definitions: readonly IndicatorDefinition[]
  /** 当前标的可见实例（勾选态/参数编辑）。 */
  instances: readonly IndicatorInstance[]
  /** 全量激活名册（「全局移除」按钮存在性）。 */
  activeInstances: readonly IndicatorInstance[]
  editingIndicator: string | null
  scopeKey?: string | undefined
  symbolLabel?: string | undefined
  t: Translate
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onApply: (id: string, params: Record<string, number>) => void
  onRemoveGlobal: (id: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { title, definitions, instances, activeInstances, editingIndicator, scopeKey, symbolLabel, t, onToggle, onEdit, onApply, onRemoveGlobal, onDelete } = props
  return (
    <div className={css.pickerGroup}>
      <div className={css.pickerGroupTitle}>{title}</div>
      {definitions.map(definition => {
        const visible = instances.find(candidate => candidate.id === definition.id) ?? null
        const active = activeInstances.some(candidate => candidate.id === definition.id)
        const editing = editingIndicator === definition.id
        // issue #72：编辑器初值 = 当前标的生效参数（覆盖优先），有覆盖时展示提示。
        const scopedParams = visible !== null && scopeKey !== undefined ? visible.symbolParams?.[scopeKey] : undefined
        return (
          <div key={definition.id} className={css.pickerRow}>
            <label className={css.pickerLabel}>
              <input
                type="checkbox"
                checked={visible !== null}
                onChange={() => onToggle(definition.id)}
              />
              <span>{definition.title}</span>
            </label>
            {visible !== null && (
              <button
                type="button"
                className={css.pickerParams}
                data-open={editing ? 'true' : undefined}
                onClick={() => onEdit(definition.id)}
              >
                {t('indicator.params')}
              </button>
            )}
            {active && (
              <button
                type="button"
                className={css.pickerParams}
                title={t('indicator.removeGlobal')}
                aria-label={t('indicator.removeGlobal')}
                onClick={() => {
                  if (window.confirm(t('indicator.removeGlobalConfirm'))) onRemoveGlobal(definition.id)
                }}
              >
                {t('indicator.removeGlobal')}
              </button>
            )}
            {isCustomIndicator(definition.id) && (
              <button
                type="button"
                className={css.pickerParams}
                title={t('indicator.delete')}
                aria-label={t('indicator.delete')}
                onClick={() => {
                  if (window.confirm(t('indicator.deleteConfirm'))) onDelete(definition.id)
                }}
              >
                {t('indicator.delete')}
              </button>
            )}
            {editing && visible !== null && (
              <IndicatorParamEditor
                definition={definition}
                initial={scopedParams ?? visible.params}
                overrideHint={scopedParams !== undefined && symbolLabel !== undefined
                  ? t('indicator.symbolOverride', { symbol: symbolLabel })
                  : undefined}
                t={t}
                onCancel={() => onEdit(definition.id)}
                onApply={(params) => onApply(definition.id, params)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function IndicatorParamEditor(props: {
  definition: IndicatorDefinition
  initial: Record<string, number>
  /** issue #72：当前编辑的是某标的的专属覆盖时展示的提示文案。 */
  overrideHint?: string | undefined
  t: Translate
  onCancel: () => void
  onApply: (params: Record<string, number>) => void
}): React.JSX.Element {
  const { definition, initial, t } = props
  const [draft, setDraft] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const spec of definition.params) out[spec.key] = initial[spec.key] ?? spec.default
    return out
  })

  return (
    <div className={css.paramEditor}>
      {props.overrideHint !== undefined && <div className={css.paramHint}>{props.overrideHint}</div>}
      {definition.params.map(spec => (
        <label key={spec.key} className={css.paramRow}>
          <span>{spec.label}</span>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            value={Number.isFinite(draft[spec.key]) ? draft[spec.key] : spec.default}
            onChange={(event) => {
              const next = Number(event.target.value)
              setDraft(prev => ({ ...prev, [spec.key]: Number.isFinite(next) ? next : spec.default }))
            }}
          />
        </label>
      ))}
      <div className={css.paramActions}>
        <button type="button" className={css.paramButton} onClick={props.onCancel}>{t('indicator.cancel')}</button>
        <button type="button" className={`${css.paramButton} ${css.paramApply}`} onClick={() => props.onApply(draft)}>{t('indicator.apply')}</button>
      </div>
    </div>
  )
}

function outputReadouts(
  group: TvIndicatorGroup & { id: string; pane: 'main' | 'sub'; title: string },
  readoutIndex: number | null,
): Array<React.JSX.Element | null> {
  if (readoutIndex === null) return []
  return group.outputs.map((output) => {
    const value = output.values[readoutIndex]
    if (value === undefined || !Number.isFinite(value)) return null
    return (
      <span key={`${group.key}.${output.key}`} style={{ color: output.color, fontWeight: 500 }}>
        {group.title} {output.key}: {value.toFixed(2)}
      </span>
    )
  })
}

function withTickerBar(prev: Kline[], ticker: Ticker): Kline[] {
  const last = prev[prev.length - 1]
  if (last === undefined) return prev
  const price = ticker.price
  if (!Number.isFinite(price) || price <= 0) return prev
  if (last.close === price && last.high >= price && last.low <= price) return prev
  const merged: Kline = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  }
  return [...prev.slice(0, -1), merged]
}

function formatStatusBarClock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** YYYY-MM-DD（区间统计面板的日期跨度）。 */
function fmtDay(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function readInterval(market: MarketId): string {
  try {
    const raw = localStorage.getItem(INTERVAL_KEY_PREFIX + market)
    if (raw !== null && (MARKET_INTERVALS[market] ?? []).includes(raw)) return raw
  } catch { /* 忽略 */ }
  return '1d'
}

function writeInterval(market: MarketId, interval: string): void {
  try {
    localStorage.setItem(INTERVAL_KEY_PREFIX + market, interval)
  } catch { /* 忽略 */ }
}

/** 盘口竖栏开关记忆（issue #39；跨会话，坏值/隐私模式回退默认开）。 */
function readOrderbookOpen(): boolean {
  try {
    return localStorage.getItem(ORDERBOOK_OPEN_KEY) !== '0'
  } catch { /* 忽略 */ }
  return true
}

function writeOrderbookOpen(open: boolean): void {
  try {
    localStorage.setItem(ORDERBOOK_OPEN_KEY, open ? '1' : '0')
  } catch { /* 忽略 */ }
}

/** 交易台开关记忆（issue #40；默认关——安全敏感面）。 */
function readTradeDeskOpen(): boolean {
  try {
    return localStorage.getItem(TRADE_DESK_OPEN_KEY) === '1'
  } catch { /* 忽略 */ }
  return false
}

function writeTradeDeskOpen(open: boolean): void {
  try {
    localStorage.setItem(TRADE_DESK_OPEN_KEY, open ? '1' : '0')
  } catch { /* 忽略 */ }
}

const TAB_KEY: Record<MarketId, MarketLocaleKey> = {
  cn: 'tab.cn',
}
