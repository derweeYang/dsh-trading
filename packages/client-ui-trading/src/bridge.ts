/**
 * 行情 HTTP 桥的纯逻辑层：请求解析 → 市场服务分发 → 统一 JSON 形状。
 *
 * 设计约束：
 * - 铁律 #5（数据合规）：本桥是无状态透传，不做任何缓存/落盘；频率由客户端轮询
 *   节奏控制，symbols 数量服务端封顶（MAX_SYMBOLS）。
 * - 服务解析 registry-first（2026-08-30 注册表模式，架构评审整改 #1）：每请求经
 *   tradingMarketDataRegistry 按路由当前值惰性解析——settings 切换交易所即刻生效
 *   （GUI 热切换，无 watch 无重启）；注册表缺席或无对应注册项时回退旧的市场键
 *   直读（老部署/连接器未升级）。preset 平面不经本桥（会话隔离）。
 * - 业务错误一律 HTTP 200 + { ok:false, code, message }（错误词汇沿用
 *   TradingErrorCode 惯例）；仅协议层错误用 4xx。
 * - Issue #19：提供 /indicators/custom 端点（GET/DELETE），供前端同步自定义指标。
 * - Issue #24：提供 /knowledge/cards 端点（GET），供前端读取沉淀的知识卡片。
 * - Issue #65：提供 /holdings 七个端点 + /fx 端点（统一资产台账，契约 §3/§4）。
 */
import type { AccountBalance, CnOptionsService, CnOptionsTradeService, FundamentalsPackage, Interval, KernelReport, Kline, MarketDataService, NewsAggregator, NewsItem, OptionArbitrageScanResult, OptionBarContextPacket, OptionBarDailyIv, OptionBarFact, OptionChain, OptionCycle, OptionCycleLoop, OptionExpiryCalendar, OptionImpliedVolResult, OptionIntradayBox, OptionOrder, OptionOverview, OptionOverviewRow, OptionOverviewSort, OptionPaperAccountsWire, OptionPaperBookId, OptionPaperBookWire, OptionPaperDeskWire, OptionPaperFillsWire, OptionPosition, OptionStrategyRequest, OptionStrategyResult, OptionUnderlying, OptionVolAnalyticsQuery, Order, Orderbook, Position, StockFundamentals, Ticker, TradeFill, TradeService, TradeTick, UnderlyingLink, OptionPrediction, OptionPredictionAutoSettleResult, OptionPredictionBoard, OptionPredictionTrack, OptionPredictionDraft, OptionPredictionSettle, PredictionKnowledgeItem, MarketExpectation, VolExpectation, PredictionBias } from '@dshtrading/api'
import { OPTION_PAPER_FEE_PER_CONTRACT } from '@dshtrading/api'
import {
  OVERVIEW_KLINE_LIMIT,
  applyTicker,
  buildOverviewMetrics,
  hv20FromKlines,
  composeScanAllPrompt,
  composeScanPrompt,
  extractAtmIv,
  extractIvPercentile,
  hydrateOverviewRow,
  parseOverviewSnapshotRow,
  persistableOverviewRow,
  sortOverviewRows,
  spotSymbolOf,
} from './option-overview.ts'
import {
  aggregateNews as aggregateCnNews,
  attachOverviewStrategies,
  calibrateNextForecast,
  collectIntradayBox,
  CYCLE_HORIZON_MS,
  cycleId,
  etfSpotSymbol,
  fetchCnFundamentalsPackage,
  atmIvPercentile,
  ivDailyPath,
  klinesToPredictionBars,
  dayPriorOf,
  resolvePredictionAutoAsOf,
  loadLatestPacket,
  loadLatestRecommendation,
  loadOverviewSnapshot,
  writeOverviewSnapshot,
  loadPaperState,
  loadPaperDesk,
  markLegValueCny,
  PAPER_DESK_DEFAULT_DAYS,
  PAPER_DESK_MAX_DAYS,
  OptionCycleBook,
  OPTION_ARB_CHAIN_TTL_MS,
  appendJsonlLine,
  CB_SCAN_INTERVAL_MS,
  cbScanPath,
  readJsonl,
  resetPaperState,
  sessionFlag,
  tagIvRegime,
  optionsDataRoot,
  quoteFillPriceWithSource,
  type PaperMarkQuote,
  realizedInWindow,
  replayCyclesIntoBook,
  scorePreviousCycle,
  selectBoxTargets,
  shanghaiCalendarDate,
  shanghaiBucketStartMs,
  scanCbDiscount,
  shouldRunCbScan,
  tryArbPaperCycle,
  tryPaperManage,
} from '@dshtrading/kit-cn'
import type { ChartActivationStore, CustomIndicatorRecord, CustomIndicatorStore, IndicatorInstance } from '@dshtrading/indicators'
import { clampActivationParams, createMemoryChartActivationStore, createMemoryCustomIndicatorStore, resolveIndicatorSpec, sanitizeInstance, symbolScopeKey, withHiddenScopes } from '@dshtrading/indicators'
import type { KnowledgeCard, KnowledgeCardStore } from '@dshtrading/knowledge'
import { createMemoryKnowledgeCardStore } from '@dshtrading/knowledge'
import type { CustomStrategyRecord, CustomStrategyStore } from '@dshtrading/strategies'
import {
  createMemoryCustomStrategyStore,
  createMemoryBuiltinTombstonesStore,
  createMemoryCustomScreenerStore,
  isBuiltinStrategyId,
  isBuiltinScreenerId,
} from '@dshtrading/strategies'
import type { BuiltinTombstonesStore, CustomScreenerRecord, CustomScreenerStore } from '@dshtrading/strategies'
// Node 侧沙箱校验（策略/选股器管理 PUT 落盘前的 vm 熔断试算）；bridge.ts 仅 node 半
// 加载，client 打包不 import 本文件（client 半只经 api.ts 走 HTTP）。
import { validateCustomStrategyNode, validateCustomScreenerNode } from '@dshtrading/strategies/plugin'
import type { SelectionStore, WatchlistInstrument, WatchlistStore, WatchlistsMap } from '@dshtrading/watchlist'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '@dshtrading/watchlist'
// 统一资产台账（issue #65）：type-only import——@dshtrading/holdings 由并行流建设，
// 缺席时本包 vitest 不受影响（擦除）；运行时 store 走 host 注入 + 本文件内存兜底。
import type { Holding, HoldingCurrency, NewHolding, NewHoldingInput } from '@dshtrading/holdings'
import { createMemoryHoldingsStore } from '@dshtrading/holdings'
import type { FxFetchLike } from '@dshtrading/holdings/fx'
import { createFxService } from '@dshtrading/holdings/fx'
import { PredictionStore } from './prediction-store.ts'

/** 本桥支持的市场（与连接器服务键一一对应）。 */
export type MarketId = 'cn'

export const MARKET_IDS: readonly MarketId[] = ['cn']

/** market → Context 服务键（@dshtrading/api 的 Context 增强）。 */
export const MARKET_SERVICE_KEYS: Record<MarketId, string> = {
  cn: 'tradingCnMarketData',
}

/** 注册表服务的最小形状（鸭式，与 @dshtrading/router 的 MarketDataRegistryLike 同构）。 */
export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataService } | undefined
}

/** 交易注册表服务的最小形状（issue #40，鸭式；api 包 TradeRegistry 同构）。 */
export interface TradeRegistryLike {
  active(market: string): { provider: string; service: TradeService } | undefined
}

/** 新闻注册表服务的最小形状（issue #37，鸭式；api 包 TradingNewsRegistry 同构）。 */
export interface TradingNewsRegistryLike {
  register(market: string, aggregator: NewsAggregator): () => void
  get(market: string): NewsAggregator | undefined
}

/**
 * 桥宿主工厂（registry-first 解析的唯一实现，node 半与单测共用）：
 * - getMarketService：注册表有激活注册项 → 用之；否则回退 legacy 市场键直读
 *   （2026-08-30 前形态：连接器老 dataplane 互斥 provide 市场键的部署）。
 * - activeProvider：优先报告实际供数的注册项 provider；注册表未裁决时回退 router 值
 *   （选中但未注册 → 用户能在 GUI 看到设置目标，行情区报「未安装/未激活」）。
 */
export function createBridgeHost(services: {
  registry?: MarketDataRegistryLike | undefined
  tradeRegistry?: TradeRegistryLike | undefined
  router?: { activeProvider(market: string): string | undefined } | undefined
  legacy(market: MarketId): MarketDataService | undefined
  customIndicatorsStore?: CustomIndicatorStore | undefined
  /** 图表激活名册 store（issue #63，可选）。 */
  chartActivationsStore?: ChartActivationStore | undefined
  knowledgeStore?: KnowledgeCardStore | undefined
  strategyStore?: CustomStrategyStore | undefined
  /** 内置策略/选股器墓碑 store（策略管理，可选）。 */
  tombstonesStore?: BuiltinTombstonesStore | undefined
  /** 自定义选股器 store（选股器管理，可选）。 */
  screenerStore?: CustomScreenerStore | undefined
  watchlistStore?: WatchlistStore | undefined
  selectionStore?: SelectionStore | undefined
  /** 统一资产台账 store（issue #65；缺席 → 进程内内存兜底）。 */
  holdingsStore?: HoldingsStoreLike | undefined
  /** FX 服务（issue #65；缺席 → 桥内兜底 fetcher，契约 §4 减文件缓存）。 */
  fetchFxRates?: FxRatesFetcher | undefined
  /** 新闻注册表（issue #37）。 */
  newsRegistry?: TradingNewsRegistryLike | undefined
  /** CN ETF 期权只读服务（host 面 tradingCnOptions；缺席 → 桥返回 NOT_IMPLEMENTED）。 */
  cnOptions?: CnOptionsService | undefined
  /** CN ETF 期权交易服务（host 面 tradingCnOptionsTrade；缺席 → 桥返回 NOT_IMPLEMENTED）。 */
  cnOptionsTrade?: CnOptionsTradeService | undefined
}): BridgeHost {
  return {
    getMarketService: market => {
      const active = services.registry?.active(market)
      if (active !== undefined) return active.service
      return services.legacy(market)
    },
    getTradeService: market => services.tradeRegistry?.active(market)?.service,
    activeProvider: market => services.registry?.active(market)?.provider ?? services.router?.activeProvider(market),
    customIndicatorsStore: services.customIndicatorsStore ?? createMemoryCustomIndicatorStore(),
    chartActivationsStore: services.chartActivationsStore ?? createMemoryChartActivationStore(),
    knowledgeStore: services.knowledgeStore ?? createMemoryKnowledgeCardStore(),
    strategyStore: services.strategyStore ?? createMemoryCustomStrategyStore(),
    tombstonesStore: services.tombstonesStore ?? createMemoryBuiltinTombstonesStore(),
    screenerStore: services.screenerStore ?? createMemoryCustomScreenerStore(),
    watchlistStore: services.watchlistStore ?? createMemoryWatchlistStore(),
    selectionStore: services.selectionStore ?? createMemorySelectionStore(),
    holdingsStore: services.holdingsStore ?? createFallbackHoldingsStore(),
    fetchFxRates: services.fetchFxRates,
    newsRegistry: services.newsRegistry,
    getCnOptions: () => services.cnOptions,
    getCnOptionsTrade: () => services.cnOptionsTrade,
  }
}

/** 单次批量报价的 symbols 封顶（保护公共端点，超出部分直接拒绝）。 */
export const MAX_SYMBOLS = 32

/** 单次 K 线 limit 封顶（保护公共端点；连接器可在此基础上进一步收紧）。 */
export const MAX_KLINE_LIMIT = 1000

/**
 * 期权长代码 / 现货符号（阶段 4 互联 resolve 用；与 connector-options rest.ts 的
 * LONG_CODE / SPOT_CODE 及 python synth.LONG_CODE_RE 保持一致——同步测试锁行为）。
 */
const OPTION_LONG_CODE = /^(\d{6})([CP])(\d{4})M(\d{5})$/
const OPTION_SPOT_CODE = /^(\d{6})(?:\.(?:SH|SZ))?$/

/** 宿主面：桥对 cordis ctx 的最小依赖（便于单测注入假件）。 */
export interface BridgeHost {
  /** 取市场行情服务；未安装/未激活返回 undefined。 */
  getMarketService(market: MarketId): MarketDataService | undefined
  /** 该市场当前激活的 provider slug（router 设置；可能 undefined）。 */
  activeProvider(market: MarketId): string | undefined
  /** 自定义指标存储（可选）。 */
  customIndicatorsStore?: CustomIndicatorStore
  /** 图表激活名册存储（可选，issue #63）。 */
  chartActivationsStore?: ChartActivationStore
  /** 知识卡片存储（可选）。 */
  knowledgeStore?: KnowledgeCardStore
  /** 自定义策略存储（可选，issue #31）。 */
  strategyStore?: CustomStrategyStore
  /** 内置策略/选股器墓碑存储（可选，策略管理；createBridgeHost 已兜底内存实现）。 */
  tombstonesStore?: BuiltinTombstonesStore
  /** 自定义选股器存储（可选，选股器管理；createBridgeHost 已兜底内存实现）。 */
  screenerStore?: CustomScreenerStore
  /** 自选股存储（可选，issue #32）。 */
  watchlistStore?: WatchlistStore
  /** 选中标的存储（可选，issue #32）。 */
  selectionStore?: SelectionStore
  /** 统一资产台账存储（可选，issue #65；createBridgeHost 已兜底内存实现）。 */
  holdingsStore?: HoldingsStoreLike
  /** FX 服务（可选，issue #65；缺席 → 桥内兜底 fetcher）。 */
  fetchFxRates?: FxRatesFetcher | undefined
  /**
   * 交易服务（可选，issue #40）：tradeRegistry 按 market 解析；未注册 → undefined
   * （交易台整体隐藏）。**安全语义**：GUI 下单默认请求实盘（dryRun: false），
   * 由服务缝闸门（连接器 dryRun 缺省 true + liveTrading 显式开关）fail-closed，
   * 桥层如实转达闸门错误，不伪造成交。
   */
  getTradeService?(market: MarketId): TradeService | undefined
  /** 新闻注册表（可选，issue #37）：各市场 Kit 注册的新闻聚合器。 */
  newsRegistry?: TradingNewsRegistryLike | undefined
  /** CN ETF 期权只读服务；未挂 connector-options → undefined。 */
  getCnOptions?(): CnOptionsService | undefined
  /** CN ETF 期权交易服务（阶段 3）；未挂 connector-options 交易半 → undefined。 */
  getCnOptionsTrade?(): CnOptionsTradeService | undefined
}

export interface MarketInfoWire {
  id: MarketId
  provider?: string
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

export interface MarketsWire {
  markets: MarketInfoWire[]
}

export interface TickersWire {
  tickers: Record<string, TickerOutcome>
}

export interface KlinesWire {
  klines: Kline[]
}

export interface SymbolInfoWire {
  symbol: string
  name?: string
}

export interface SymbolsWire {
  symbols: SymbolInfoWire[]
}

export interface FundamentalsWire {
  ok: true
  fundamentals: StockFundamentals
}

export interface OptionUnderlyingsWire {
  ok: true
  underlyings: readonly OptionUnderlying[]
}

/** 现货 ↔ 期权双向规范化结果（阶段 4 互联，GET /options/resolve）。 */
export interface OptionResolveWire {
  ok: true
  input: string
  /** 规范 6 位 ETF 代码（名册主键）。 */
  underlying: string
  /** 名册命中时给出现货跳转符号与长代码前缀。 */
  link?: UnderlyingLink
  /** 输入本身是期权长代码时解析出的合约要素。 */
  contract?: {
    code: string
    optionType: 'C' | 'P'
    /** 行权价（长代码 5 位编码 ÷1000，如 02850 → 2.85）。 */
    strike: number
    expiryMonth: string
  }
}

export interface OptionExpiriesWire {
  ok: true
  expiries: OptionExpiryCalendar
}

export interface OptionChainWire {
  ok: true
  chain: OptionChain
}

/** 套利扫描 wire（平价 + 箱型机会表；垂直价差仅显式请求时附带）。 */
export interface OptionArbitrageWire {
  ok: true
  scan: OptionArbitrageScanResult
}

export interface OptionImpliedVolWire {
  ok: true
  impliedVol: OptionImpliedVolResult
}

/** vol_analytics 内核报告透传 wire（报告 JSON 不解释，形状由 python handler 定义）。 */
export interface OptionVolAnalyticsWire {
  ok: true
  volAnalytics: KernelReport
}

export interface OptionStrategyWire {
  ok: true
  strategy: OptionStrategyResult
}

/** 期权下单回执 wire（阶段 3 交易台）。 */
export interface OptionOrderWire {
  ok: true
  order: OptionOrder
}

export interface OptionPositionsWire {
  ok: true
  positions: readonly OptionPosition[]
}

export interface OptionOverviewWire {
  ok: true
  overview: OptionOverview
}

export interface OptionIntradayBoxWire {
  ok: true
  box: OptionIntradayBox
}

export interface OptionCyclesWire {
  ok: true
  cycles: readonly OptionCycle[]
}

export interface OptionCycleLoopWire {
  ok: true
  loop: OptionCycleLoop
}

export interface OptionBarPacketWire {
  ok: true
  packet?: OptionBarContextPacket
}

export interface OptionCycleTickWire {
  ok: true
  loop: OptionCycleLoop
  ticked: boolean
  asOf: string
}

/** GUI 期权下单体（与 GuiOrderBody 同语义：默认请求实盘，服务缝闸门兜底）。 */
export interface GuiOptionOrderBody {
  readonly symbol?: unknown
  readonly side?: unknown
  readonly offset?: unknown
  readonly orderType?: unknown
  readonly quantity?: unknown
  readonly price?: unknown
  readonly dryRun?: unknown
}

export interface OrderbookWire {
  ok: true
  orderbook: Orderbook
}

export interface TradesWire {
  ok: true
  trades: TradeTick[]
}

/** 桥端逐笔上限（保护公共端点；GUI 流水只展示最近一段）。 */
export const MAX_TRADES_LIMIT = 100

/* -- 交易台 wire（issue #40）---------------------------------------------- */

export interface PositionsWire {
  ok: true
  positions: Position[]
}

export interface BalancesWire {
  ok: true
  balances: AccountBalance[]
}

export interface OpenOrdersWire {
  ok: true
  orders: Order[]
}

export interface TradeFillsWire {
  ok: true
  fills: TradeFill[]
}

export interface PlaceOrderWire {
  ok: true
  order: Order
}

/** GUI 下单体（只做真交易：默认 dryRun=false 实盘报单）。 */
export interface GuiOrderBody {
  readonly market?: unknown
  readonly symbol?: unknown
  readonly side?: unknown
  readonly type?: unknown
  readonly quantity?: unknown
  readonly price?: unknown
  readonly dryRun?: unknown
}

export interface CustomIndicatorsWire {
  ok: true
  indicators: CustomIndicatorRecord[]
}

/** 图表激活名册 wire（issue #63）。 */
export interface ChartActivationsWire {
  ok: true
  instances: IndicatorInstance[]
}

/** 图表激活写入的业务拒绝（未知指标 id 等；协议错误仍走 BridgeProtocolError）。 */
export interface ChartActivationRejectedWire {
  ok: false
  code: 'TRADING_UNKNOWN_INDICATOR' | 'TRADING_INVALID_SCOPE'
  message: string
}

export interface KnowledgeCardsWire {
  ok: true
  cards: readonly KnowledgeCard[]
}

/* -- 统一资产台账 wire 与宿主面（issue #65，契约 §2/§3/§4）------------------ */

/** 台账快照（GET /holdings）。 */
export interface HoldingsWire {
  ok: true
  revision: number
  staged: Holding[]
  holdings: Holding[]
}

/** 写成功应答（stage/confirm/discard/add/update/remove）。 */
export interface HoldingsWriteWire {
  ok: true
  revision: number
  /** 仅 POST /holdings（手动新增）携带。 */
  id?: string
}

/** 校验失败（契约 §3：HTTP 200 + ok:false + TRADING_HOLDINGS_INVALID）。 */
export interface HoldingsRejectedWire {
  ok: false
  code: 'TRADING_HOLDINGS_INVALID'
  message: string
}

export interface HoldingsSnapshotShape {
  revision: number
  staged: Holding[]
  holdings: Holding[]
}

/**
 * 台账 store 的最小桥面（契约 §2 接口子集：snapshot/stage/confirm/discard/add/
 * update/remove）。宿主侧由 @dshtrading/holdings 的 file store 经 cordis 服务
 * `tradingHoldings`（Service 实例 .store 解包，knowledge 同款）注入；缺席时
 * createBridgeHost 回退 createFallbackHoldingsStore。
 *
 * 写操作返回值契约未刊（设计契约缺口，已回报）：本桥按「number = 新 revision」
 * 或「{ revision }」或「Holding（仅 add，取 id）」三种形状宽容解析，皆不可得
 * 时回退 snapshot().revision。
 */
export interface HoldingsStoreLike {
  snapshot(): HoldingsSnapshotShape | Promise<HoldingsSnapshotShape>
  stage(items: NewHoldingInput[]): unknown
  confirm(ids: string[], edits?: Record<string, Partial<NewHolding>>): unknown
  discard(ids: string[]): unknown
  add(item: NewHoldingInput): unknown
  update(id: string, patch: Partial<NewHolding>): unknown
  remove(id: string): unknown
}

/** FX 快照（/fx 应答有效载荷语义：rates[c] = 1 单位 c 折合多少 base）。 */
export interface FxRatesSnapshot {
  base: string
  rates: Record<string, number>
  asOf: number
  stale: boolean
}

/** FX 服务形状（@dshtrading/holdings/fx 集成时的适配目标，函数式最小面）。 */
export type FxRatesFetcher = (base: string) => Promise<FxRatesSnapshot>

/** FX 支持的基准币（契约 §4；USDT 恒定锚定 USD，不作基准）。 */
export const FX_BASES: readonly string[] = ['USD', 'CNY', 'HKD']

const HOLDING_CURRENCIES: readonly string[] = ['USD', 'CNY', 'HKD', 'USDT']
const HOLDING_KINDS: readonly string[] = ['real', 'sim']
/** 单次 stage 条数封顶（截图解析量级；防滥用，契约外附加护栏）。 */
export const MAX_HOLDINGS_STAGE_ITEMS = 100

function holdingsRejected(message: string): HoldingsRejectedWire {
  return { ok: false, code: 'TRADING_HOLDINGS_INVALID', message }
}

/**
 * 进程内内存台账兜底（knowledge 同款「缺席回退自建」语义——台账侧由
 * @dshtrading/holdings 专门导出的 createMemoryHoldingsStore 承载，其包注释
 * 明言「client-ui-trading 桥兜底/单测用」）：真实部署由同包 file store
 * （~/.dsh/holdings/book.json 原子写）经 tradingHoldings 服务注入；本兜底
 * 刻意不碰该文件（文件格式归 holdings 包所有，双写者会互相踩格式），重启即失。
 * §2 语义（id `hd-<ts>-<rand>`、revision 仅真实变更自增、默认值写入侧推导）
 * 由 store-core 单一实现保证。
 */
export function createFallbackHoldingsStore(): HoldingsStoreLike {
  return createMemoryHoldingsStore()
}

/**
 * 桥内 FX 兜底服务：直接复用 @dshtrading/holdings/fx 的 createFxService
 * （纯内存缓存，无文件层——文件缓存归 holdings 插件 ~/.dsh/holdings/
 * fx-cache.json 所有；集成时主 agent 经 tradingHoldings 服务 .fx 注入同一
 * 单实例替换本兜底）。语义契约 §4：frankfurter（ECB 汇率，免费无 key）→
 * 内存缓存 1h → 恒等兜底，后两段 stale:true；取倒数归一为「1 c 折合多少
 * base」；USDT 不入请求恒定锚 USD；fetch 超时 5s。base 白名单由 fx()
 * 路由先行校验（400），非法 base 不会到达本服务。
 */
export function createFallbackFxFetcher(fetchImpl?: FxFetchLike): FxRatesFetcher {
  const service = createFxService(fetchImpl !== undefined ? { fetchImpl } : {})
  return async (base: string): Promise<FxRatesSnapshot> => {
    const quote = await service.getRates(base)
    return { base: quote.base, rates: quote.rates, asOf: quote.asOf, stale: quote.stale }
  }
}

/** NewHoldingInput 字段校验（协议边界；失败 → TRADING_HOLDINGS_INVALID 业务错误）。
 *  account/kind/currency 可缺省（写入侧推导默认值），对齐包侧 NewHoldingInput 接受面。 */
export function parseNewHolding(body: unknown): NewHoldingInput | HoldingsRejectedWire {
  if (typeof body !== 'object' || body === null) return holdingsRejected('holding must be an object')
  const raw = body as Record<string, unknown>
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  if (!isMarketId(market)) return holdingsRejected(`holding.market must be one of ${MARKET_IDS.join('/')}`)
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (symbol === '') return holdingsRejected('holding.symbol is required')
  if (raw.side !== undefined && raw.side !== 'long') return holdingsRejected("holding.side only supports 'long'")
  const size = raw.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return holdingsRejected('holding.size must be a positive number')
  const patch = parseHoldingPatch(raw)
  if ('ok' in patch) return patch
  return {
    market,
    symbol,
    side: 'long',
    size,
    ...patch,
  }
}

/**
 * Partial<NewHolding> 校验（confirm edits / update patch 共用）：只摘契约字段，
 * 非法值整条拒绝。market/size/side 也可出现在 patch 里（确认对话框可编辑 market）。
 */
export function parseHoldingPatch(body: Record<string, unknown>): Partial<NewHolding> | HoldingsRejectedWire {
  const out: Partial<NewHolding> = {}
  if (body.market !== undefined) {
    const market = typeof body.market === 'string' ? body.market.trim() : ''
    if (!isMarketId(market)) return holdingsRejected(`holding.market must be one of ${MARKET_IDS.join('/')}`)
    out.market = market
  }
  if (body.symbol !== undefined) {
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
    if (symbol === '') return holdingsRejected('holding.symbol must be a non-empty string')
    out.symbol = symbol
  }
  if (body.side !== undefined) {
    if (body.side !== 'long') return holdingsRejected("holding.side only supports 'long'")
    out.side = 'long'
  }
  if (body.size !== undefined) {
    const size = body.size
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return holdingsRejected('holding.size must be a positive number')
    out.size = size
  }
  if (body.entryPrice !== undefined) {
    const entryPrice = body.entryPrice
    if (typeof entryPrice !== 'number' || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return holdingsRejected('holding.entryPrice must be a positive number')
    }
    out.entryPrice = entryPrice
  }
  if (body.currency !== undefined) {
    const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
    if (!HOLDING_CURRENCIES.includes(currency)) {
      return holdingsRejected(`holding.currency must be one of ${HOLDING_CURRENCIES.join('/')}`)
    }
    out.currency = currency as HoldingCurrency
  }
  if (body.account !== undefined) {
    if (typeof body.account !== 'string' || body.account.trim() === '') {
      return holdingsRejected('holding.account must be a non-empty string')
    }
    out.account = body.account.trim()
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !HOLDING_KINDS.includes(body.kind)) {
      return holdingsRejected("holding.kind must be 'real' or 'sim'")
    }
    out.kind = body.kind as Holding['kind']
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return holdingsRejected('holding.name must be a string')
    out.name = body.name
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') return holdingsRejected('holding.note must be a string')
    out.note = body.note
  }
  return out
}

/* -- 新闻 wire（issue #37）----------------------------------------------- */

export interface NewsWire {
  ok: true
  items: readonly NewsItem[]
  unavailable: readonly string[]
}

/** 新闻端点条目上限（保护公共数据源；超出部分由 Kit 层截流）。 */
export const MAX_NEWS_LIMIT = 50

export class BridgeProtocolError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isMarketId(value: string): value is MarketId {
  return (MARKET_IDS as readonly string[]).includes(value)
}

/** 动态标的全集缓存 TTL（30分钟）。 */
export const SYMBOLS_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * 基本面数据包缓存 TTL（5分钟）：财报级/日级数据，非 tick；同键 in-flight 去重
 * 让 tab 翻转与快速切标的只打一轮上游（issue #36 整改，2026-09-02）。
 */
export const FUNDAMENTALS_CACHE_TTL_MS = 5 * 60 * 1000

/** 从 Error 上提取结构化错误词汇（连接器按 TradingError 形状附加 code）。 */
export function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const raw = (error as { code?: unknown }).code
    const code = typeof raw === 'string' ? raw : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}

/** 总览近月 ATM IV 用的无风险利率（与 python pricing 测例同档）。 */
const OVERVIEW_IV_RATE = 0.02
/** ATM IV 进程内缓存，避免 60s 总览轮询九路 implied_vol。命中 5 分钟；缺席 30 秒（网关刚恢复时不要钉死空值）。 */
const OVERVIEW_ATM_IV_TTL_MS = 5 * 60 * 1000
const OVERVIEW_ATM_IV_MISS_TTL_MS = 30 * 1000

export class TradingBridge {
  private readonly symbolsCache = new Map<string, { list: SymbolInfoWire[]; fetchedAt: number }>()
  private readonly fundamentalsCache = new Map<string, { pkg: StockFundamentals; fetchedAt: number }>()
  private readonly fundamentalsInflight = new Map<string, Promise<StockFundamentals>>()
  readonly #atmIvCache = new Map<string, {
    atmIv?: number
    nextAtmIv?: number
    fetchedAt: number
  }>()
  /** FX 兜底 fetcher（issue #65；host.fetchFxRates 注入正式实现时不走这里）。 */
  readonly #fallbackFxFetcher: FxRatesFetcher = createFallbackFxFetcher()
  readonly #cycles = new OptionCycleBook()
  /** 每条 upsert 后可选落盘；失败不得打断 tick。 */
  onCycleWrite?: (cycle: OptionCycle) => Promise<void>
  /** T+1 预测模块持久化（前端可运行的数据缝；不依赖期权网关）。 */
  readonly #predictions = new PredictionStore()
  /** 套利引擎链缓存（key `u:m`；TTL 60s、失败不缓存、refresh 强制新拉）。 */
  readonly #arbChainCache = new Map<string, { at: number; promise: Promise<OptionChain | undefined> }>()
  /** 套利周期 in-flight 闸：记 tick asOf，非 0 = 在跑；上轮超 5min 视为僵死强制放行。 */
  #arbCycleInFlightSince = 0
  /** 转债折价扫描节流：上次运行 tick 时间（0 = 冷启动即跑）。 */
  #cbScanLastMs = 0
  /** 转债能力缺失日通知（active provider 无 getCovSnapshot 时每日只记一行，防洪水）。 */
  #cbCapabilityNoticeDate: string | undefined

  constructor(private readonly host: BridgeHost) {}

  hydrateOptionCycles(rows: readonly OptionCycle[]): void {
    replayCyclesIntoBook(this.#cycles, rows)
  }

  startOptionCycleLoop(): void {
    this.#cycles.running = true
  }

  stopOptionCycleLoop(): void {
    this.#cycles.running = false
  }

  /** 已安装（有行情服务）的市场清单 + 当前 provider slug。 */
  markets(): MarketsWire {
    const markets: MarketInfoWire[] = []
    for (const id of MARKET_IDS) {
      if (this.host.getMarketService(id) === undefined) continue
      const provider = this.host.activeProvider(id)
      markets.push(provider === undefined ? { id } : { id, provider })
    }
    return { markets }
  }

  /** 批量报价：逐 symbol 独立成功/失败（一个坏代码不拖垮整批）。 */
  async tickers(market: string, symbols: string[]): Promise<TickersWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const unique = [...new Set(symbols.map(symbol => symbol.trim()).filter(Boolean))]
    if (unique.length === 0) throw new BridgeProtocolError(400, 'tickers: symbols is required')
    if (unique.length > MAX_SYMBOLS) {
      throw new BridgeProtocolError(400, `tickers: too many symbols (${unique.length} > ${MAX_SYMBOLS})`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const outcomes = await Promise.all(unique.map(async (symbol): Promise<TickerOutcome> => {
      try {
        return { ok: true, ticker: await service.getTicker(symbol) }
      } catch (error) {
        return { ok: false, ...errorPayload(error) }
      }
    }))
    const tickers: Record<string, TickerOutcome> = {}
    unique.forEach((symbol, index) => { tickers[symbol] = outcomes[index] as TickerOutcome })
    return { tickers }
  }

  /** K 线：透传 interval（连接器自行校验各自支持集）。 */
  async klines(market: string, symbol: string, interval: string, rawLimit: string | null): Promise<KlinesWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'klines: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_KLINE_LIMIT)) {
      throw new BridgeProtocolError(400, `klines: limit must be an integer in 1..${MAX_KLINE_LIMIT}`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const klines = await service.getKlines(trimmed, interval as Interval, limit)
    return { klines }
  }

  /** 动态标的全集（带 30min 进程内缓存；未实现或异常静默回落空列表）。 */
  async symbols(market: string, query?: string): Promise<SymbolsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    if (typeof service.listInstruments !== 'function') {
      return { symbols: [] }
    }
    const trimmed = query?.trim().toLowerCase()
    if (trimmed) {
      try {
        const list = await (service as unknown as { listInstruments(q?: string): Promise<Array<{ symbol: string; name?: string }>> }).listInstruments(trimmed)
        let symbols: SymbolInfoWire[] = Array.isArray(list)
          ? list.map(item => ({ symbol: item.symbol, ...(item.name ? { name: item.name } : {}) }))
          : []
        // 防御性兜底：若连接器实现未做服务端过滤（忽略 query 返回全量），本地执行严格匹配
        const isServerFiltered = symbols.length === 0 || symbols.every(s =>
          s.symbol.toLowerCase().includes(trimmed) || (s.name !== undefined && s.name.toLowerCase().includes(trimmed))
        )
        if (!isServerFiltered) {
          symbols = symbols.filter(s =>
            s.symbol.toLowerCase().includes(trimmed) || (s.name !== undefined && s.name.toLowerCase().includes(trimmed))
          )
        }
        return { symbols }
      } catch {
        return { symbols: [] }
      }
    }
    const cached = this.symbolsCache.get(market)
    if (cached !== undefined && Date.now() - cached.fetchedAt < SYMBOLS_CACHE_TTL_MS) {
      return { symbols: cached.list }
    }
    try {
      const list = await service.listInstruments()
      const symbols: SymbolInfoWire[] = Array.isArray(list)
        ? list.map(item => ({ symbol: item.symbol, ...(item.name ? { name: item.name } : {}) }))
        : []
      this.symbolsCache.set(market, { list: symbols, fetchedAt: Date.now() })
      return { symbols }
    } catch {
      return { symbols: [] }
    }
  }

  private requireCnOptions(): CnOptionsService {
    const service = this.host.getCnOptions?.()
    if (service === undefined) {
      throw Object.assign(
        new Error('CN ETF options service is not mounted — add @dshtrading/connector-options'),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return service
  }

  #requireCnOptionsTrade(): CnOptionsTradeService {
    const service = this.host.getCnOptionsTrade?.()
    if (service === undefined) {
      throw Object.assign(
        new Error('CN ETF options trade service is not mounted — add @dshtrading/connector-options (trade half)'),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return service
  }

  /**
   * ETF 期权标的名册（workbuddy T 板显隐）。source 缺省走连接器默认值。
   * 阶段 4 互联：从统一资产台账聚合各标的持仓份额（heldQty，备兑覆盖参考）。
   */
  async optionUnderlyings(source?: string): Promise<OptionUnderlyingsWire> {
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    const rows = await this.requireCnOptions().listUnderlyings(typed)
    return { ok: true, underlyings: await this.#withHeldQty(rows) }
  }

  /** 名册行回填 heldQty：cn 持仓按 symbol 去交易所后缀聚合同标的份额；聚合失败不阻塞名册。 */
  async #withHeldQty(rows: readonly OptionUnderlying[]): Promise<readonly OptionUnderlying[]> {
    const store = this.host.holdingsStore
    if (store === undefined || rows.length === 0) return rows
    let holdings: readonly Holding[]
    try {
      holdings = (await store.snapshot()).holdings
    } catch {
      return rows
    }
    const held = new Map<string, number>()
    for (const item of holdings) {
      if (item.market !== 'cn' || typeof item.symbol !== 'string') continue
      const bare = item.symbol.replace(/\.(SH|SZ)$/i, '')
      if (!/^\d{6}$/.test(bare)) continue
      held.set(bare, (held.get(bare) ?? 0) + item.size)
    }
    return rows.map((row) => {
      const qty = held.get(row.underlying)
      return qty === undefined ? row : { ...row, heldQty: qty }
    })
  }

  /**
   * 标准四季月胶囊（当月/次月/+3/+6）。算法本地算，不打期权网关。
   */
  async optionExpiries(underlying: string, source?: string): Promise<OptionExpiriesWire> {
    const trimmed = underlying.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'options expiries: underlying is required')
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    return {
      ok: true,
      expiries: await this.requireCnOptions().getOptionExpiries({
        underlying: trimmed,
        // exactOptionalPropertyTypes：可选字段不得显式传 undefined（2026-09-08）。
        ...(typed === undefined ? {} : { source: typed }),
      }),
    }
  }

  /**
   * T 型报价链。underlying 必填（510050.SH / 510050 / 长代码）；expiryMonth 必填 YYMM。
   * 阶段 4 现价拼接：SSE/SZSE 标的从 CN 行情服务拉最新价回填 chain.spot（ATM 高亮用）。
   */
  async optionChain(underlying: string, expiryMonth: string, source?: string): Promise<OptionChainWire> {
    const trimmed = underlying.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'options chain: underlying is required')
    const month = expiryMonth.trim()
    if (month === '') throw new BridgeProtocolError(400, 'options chain: expiryMonth is required')
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    const chain = await this.requireCnOptions().getOptionChain({
      underlying: trimmed,
      expiryMonth: month,
      ...(typed === undefined ? {} : { source: typed }),
    })
    return { ok: true, chain: await this.#withSpot(chain) }
  }

  /**
   * 套利扫描（2026-09-13 后端接线）：拉链一次 → strategies 内核（平价 + 箱型）。
   * spot 优先取 CN 行情现价（parity 需要；拿不到则退回链自带 spot，再没有平价退化仅箱型）。
   * fee 缺省注入模拟盘费率（OPTION_PAPER_FEE_PER_CONTRACT，显式 fee=0 可关）。
   */
  async optionArbitrage(
    underlying: string,
    expiryMonth: string,
    source?: string,
    threshold?: string,
    fee?: string,
    verticals?: string,
  ): Promise<OptionArbitrageWire> {
    const trimmed = underlying.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'options arbitrage: underlying is required')
    const month = expiryMonth.trim()
    if (month === '') throw new BridgeProtocolError(400, 'options arbitrage: expiryMonth is required')
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    const thresholdPerShare = parseOptionalFinite(threshold, 'threshold')
    const feePerContract = fee === undefined ? OPTION_PAPER_FEE_PER_CONTRACT : parseOptionalFinite(fee, 'fee')
    const spot = await this.#spotPriceOf(trimmed.replace(/\.(SH|SZ)$/i, ''))
    return {
      ok: true,
      scan: await this.requireCnOptions().getArbitrageScan({
        underlying: trimmed,
        expiryMonth: month,
        ...(typed === undefined ? {} : { source: typed }),
        ...(spot === undefined ? {} : { spot }),
        ...(thresholdPerShare === undefined ? {} : { thresholdPerShare }),
        ...(feePerContract === undefined ? {} : { feePerContract }),
        ...(verticals === '1' || verticals === 'true' ? { includeVerticals: true } : {}),
      }),
    }
  }

  /** 现价拼接：名册查交易所 → 现货符号 → tradingCnMarketData ticker 覆盖 spot；任一步失败保留原链。 */
  async #withSpot(chain: OptionChain): Promise<OptionChain> {
    const spot = await this.#spotPriceOf(chain.underlying)
    return spot === undefined ? chain : { ...chain, spot }
  }

  /** 现货最新价（6 位 ETF 代码）；名册未注册/行情不可得返回 undefined，不抛错。 */
  async #spotPriceOf(underlying: string): Promise<number | undefined> {
    if (!/^\d{6}$/.test(underlying)) return undefined
    let rows: readonly OptionUnderlying[]
    try {
      rows = await this.requireCnOptions().listUnderlyings('akshare')
    } catch {
      return undefined
    }
    const exchange = rows.find((row) => row.underlying === underlying)?.exchange
    const spotSymbol = exchange === 'SSE' ? `${underlying}.SH`
      : exchange === 'SZSE' ? `${underlying}.SZ`
      : undefined // SYNTH 无现货行情
    const market = spotSymbol === undefined ? undefined : this.host.getMarketService('cn')
    if (spotSymbol === undefined || market === undefined) return undefined
    try {
      const ticker = await market.getTicker(spotSymbol)
      if (typeof ticker.price === 'number' && Number.isFinite(ticker.price)) {
        return ticker.price
      }
    } catch {
      // 行情拉不到（非交易时段/未挂 provider）→ 调用方保留原值，不阻塞
    }
    return undefined
  }

  async optionImpliedVol(
    underlying: string,
    expiryMonth: string,
    rateRaw: string,
    source?: string,
    priceField?: string,
  ): Promise<OptionImpliedVolWire> {
    const trimmed = underlying.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'options implied-vol: underlying is required')
    const month = expiryMonth.trim()
    if (month === '') throw new BridgeProtocolError(400, 'options implied-vol: expiryMonth is required')
    const rate = Number(rateRaw)
    if (!Number.isFinite(rate)) throw new BridgeProtocolError(400, 'options implied-vol: rate is required')
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    const field = priceField === 'prevSettle' ? 'prevSettle' as const : 'last' as const
    return {
      ok: true,
      impliedVol: await this.requireCnOptions().getImpliedVol({
        underlying: trimmed,
        expiryMonth: month,
        rate,
        ...(typed === undefined ? {} : { source: typed }),
        priceField: field,
      }),
    }
  }

  async optionStrategy(body: unknown): Promise<OptionStrategyWire> {
    if (body === null || typeof body !== 'object') {
      throw new BridgeProtocolError(400, 'options strategy: JSON object is required')
    }
    const input = body as OptionStrategyRequest
    if (typeof input.underlying !== 'string' || input.underlying.trim() === '') {
      throw new BridgeProtocolError(400, 'options strategy: underlying is required')
    }
    // 阶段 4 互联：holdingQty = 真实持仓份额（covered_call/collar 现货腿预填）；非正数直接 400。
    if (input.holdingQty !== undefined
      && (typeof input.holdingQty !== 'number' || !Number.isFinite(input.holdingQty) || input.holdingQty <= 0)) {
      throw new BridgeProtocolError(400, 'options strategy: holdingQty must be a positive number of ETF shares')
    }
    return { ok: true, strategy: await this.requireCnOptions().getStrategy(input) }
  }

  /**
   * 波动率分析（IV 期限结构 / skew / 分位 / HV，python vol_analytics 透传）。
   * 报告 JSON 不解释——形状由 python handler 定义，桥只做参数规范化：
   * 显式给出但解析失败的数值 → 400（不静默吞掉换默认值）；缺席则整键省略。
   */
  async optionVolAnalytics(
    underlying: string,
    expiryMonthsRaw: string | null,
    asOfRaw: string | null,
    rateRaw: string | null,
    dividendYieldRaw: string | null,
    source?: string,
  ): Promise<OptionVolAnalyticsWire> {
    const trimmed = underlying.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'options vol-analytics: underlying is required')
    const months = (expiryMonthsRaw ?? '')
      .split(',').map(m => m.trim()).filter(m => m !== '')
    const asOf = (asOfRaw ?? '').trim()
    const rate = rateRaw === null || rateRaw.trim() === '' ? undefined : Number(rateRaw)
    if (rate !== undefined && !Number.isFinite(rate)) {
      throw new BridgeProtocolError(400, 'options vol-analytics: rate must be a finite number')
    }
    const dividendYield = dividendYieldRaw === null || dividendYieldRaw.trim() === '' ? undefined : Number(dividendYieldRaw)
    if (dividendYield !== undefined && !Number.isFinite(dividendYield)) {
      throw new BridgeProtocolError(400, 'options vol-analytics: dividendYield must be a finite number')
    }
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    const query: OptionVolAnalyticsQuery = {
      underlying: trimmed,
      ...(months.length === 0 ? {} : { expiryMonths: months }),
      ...(asOf === '' ? {} : { asOf }),
      ...(rate === undefined ? {} : { rate }),
      ...(dividendYield === undefined ? {} : { dividendYield }),
      ...(typed === undefined ? {} : { source: typed }),
    }
    return { ok: true, volAnalytics: await this.requireCnOptions().getVolAnalytics(query) }
  }

  /**
   * 现货 ↔ 期权长代码双向规范化（阶段 4 互联：标的双向跳转）。纯本地解析
   * （正则与 connector-options rest.ts / python synth.parse_long_code 对齐），
   * 名册命中才给 link（spotSymbol + 长/认沽前缀）；长代码输入另给 contract 要素。
   */
  async optionResolve(symbol: string): Promise<OptionResolveWire> {
    const raw = symbol.trim().toUpperCase()
    if (raw === '') throw new BridgeProtocolError(400, 'options resolve: symbol is required')
    const longMatch = raw.match(OPTION_LONG_CODE)
    const spotMatch = longMatch === null ? raw.match(OPTION_SPOT_CODE) : null
    if (longMatch === null && spotMatch === null) {
      throw new BridgeProtocolError(400, `options resolve: not a CN ETF underlying or option long code: ${symbol}`)
    }
    const underlying = (longMatch ?? spotMatch)![1]!
    let exchange: 'SSE' | 'SZSE' | 'SYNTH' | undefined
    try {
      exchange = (await this.requireCnOptions().listUnderlyings('akshare'))
        .find((row) => row.underlying === underlying)?.exchange
    } catch {
      exchange = undefined
    }
    const link: UnderlyingLink | undefined = exchange === undefined ? undefined : {
      underlying,
      spotSymbol: exchange === 'SSE' ? `${underlying}.SH` : exchange === 'SZSE' ? `${underlying}.SZ` : underlying,
      exchange,
      callPrefix: `${underlying}C`,
      putPrefix: `${underlying}P`,
    }
    return {
      ok: true,
      input: raw,
      underlying,
      ...(link === undefined ? {} : { link }),
      ...(longMatch === null ? {} : {
        contract: {
          code: raw,
          optionType: longMatch[2] as 'C' | 'P',
          expiryMonth: longMatch[3]!,
          // 长代码 5 位行权价编码 ÷1000（02850 → 2.85），与 python synth.parse_long_code 同式。
          strike: Number(longMatch[4]) / 1000,
        },
      }),
    }
  }

  /**
   * GUI 期权下单（阶段 3 T 板直接下单）：与 placeOrderFromGui 同语义——默认请求
   * 实盘（dryRun: false），服务缝闸门（connector-options 的 dryRun/liveTrading
   * 双闸）fail-closed，桥层如实转达闸门错误。回执含 premiumAmount 权利金金额。
   */
  async placeOptionOrderFromGui(body: GuiOptionOrderBody): Promise<OptionOrderWire> {
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
    const side = body.side === 'sell' ? 'sell' as const : body.side === 'buy' ? 'buy' as const : undefined
    const offset = body.offset === 'close' ? 'close' as const : body.offset === 'open' ? 'open' as const : undefined
    const orderType = body.orderType === 'market' ? 'market' as const : body.orderType === 'limit' ? 'limit' as const : undefined
    const quantity = typeof body.quantity === 'number' ? body.quantity : Number.NaN
    if (symbol === '') throw new BridgeProtocolError(400, 'options order: symbol is required')
    if (side === undefined) throw new BridgeProtocolError(400, 'options order: side must be buy or sell')
    if (offset === undefined) throw new BridgeProtocolError(400, 'options order: offset must be open or close')
    if (orderType === undefined) throw new BridgeProtocolError(400, 'options order: orderType must be limit or market')
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BridgeProtocolError(400, 'options order: quantity must be a positive integer of contracts')
    }
    const price = typeof body.price === 'number' ? body.price : undefined
    if (orderType === 'limit' && (price === undefined || !Number.isFinite(price) || price <= 0)) {
      throw new BridgeProtocolError(400, 'options order: limit orders require a positive price')
    }
    const requestedDryRun = typeof body.dryRun === 'boolean' ? body.dryRun : false
    const order = await this.#requireCnOptionsTrade().placeOptionOrder({
      symbol,
      side,
      offset,
      orderType,
      quantity,
      ...(price !== undefined ? { price } : {}),
      dryRun: requestedDryRun,
    })
    return { ok: true, order }
  }

  /** GUI 期权撤单：连接器侧与真实下单同门槛（liveTrading=true 且 dryRun=false）。 */
  async cancelOptionOrderFromGui(orderId: string, symbol?: string): Promise<{ ok: true; canceled: boolean }> {
    const trimmedId = orderId.trim()
    if (trimmedId === '') throw new BridgeProtocolError(400, 'options cancel: id is required')
    await this.#requireCnOptionsTrade().cancelOptionOrder(trimmedId, symbol?.trim())
    return { ok: true, canceled: true }
  }

  /** GUI 期权持仓（只读透传，不走闸门）。 */
  async optionPositions(): Promise<OptionPositionsWire> {
    return { ok: true, positions: await this.#requireCnOptionsTrade().listOptionPositions() }
  }

  /**
   * 5 分钟桶 ContextPacket 事实：复用总览行（includeIv=0 + 缓存 atmIv），不打 vol_analytics。
   */
  async snapshotBarFacts(underlyings: readonly string[]): Promise<readonly OptionBarFact[]> {
    const wanted = new Set(underlyings)
    if (wanted.size === 0) return []
    const roster = (await this.#withHeldQty(await this.requireCnOptions().listUnderlyings()))
      .filter((row) => row.exchange !== 'SYNTH' && wanted.has(row.underlying))
    const ivHistory = await readJsonl<OptionBarDailyIv>(ivDailyPath(optionsDataRoot()))
    const built = await Promise.all(roster.map((row) => this.#overviewRow(row, undefined, false, undefined, ivHistory)))
    await writeOverviewSnapshot(optionsDataRoot(), {
      asOf: new Date().toISOString(),
      rows: built.map(persistableOverviewRow),
    })
    const sessionDate = shanghaiCalendarDate(Date.now())
    const listed = await this.#predictions.track()
    return built.map((row) => {
      const dayPrior = dayPriorOf(listed.predictions, row.underlying, sessionDate)
      return {
        underlying: row.underlying,
        ...(row.return5d === undefined ? {} : { return5d: row.return5d }),
        ...(row.volumeRatio === undefined ? {} : { volumeRatio: row.volumeRatio }),
        ...(row.divergence === undefined ? {} : { divergence: row.divergence }),
        ...(row.heldQty === undefined ? {} : { heldQty: row.heldQty }),
        ...(row.atmIv === undefined ? {} : { atmIv: row.atmIv }),
        ...(row.nextAtmIv === undefined ? {} : { nextAtmIv: row.nextAtmIv }),
        ...(row.hv20 === undefined ? {} : { hv20: row.hv20 }),
        ...(row.ivPercentile === undefined ? {} : { ivPercentile: row.ivPercentile }),
        ...(dayPrior === undefined ? {} : { dayPrior }),
      }
    })
  }

  /**
   * C1 七标的总览：只读 overview.json（5 分钟桶 snapshotBarFacts 覆写）+
   * iv-daily / recommendations / packet。不打 ticker、日 K、implied_vol、vol_analytics。
   * includeIv 保留查询参数兼容；分位只从快照或 iv-daily 算。无快照则名册骨架、days 空。
   */
  async optionOverview(
    source?: string,
    sortRaw?: string,
    _includeIvRaw?: string,
  ): Promise<OptionOverviewWire> {
    const typed = source === 'synth' || source === 'akshare' || source === 'iquant' ? source : undefined
    const sort: OptionOverviewSort = sortRaw === 'iv' || sortRaw === 'holdings' ? sortRaw : 'strength'
    const roster = await this.#withHeldQty(await this.requireCnOptions().listUnderlyings(typed))
    const rows = roster.filter((row) => row.exchange !== 'SYNTH')
    let positions: readonly OptionPosition[] = []
    try {
      positions = await this.#requireCnOptionsTrade().listOptionPositions()
    } catch {
      positions = []
    }
    const qtyByUnderlying = new Map<string, number>()
    for (const pos of positions) {
      qtyByUnderlying.set(pos.underlying, (qtyByUnderlying.get(pos.underlying) ?? 0) + Math.abs(pos.quantity))
    }
    const root = optionsDataRoot()
    const ivHistory = await readJsonl<OptionBarDailyIv>(ivDailyPath(root))
    const snapshot = await loadOverviewSnapshot(root)
    const byUnderlying = new Map<string, ReturnType<typeof parseOverviewSnapshotRow>>()
    for (const raw of snapshot?.rows ?? []) {
      const parsed = parseOverviewSnapshotRow(raw)
      if (parsed !== undefined) byUnderlying.set(parsed.underlying, parsed)
    }
    const sessionDate = shanghaiCalendarDate(Date.now())
    const listed = await this.#predictions.track()
    const priors: Record<string, ReturnType<typeof dayPriorOf>> = {}
    const built = rows.map((row) => {
      const dayPrior = dayPriorOf(listed.predictions, row.underlying, sessionDate)
      if (dayPrior !== undefined) priors[row.underlying] = dayPrior
      // exactOptionalPropertyTypes：get() 提前收敛非 undefined，条件展开才不带 | undefined。
      const snapshotRow = byUnderlying.get(row.underlying)
      const optionQty = qtyByUnderlying.get(row.underlying)
      return hydrateOverviewRow({
        roster: row,
        ...(snapshotRow === undefined ? {} : { snapshot: snapshotRow }),
        ...(optionQty === undefined ? {} : { optionQty }),
        ivHistory,
        ...(dayPrior === undefined ? {} : { dayPrior }),
      })
    })
    const sorted = sortOverviewRows(built, sort)
    const rec = await loadLatestRecommendation(root, Date.now())
    const packet = await loadLatestPacket(root, Date.now())
    const withStrategy = attachOverviewStrategies(sorted, rec, packet)
    return {
      ok: true,
      overview: {
        source: typed ?? 'iquant',
        sort,
        asOf: snapshot?.asOf ?? new Date().toISOString(),
        rows: withStrategy,
        scanAllPrompt: composeScanAllPrompt(withStrategy, priors),
      },
    }
  }

  async #overviewRow(
    row: OptionUnderlying,
    optionQty: number | undefined,
    includeIv: boolean,
    source: 'akshare' | 'iquant' | 'synth' | undefined,
    ivHistory: readonly OptionBarDailyIv[] = [],
  ): Promise<OptionOverviewRow> {
    const spotSymbol = spotSymbolOf(row.underlying, row.exchange)
    const link: UnderlyingLink | undefined = spotSymbol === undefined ? undefined : {
      underlying: row.underlying,
      spotSymbol,
      exchange: row.exchange,
      callPrefix: `${row.underlying}C`,
      putPrefix: `${row.underlying}P`,
    }
    let ticker: Ticker | undefined
    let klines: readonly Kline[] = []
    const market = this.host.getMarketService('cn')
    if (spotSymbol !== undefined && market !== undefined) {
      try {
        ticker = await market.getTicker(spotSymbol)
      } catch {
        ticker = undefined
      }
      try {
        klines = await market.getKlines(spotSymbol, '1d', OVERVIEW_KLINE_LIMIT)
      } catch {
        klines = []
      }
    }
    const metrics = buildOverviewMetrics(klines)
    const quote = applyTicker(metrics, ticker)
    let ivPercentile: number | undefined
    if (includeIv) {
      try {
        const report = await this.requireCnOptions().getVolAnalytics({
          underlying: row.underlying,
          ...(source === undefined ? {} : { source }),
        })
        ivPercentile = extractIvPercentile(report)
      } catch {
        ivPercentile = undefined
      }
    }
    const ivSlice = await this.#overviewAtmIv(row.underlying, source)
    const atmIv = ivSlice.atmIv
    const nextAtmIv = ivSlice.nextAtmIv
    const hv20 = hv20FromKlines(klines)
    if (ivPercentile === undefined && atmIv !== undefined) {
      const series = ivHistory
        .filter((item) => item.underlying === row.underlying && item.atmIv !== undefined)
        .map((item) => ({ date: item.date, atmIv: item.atmIv as number }))
      ivPercentile = atmIvPercentile(series, atmIv)
    }
    const ivRegime = tagIvRegime({
      ...(ivPercentile === undefined ? {} : { ivPercentile }),
      ...(atmIv === undefined ? {} : { atmIv }),
      ...(nextAtmIv === undefined ? {} : { nextAtmIv }),
      ...(hv20 === undefined ? {} : { hv20 }),
    })
    const scanPrompt = composeScanPrompt({
      underlying: row.underlying,
      name: row.name,
      ...quote,
      ...(metrics.return5d === undefined ? {} : { return5d: metrics.return5d }),
      ...(metrics.volumeRatio === undefined ? {} : { volumeRatio: metrics.volumeRatio }),
      ...(row.heldQty === undefined ? {} : { heldQty: row.heldQty }),
      ...(optionQty === undefined ? {} : { optionQty }),
      ...(ivPercentile === undefined ? {} : { ivPercentile }),
      ...(atmIv === undefined ? {} : { atmIv }),
      ...(metrics.divergence === undefined ? {} : { divergence: metrics.divergence }),
    })
    return {
      underlying: row.underlying,
      name: row.name,
      exchange: row.exchange,
      days: metrics.days,
      scanPrompt,
      ...(spotSymbol === undefined ? {} : { spotSymbol }),
      ...(link === undefined ? {} : { link }),
      ...quote,
      ...(metrics.return5d === undefined ? {} : { return5d: metrics.return5d }),
      ...(metrics.volumeRatio === undefined ? {} : { volumeRatio: metrics.volumeRatio }),
      ...(metrics.strengthScore === undefined ? {} : { strengthScore: metrics.strengthScore }),
      ...(metrics.divergence === undefined ? {} : { divergence: metrics.divergence }),
      ...(row.heldQty === undefined ? {} : { heldQty: row.heldQty }),
      ...(optionQty === undefined ? {} : { optionQty }),
      ...(ivPercentile === undefined ? {} : { ivPercentile }),
      ...(atmIv === undefined ? {} : { atmIv }),
      ...(nextAtmIv === undefined ? {} : { nextAtmIv }),
      ...(hv20 === undefined ? {} : { hv20 }),
      ivRegime,
    }
  }

  /** 当天最新 ContextPacket（定时桶打标快照）。无文件 → 不写 packet 键。 */
  async optionBarPacket(): Promise<OptionBarPacketWire> {
    const packet = await loadLatestPacket(optionsDataRoot(), Date.now())
    return packet === undefined ? { ok: true } : { ok: true, packet }
  }

  async #overviewAtmIv(
    underlying: string,
    source: 'akshare' | 'iquant' | 'synth' | undefined,
  ): Promise<{ atmIv?: number; nextAtmIv?: number }> {
    const cached = this.#atmIvCache.get(underlying)
    const ttl = cached === undefined || cached.atmIv === undefined
      ? OVERVIEW_ATM_IV_MISS_TTL_MS
      : OVERVIEW_ATM_IV_TTL_MS
    if (cached !== undefined && Date.now() - cached.fetchedAt < ttl) {
      return {
        ...(cached.atmIv === undefined ? {} : { atmIv: cached.atmIv }),
        ...(cached.nextAtmIv === undefined ? {} : { nextAtmIv: cached.nextAtmIv }),
      }
    }
    const value = await this.#fetchOverviewAtmIv(underlying, source)
    this.#atmIvCache.set(underlying, { ...value, fetchedAt: Date.now() })
    return value
  }

  async #monthAtmIv(
    underlying: string,
    expiryMonth: string,
    source: 'akshare' | 'iquant' | 'synth' | undefined,
  ): Promise<number | undefined> {
    const query = {
      underlying,
      expiryMonth,
      rate: OVERVIEW_IV_RATE,
      ...(source === undefined ? {} : { source }),
    }
    const live = await this.requireCnOptions().getImpliedVol({ ...query, priceField: 'last' })
    const fromLast = extractAtmIv(live)
    if (fromLast !== undefined) return fromLast
    const settle = await this.requireCnOptions().getImpliedVol({ ...query, priceField: 'prevSettle' })
    return extractAtmIv(settle)
  }

  async #fetchOverviewAtmIv(
    underlying: string,
    source: 'akshare' | 'iquant' | 'synth' | undefined,
  ): Promise<{ atmIv?: number; nextAtmIv?: number }> {
    try {
      const calendar = await this.requireCnOptions().getOptionExpiries({
        underlying,
        ...(source === undefined ? {} : { source }),
      })
      const near = calendar.months[0]?.expiryMonth
      const next = calendar.months[1]?.expiryMonth
      if (near === undefined || near.trim() === '') return {}
      const atmIv = await this.#monthAtmIv(underlying, near, source)
      let nextAtmIv: number | undefined
      if (next !== undefined && next.trim() !== '') {
        try {
          nextAtmIv = await this.#monthAtmIv(underlying, next, source)
        } catch {
          nextAtmIv = undefined
        }
      }
      return {
        ...(atmIv === undefined ? {} : { atmIv }),
        ...(nextAtmIv === undefined ? {} : { nextAtmIv }),
      }
    } catch {
      return {}
    }
  }

  /**
   * L2 1 分钟 → 5 分钟箱体。计算在 kit-cn 纯函数；本方法只拉名册 + 现货 1m K。
   * 单行行情失败 → 该行 no_trade，不整页失败。horizon 只接受 5。
   */
  async optionIntradayBox(
    underlyingRaw?: string,
    horizonRaw?: string,
    asOfRaw?: string,
  ): Promise<OptionIntradayBoxWire> {
    if (horizonRaw !== undefined && horizonRaw !== '' && horizonRaw !== '5') {
      throw new BridgeProtocolError(400, 'intraday-box: horizon must be 5')
    }
    let nowMs = Date.now()
    if (asOfRaw !== undefined && asOfRaw.trim() !== '') {
      const parsed = Date.parse(asOfRaw)
      if (!Number.isFinite(parsed)) throw new BridgeProtocolError(400, 'intraday-box: asOf must be ISO-8601')
      nowMs = parsed
    }
    const roster = (await this.requireCnOptions().listUnderlyings()).filter((row) => row.exchange !== 'SYNTH')
    const underlying = underlyingRaw?.trim() === '' ? undefined : underlyingRaw?.trim()
    if (underlying !== undefined && selectBoxTargets(roster, underlying).length === 0) {
      throw Object.assign(
        new Error(`unknown option underlying ${underlying}`),
        { code: 'TRADING_UNSUPPORTED_SYMBOL' },
      )
    }
    const market = this.host.getMarketService('cn')
    const box = await collectIntradayBox({
      roster,
      nowMs,
      ...(underlying === undefined ? {} : { underlying }),
      ...(market === undefined ? {} : { market }),
    })
    return { ok: true, box }
  }

  optionCycles(underlyingRaw?: string, limitRaw?: string): OptionCyclesWire {
    this.requireCnOptions()
    const limit = limitRaw === undefined || limitRaw.trim() === '' ? 12 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new BridgeProtocolError(400, 'cycles: limit must be a positive integer')
    }
    const underlying = underlyingRaw?.trim() === '' ? undefined : underlyingRaw?.trim()
    return { ok: true, cycles: this.#cycles.list(underlying, limit) }
  }

  async optionCycleLoop(): Promise<OptionCycleLoopWire> {
    const roster = (await this.requireCnOptions().listUnderlyings()).filter((row) => row.exchange !== 'SYNTH')
    return { ok: true, loop: this.#cycles.loop(roster.map((row) => row.underlying)) }
  }

  /* ── T+1 预测模块（盘势/波动预期 + 跟踪回溯 + 经验沉淀；2026-09-12）──────
   * 预测是用户/Agent 结构化录入，纯本地 JSONL，不依赖期权网关；故此处不调
   * requireCnOptions()，网关未起也能完整使用。评分在 settle 时由本桥权威计算。 */

  /** 校验并归一化新建预测请求体（缺键 / 非法枚举 / 越界即 400）。 */
  private static parsePredictionDraft(body: unknown): OptionPredictionDraft {
    if (typeof body !== 'object' || body === null) throw new BridgeProtocolError(400, 'predictions: body must be an object')
    const b = body as Record<string, unknown>
    const underlying = typeof b.underlying === 'string' ? b.underlying.trim() : ''
    if (underlying === '') throw new BridgeProtocolError(400, 'predictions: underlying is required')
    const targetDate = typeof b.targetDate === 'string' ? b.targetDate.trim() : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new BridgeProtocolError(400, 'predictions: targetDate must be YYYY-MM-DD')
    const marketExpectation = b.marketExpectation
    const MARKET: readonly MarketExpectation[] = ['big_up', 'small_up', 'big_down', 'small_down', 'breakout', 'consolidation']
    if (typeof marketExpectation !== 'string' || !MARKET.includes(marketExpectation as MarketExpectation)) {
      throw new BridgeProtocolError(400, 'predictions: marketExpectation must be one of big_up/small_up/big_down/small_down/breakout/consolidation')
    }
    const volExpectation = b.volExpectation
    const VOL: readonly VolExpectation[] = ['up', 'down']
    if (typeof volExpectation !== 'string' || !VOL.includes(volExpectation as VolExpectation)) {
      throw new BridgeProtocolError(400, 'predictions: volExpectation must be up or down')
    }
    const confidence = Number(b.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new BridgeProtocolError(400, 'predictions: confidence must be a number in [0, 1]')
    }
    const factorsRaw = Array.isArray(b.factors) ? b.factors : []
    const factors = factorsRaw.map((item, index) => {
      if (typeof item !== 'object' || item === null) throw new BridgeProtocolError(400, `predictions: factors[${index}] must be an object`)
      const f = item as Record<string, unknown>
      const BIAS: readonly PredictionBias[] = ['bull', 'bear', 'neutral']
      const bias = f.bias
      if (typeof bias !== 'string' || !BIAS.includes(bias as PredictionBias)) {
        throw new BridgeProtocolError(400, `predictions: factors[${index}].bias must be bull/bear/neutral`)
      }
      const label = typeof f.label === 'string' ? f.label.trim() : ''
      const evidence = typeof f.evidence === 'string' ? f.evidence.trim() : ''
      if (label === '' || evidence === '') throw new BridgeProtocolError(400, `predictions: factors[${index}].label/evidence required`)
      const weight = f.weight === undefined ? undefined : Number(f.weight)
      if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1)) {
        throw new BridgeProtocolError(400, `predictions: factors[${index}].weight must be in [0, 1]`)
      }
      const id = typeof f.id === 'string' && f.id !== '' ? f.id : `f${index}`
      return {
        id,
        label,
        bias: bias as PredictionBias,
        ...(weight === undefined ? {} : { weight }),
        evidence,
      }
    })
    const thesis = typeof b.thesis === 'string' ? b.thesis.trim() : ''
    if (thesis === '') throw new BridgeProtocolError(400, 'predictions: thesis is required')
    const evaluationMethod = typeof b.evaluationMethod === 'string' ? b.evaluationMethod.trim() : ''
    if (evaluationMethod === '') throw new BridgeProtocolError(400, 'predictions: evaluationMethod is required')
    return {
      underlying,
      ...(typeof b.underlyingName === 'string' && b.underlyingName.trim() !== '' ? { underlyingName: b.underlyingName.trim() } : {}),
      targetDate,
      marketExpectation: marketExpectation as MarketExpectation,
      volExpectation: volExpectation as VolExpectation,
      confidence,
      factors,
      thesis,
      evaluationMethod,
    }
  }

  /** 校验并归一化回填请求体（只校验原始实盘字段；命中/评分由 settle 计算）。 */
  private static parsePredictionSettle(body: unknown): OptionPredictionSettle {
    if (typeof body !== 'object' || body === null) throw new BridgeProtocolError(400, 'predictions/settle: body must be an object')
    const b = body as Record<string, unknown>
    const id = typeof b.id === 'string' ? b.id.trim() : ''
    if (id === '') throw new BridgeProtocolError(400, 'predictions/settle: id is required')
    const MARKET: readonly MarketExpectation[] = ['big_up', 'small_up', 'big_down', 'small_down', 'breakout', 'consolidation']
    const realizedMarket = b.realizedMarket
    if (typeof realizedMarket !== 'string' || (!MARKET.includes(realizedMarket as MarketExpectation) && realizedMarket !== 'na')) {
      throw new BridgeProtocolError(400, 'predictions/settle: realizedMarket must be a MarketExpectation or na')
    }
    const VOL: readonly VolExpectation[] = ['up', 'down']
    const realizedVol = b.realizedVol
    if (typeof realizedVol !== 'string' || (!VOL.includes(realizedVol as VolExpectation) && realizedVol !== 'na')) {
      throw new BridgeProtocolError(400, 'predictions/settle: realizedVol must be up/down or na')
    }
    const marketReturnPct = Number(b.marketReturnPct)
    if (!Number.isFinite(marketReturnPct)) throw new BridgeProtocolError(400, 'predictions/settle: marketReturnPct must be a number')
    const volChange = Number(b.volChange)
    if (!Number.isFinite(volChange)) throw new BridgeProtocolError(400, 'predictions/settle: volChange must be a number')
    const retrospect = typeof b.retrospect === 'string' ? b.retrospect.trim() : ''
    const knowledgeNotes = typeof b.knowledgeNotes === 'string' ? b.knowledgeNotes.trim() : ''
    return {
      id,
      realizedMarket: realizedMarket as MarketExpectation | 'na',
      realizedVol: realizedVol as VolExpectation | 'na',
      marketReturnPct,
      volChange,
      retrospect,
      knowledgeNotes,
    }
  }

  async optionPredictions(underlyingRaw?: string, asOfRaw?: string): Promise<{ ok: true; board: OptionPredictionBoard }> {
    const underlying = underlyingRaw?.trim() === '' ? undefined : underlyingRaw?.trim()
    const asOf = asOfRaw?.trim() === '' ? undefined : asOfRaw?.trim()
    await this.#backfillPredictionsTMinus1()
    const board = await this.#predictions.board(underlying, asOf)
    return { ok: true, board }
  }

  async optionPredictionTrack(underlyingRaw?: string, limitRaw?: string): Promise<{ ok: true; track: OptionPredictionTrack }> {
    const underlying = underlyingRaw?.trim() === '' ? undefined : underlyingRaw?.trim()
    const limit = limitRaw === undefined || limitRaw.trim() === '' ? undefined : Number(limitRaw)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new BridgeProtocolError(400, 'predictions/track: limit must be a positive integer')
    }
    await this.#backfillPredictionsTMinus1()
    const track = await this.#predictions.track(underlying, limit)
    return { ok: true, track }
  }

  async optionPredictionKnowledge(underlyingRaw?: string): Promise<{ ok: true; knowledge: readonly PredictionKnowledgeItem[] }> {
    const underlying = underlyingRaw?.trim() === '' ? undefined : underlyingRaw?.trim()
    const knowledge = await this.#predictions.knowledge(underlying)
    return { ok: true, knowledge }
  }

  async createOptionPrediction(body: unknown): Promise<{ ok: true; prediction: OptionPrediction }> {
    const draft = TradingBridge.parsePredictionDraft(body)
    const prediction = await this.#predictions.create(draft)
    return { ok: true, prediction }
  }

  async settleOptionPrediction(body: unknown): Promise<{ ok: true; prediction: OptionPrediction }> {
    const input = TradingBridge.parsePredictionSettle(body)
    const prediction = await this.#predictions.settle(input)
    return { ok: true, prediction }
  }

  /**
   * 用 CN 现货日 K + iv-daily 回填 realized*，再走权威 settle。
   * 不调期权网关；无日 K / 无 IV 时对应维写 na。
   */
  async autoSettleOptionPredictions(body: unknown): Promise<
    { ok: true; prediction: OptionPrediction } | { ok: true; result: OptionPredictionAutoSettleResult }
  > {
    if (typeof body !== 'object' || body === null) {
      throw new BridgeProtocolError(400, 'predictions/settle-auto: body must be an object')
    }
    const b = body as Record<string, unknown>
    const id = typeof b.id === 'string' ? b.id.trim() : ''
    const asOfRaw = typeof b.asOf === 'string' ? b.asOf.trim() : ''
    if (asOfRaw !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
      throw new BridgeProtocolError(400, 'predictions/settle-auto: asOf must be YYYY-MM-DD')
    }
    const asOf = asOfRaw !== '' ? asOfRaw : await this.#predictionAutoAsOf()
    const retrospect = typeof b.retrospect === 'string' ? b.retrospect.trim() : undefined
    const knowledgeNotes = typeof b.knowledgeNotes === 'string' ? b.knowledgeNotes.trim() : undefined
    const load = async (prediction: OptionPrediction) => {
      const symbol = etfSpotSymbol(prediction.underlying)
      const market = this.host.getMarketService('cn')
      let bars: ReturnType<typeof klinesToPredictionBars> = []
      if (symbol !== undefined && market !== undefined) {
        try {
          bars = klinesToPredictionBars(await market.getKlines(symbol, '1d', 80))
        } catch {
          bars = []
        }
      }
      const ivSeries = (await readJsonl<OptionBarDailyIv>(ivDailyPath(optionsDataRoot())))
        .filter((row) => row.underlying === prediction.underlying)
      return {
        bars,
        ivSeries,
        ...(retrospect !== undefined && retrospect !== '' ? { retrospect } : {}),
        ...(knowledgeNotes !== undefined && knowledgeNotes !== '' ? { knowledgeNotes } : {}),
      }
    }
    if (id !== '') {
      const listed = (await this.#predictions.track()).predictions
      const current = listed.find((row) => row.id === id)
      if (current === undefined) throw new BridgeProtocolError(400, `predictions/settle-auto: not found ${id}`)
      return { ok: true, prediction: await this.#predictions.autoSettle(id, await load(current)) }
    }
    return { ok: true, result: await this.#predictions.settleDue(asOf, load) }
  }

  /** 看板/跟踪默认先按 T-1 自动回填；已手工 settle 的条目 settleDue 会跳过。 */
  async #backfillPredictionsTMinus1(): Promise<void> {
    try {
      await this.autoSettleOptionPredictions({})
    } catch {
      // 缺日 K / 无 CN 市场时保持 pending，不挡跟踪页
    }
  }

  async #predictionAutoAsOf(): Promise<string> {
    const today = shanghaiCalendarDate(Date.now())
    const market = this.host.getMarketService('cn')
    if (market === undefined) return resolvePredictionAutoAsOf(today)
    try {
      const bars = klinesToPredictionBars(await market.getKlines('510050.SH', '1d', 20))
      const last = bars.filter((row) => row.date < today).at(-1)?.date
      return resolvePredictionAutoAsOf(today, last)
    } catch {
      return resolvePredictionAutoAsOf(today)
    }
  }

  /** 纸账户账本 id 解析：缺省 strategy（旧行为），非法值 400。 */
  #parsePaperBook(bookRaw: string | undefined): OptionPaperBookId {
    if (bookRaw === undefined || bookRaw.trim() === '') return 'strategy'
    const trimmed = bookRaw.trim()
    if (trimmed !== 'strategy' && trimmed !== 'arbitrage') {
      throw new BridgeProtocolError(400, 'options paper: book must be strategy|arbitrage')
    }
    return trimmed
  }

  /** 单账本视图：账户 + 持仓 + 盯市权益（期权腿链价回落 fillPrice，现货腿现价回落）。 */
  async #optionPaperBook(book: OptionPaperBookId): Promise<OptionPaperBookWire> {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const state = await loadPaperState(optionsDataRoot(), shanghaiCalendarDate(nowMs), nowIso, book)
    const getMark = this.#paperMarkLookup()
    const marketValueRows = await Promise.all(state.positions.flatMap((position) => (
      position.legs.map(async (leg) => {
        if (leg.asset === 'spot') {
          const spot = await this.#spotPriceOf(leg.code)
          return markLegValueCny(leg, spot ?? leg.fillPrice)
        }
        const mark = await getMark(leg.code, leg.side)
        return markLegValueCny(leg, mark?.price ?? leg.fillPrice)
      })
    )))
    const marginCny = state.positions.reduce((total, position) => total + position.marginCny, 0)
    return {
      ok: true,
      book,
      account: state.account,
      equity: state.account.cash
        + marginCny
        + marketValueRows.reduce((total, value) => total + value, 0),
      positions: state.positions,
    }
  }

  async optionPaperAccount(bookRaw?: string): Promise<OptionPaperBookWire> {
    return await this.#optionPaperBook(this.#parsePaperBook(bookRaw))
  }

  /** 全部纸账户账本（资产面板两卡一次拉全）。 */
  async optionPaperAccounts(): Promise<OptionPaperAccountsWire> {
    const books = await Promise.all((
      ['arbitrage', 'strategy'] as const
    ).map((book) => this.#optionPaperBook(book)))
    return { ok: true, books }
  }

  async optionPaperFills(limitRaw?: string, bookRaw?: string): Promise<OptionPaperFillsWire> {
    const limit = limitRaw === undefined || limitRaw.trim() === '' ? 48 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new BridgeProtocolError(400, 'options paper fills: limit must be a positive integer')
    }
    const nowMs = Date.now()
    const state = await loadPaperState(
      optionsDataRoot(),
      shanghaiCalendarDate(nowMs),
      new Date(nowMs).toISOString(),
      this.#parsePaperBook(bookRaw),
    )
    return { ok: true, fills: state.fills.slice(-limit).reverse() }
  }

  async resetOptionPaper(bookRaw?: string): Promise<OptionPaperBookWire> {
    const book = this.#parsePaperBook(bookRaw)
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    await resetPaperState(optionsDataRoot(), nowIso, book)
    return await this.#optionPaperBook(book)
  }

  /** 纸账户工作台：近 N 日执行链路统计 + 账户快照 + 跨日流水（诊断"有候选无成交"缺口）。 */
  async optionPaperDesk(daysRaw?: string): Promise<OptionPaperDeskWire> {
    const days = daysRaw === undefined || daysRaw.trim() === '' ? PAPER_DESK_DEFAULT_DAYS : Number(daysRaw)
    if (!Number.isInteger(days) || days <= 0 || days > PAPER_DESK_MAX_DAYS) {
      throw new BridgeProtocolError(400, 'options paper desk: days must be an integer in 1..30')
    }
    const nowMs = Date.now()
    const ledger = await loadPaperDesk(optionsDataRoot(), days)
    const { account, equity, positions } = await this.optionPaperAccount()
    return {
      ok: true,
      desk: {
        account,
        equity,
        positions,
        days: ledger.days,
        dayCount: ledger.dayCount,
        recentFills: ledger.recentFills,
        asOf: new Date(nowMs).toISOString(),
      },
    }
  }

  #paperMarkLookup(): (code: string, side: 'buy' | 'sell') => Promise<PaperMarkQuote | undefined> {
    const service = this.host.getCnOptions?.()
    const chains = new Map<string, Promise<OptionChain | undefined>>()
    return async (code) => {
      if (service === undefined) return undefined
      const parsed = code.toUpperCase().match(/^(\d{6})[CP](\d{4})/)
      if (parsed === null) return undefined
      const [, underlying, expiryMonth] = parsed
      const key = `${underlying}:${expiryMonth}`
      let pending = chains.get(key)
      if (pending === undefined) {
        pending = service.getOptionChain({ underlying: underlying!, expiryMonth: expiryMonth! })
          .catch(() => undefined)
        chains.set(key, pending)
      }
      const chain = await pending
      const row = [...(chain?.calls ?? []), ...(chain?.puts ?? [])]
        .find((candidate) => candidate.code.toUpperCase() === code.toUpperCase())
      return row === undefined ? undefined : quoteFillPriceWithSource(row)
    }
  }

  /** 套利引擎拉链：60s TTL 进程内缓存（失败不缓存，下轮重试），refresh 强制新拉覆盖。 */
  async #arbChain(underlying: string, expiryMonth: string, opts?: { refresh?: boolean }): Promise<OptionChain | undefined> {
    const key = `${underlying}:${expiryMonth}`
    const cached = this.#arbChainCache.get(key)
    if (opts?.refresh !== true && cached !== undefined && Date.now() - cached.at < OPTION_ARB_CHAIN_TTL_MS) {
      return await cached.promise
    }
    const promise = this.requireCnOptions().getOptionChain({ underlying, expiryMonth })
      .then((chain) => this.#withSpot(chain))
      .catch(() => undefined)
    this.#arbChainCache.set(key, { at: Date.now(), promise })
    const chain = await promise
    if (chain === undefined) this.#arbChainCache.delete(key)
    return chain
  }

  /**
   * 5 分钟桶：给上一桶补分，再在 regular 会话开新预报。同桶幂等。
   * 宿主 30s 心跳调用；POST 供回放 / 单测。
   */
  async optionCycleTick(asOfRaw?: string): Promise<OptionCycleTickWire> {
    let nowMs = Date.now()
    if (asOfRaw !== undefined && asOfRaw.trim() !== '') {
      const parsed = Date.parse(asOfRaw)
      if (!Number.isFinite(parsed)) throw new BridgeProtocolError(400, 'cycles/tick: asOf must be ISO-8601')
      nowMs = parsed
    }
    const roster = (await this.requireCnOptions().listUnderlyings()).filter((row) => row.exchange !== 'SYNTH')
    const market = this.host.getMarketService('cn')
    const bucket = shanghaiBucketStartMs(nowMs)
    const prevBucket = bucket - CYCLE_HORIZON_MS
    this.#cycles.lastBucket = new Date(bucket).toISOString()
    const box = await collectIntradayBox({
      roster,
      nowMs,
      ...(market === undefined ? {} : { market }),
    })
    let ticked = false
    for (const row of box.rows) {
      const prev = this.#cycles.latest(row.underlying)
      if (
        prev !== undefined
        && prev.score === undefined
        && Date.parse(prev.bucketStart) === prevBucket
        && market !== undefined
        && row.spotSymbol !== undefined
      ) {
        let klines: readonly Kline[] = []
        try {
          klines = await market.getKlines(row.spotSymbol, '1m', 20)
        } catch {
          klines = []
        }
        const realized = realizedInWindow(klines, prevBucket, bucket)
        await this.writeCycle({
          ...prev,
          score: scorePreviousCycle({ forecast: prev.forecast, realized }),
        })
      }
      const existing = this.#cycles.latest(row.underlying)
      if (existing?.id === cycleId(row.underlying, bucket)) continue
      const { forecast, calibration } = calibrateNextForecast(row, this.#cycles.scores(row.underlying))
      await this.writeCycle({
        id: cycleId(row.underlying, bucket),
        underlying: row.underlying,
        bucketStart: new Date(bucket).toISOString(),
        asOf: new Date(nowMs).toISOString(),
        forecast,
        calibration,
      })
      ticked = true
    }
    const date = shanghaiCalendarDate(nowMs)
    const rowByUnderlying = new Map(box.rows.map((row) => [row.underlying, row]))
    const getMark = this.#paperMarkLookup()
    void tryPaperManage({
      root: optionsDataRoot(),
      date,
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
      session: sessionFlag(nowMs),
      calendarDate: date,
      getMark,
      getLastClose: async (underlying) => {
        const row = rowByUnderlying.get(underlying)
        if (market === undefined || row?.spotSymbol === undefined) return undefined
        try {
          const klines = await market.getKlines(row.spotSymbol, '1m', 5)
          const lastClose = klines.at(-1)?.close
          if (lastClose === undefined || !Number.isFinite(lastClose)) return undefined
          return {
            lastClose,
            ...(row.volumeRatio === undefined ? {} : { volumeRatio: row.volumeRatio }),
          }
        } catch {
          return undefined
        }
      },
    }).catch((error) => {
      console.error('[dsh-trading/options-paper] manage failed:', error)
    })
    // 套利纸面周期（30s 心跳驱动；上轮未完跳过，超 5min 视为僵死放行重试）。
    if (this.#arbCycleInFlightSince === 0 || nowMs - this.#arbCycleInFlightSince >= 5 * 60_000) {
      this.#arbCycleInFlightSince = nowMs
      const exchangeByUnderlying = new Map(roster.map((row) => [row.underlying, row.exchange]))
      void tryArbPaperCycle({
        root: optionsDataRoot(),
        date,
        nowMs,
        nowIso: new Date(nowMs).toISOString(),
        session: sessionFlag(nowMs),
        underlyings: roster.map((row) => row.underlying),
        // 近/次两月：过期月滤除后按到期日升序取前二。
        expiryMonthsFor: async (underlying) => {
          try {
            const calendar = await this.requireCnOptions().getOptionExpiries({ underlying })
            return [...calendar.months]
              .filter((row) => row.expiryDate >= date)
              .sort((left, right) => left.expiryDate.localeCompare(right.expiryDate))
              .slice(0, 2)
              .map((row) => row.expiryMonth)
          } catch {
            return []
          }
        },
        getChain: async (underlying, month, opts) => await this.#arbChain(underlying, month, opts),
        getSpot: async (underlying) => await this.#spotPriceOf(underlying),
        // 每张口径保证金（option-bar-agent getMargin 同款：getStrategy totalInitial）。
        getOptionLegMarginPerContract: async (underlying, legs) => {
          try {
            const result = await this.requireCnOptions().getStrategy({
              underlying,
              legs: legs.map((leg) => ({ kind: 'option' as const, code: leg.code, side: leg.action, qty: 1 })),
            })
            return result.margin?.totalInitial
          } catch {
            return undefined
          }
        },
        spotSymbolFor: (underlying) => {
          const exchange = exchangeByUnderlying.get(underlying)
          return exchange === 'SSE' ? `${underlying}.SH`
            : exchange === 'SZSE' ? `${underlying}.SZ`
            : undefined
        },
      }).catch((error) => {
        console.error('[dsh-trading/options-paper-arb] cycle failed:', error)
      }).finally(() => {
        this.#arbCycleInFlightSince = 0
      })
    }
    // 转债折价周期（300s 节流、仅 regular；失败静默不阻断 tick——台账行自带错误标记）。
    if (shouldRunCbScan(nowMs, this.#cbScanLastMs, sessionFlag(nowMs), CB_SCAN_INTERVAL_MS)) {
      this.#cbScanLastMs = nowMs
      void this.#cbDiscountScan(date, nowMs)
    }
    return {
      ok: true,
      ticked,
      asOf: new Date(nowMs).toISOString(),
      loop: this.#cycles.loop(roster.map((row) => row.underlying)),
    }
  }

  /**
   * 转债折价扫描落账（观察轨，data/options/cb/<date>.jsonl）：
   * active provider 无 getCovSnapshot（如 cn 路由在 iquant）→ 每日一条能力缺失通知行；
   * 拉取/扫描失败 → 错误行；成功 → 计数 + top 命中（封顶 10）。
   */
  async #cbDiscountScan(date: string, nowMs: number): Promise<void> {
    const root = optionsDataRoot()
    const asOf = new Date(nowMs).toISOString()
    const base = { kind: 'cb_scan', asOf, scanned: 0, priced: 0, stale: 0, hitCount: 0, top: [] } as const
    const market = this.host.getMarketService('cn')
    if (market?.getCovSnapshot === undefined) {
      if (this.#cbCapabilityNoticeDate === date) return
      this.#cbCapabilityNoticeDate = date
      await appendJsonlLine(cbScanPath(root, date), {
        ...base,
        error: 'active cn market provider has no getCovSnapshot (route cn provider to akshare to enable CB tracking)',
      })
      return
    }
    try {
      const rows = await market.getCovSnapshot()
      const scan = scanCbDiscount(rows)
      await appendJsonlLine(cbScanPath(root, date), {
        kind: 'cb_scan',
        asOf,
        scanned: scan.scanned,
        priced: scan.priced,
        stale: scan.stale,
        hitCount: scan.hits.length,
        top: scan.hits.slice(0, 10),
      })
    } catch (error) {
      await appendJsonlLine(cbScanPath(root, date), {
        ...base,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    }
  }

  private async writeCycle(cycle: import('@dshtrading/api').OptionCycle): Promise<void> {
    const saved = this.#cycles.upsert(cycle)
    try {
      await this.onCycleWrite?.(saved)
    } catch (error) {
      console.error('[dsh-trading/options-cycle] persist failed:', error)
    }
  }

  /**
   * 盘口快照（GUI「盘口」竖栏，issue #39）：单 symbol 透传。连接器未实现可选
   * getOrderbook → TRADING_NOT_IMPLEMENTED 业务错误，
   * 前端竖栏显示「该市场未提供盘口」。
   */
  async orderbook(market: string, symbol: string): Promise<OrderbookWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'orderbook: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    if (typeof service.getOrderbook !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement orderbook`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, orderbook: await service.getOrderbook(trimmed) }
  }

  /**
   * 最近逐笔成交（GUI「分笔」流水，issue #39）：透传 limit（服务端封顶）。
   * 未实现可选 getRecentTrades（腾讯沪深行情行无逐笔端点）→ TRADING_NOT_IMPLEMENTED。
   */
  async trades(market: string, symbol: string, rawLimit: string | null): Promise<TradesWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'trades: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_TRADES_LIMIT)) {
      throw new BridgeProtocolError(400, `trades: limit must be an integer in 1..${MAX_TRADES_LIMIT}`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    if (typeof service.getRecentTrades !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement recent trades`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, trades: await service.getRecentTrades(trimmed, limit) }
  }

  /* ---------------------------------------------------------------- */
  /* 交易台（issue #40）：只读查询 + 强制 dry-run 下单                      */
  /* ---------------------------------------------------------------- */

  /** 交易服务解析：注册表无注册项（未安装交易连接器）→ undefined（调用方 400）。 */
  #requireTradeService(market: string): TradeService {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trade = this.host.getTradeService?.(market)
    if (trade === undefined) {
      // 专用 code（2026-09-04）：前端据此区分「市场未挂交易连接器」与「凭证缺失」，
      // 不再把服务未注册误导渲染成「凭证未配置或不可用」。
      throw Object.assign(new BridgeProtocolError(400, `no trade service for market ${market}`), { code: 'TRADING_NO_TRADE_SERVICE' })
    }
    return trade
  }

  async positions(market: string): Promise<PositionsWire> {
    return { ok: true, positions: await this.#requireTradeService(market).getPositions() }
  }

  async balances(market: string): Promise<BalancesWire> {
    const trade = this.#requireTradeService(market)
    if (typeof trade.getBalances !== 'function') {
      throw Object.assign(new Error('trade service does not implement balances'), { code: 'TRADING_NOT_IMPLEMENTED' })
    }
    return { ok: true, balances: await trade.getBalances() }
  }

  async openOrders(market: string): Promise<OpenOrdersWire> {
    const trade = this.#requireTradeService(market)
    if (typeof trade.listOpenOrders !== 'function') {
      throw Object.assign(new Error('trade service does not implement open orders'), { code: 'TRADING_NOT_IMPLEMENTED' })
    }
    return { ok: true, orders: await trade.listOpenOrders() }
  }

  async tradeFills(market: string): Promise<TradeFillsWire> {
    const trade = this.#requireTradeService(market)
    if (typeof trade.listTradeFills !== 'function') {
      throw Object.assign(new Error('trade service does not implement trade fills'), { code: 'TRADING_NOT_IMPLEMENTED' })
    }
    return { ok: true, fills: await trade.listTradeFills() }
  }

  /**
   * GUI 下单（真交易执行）：支持实盘报单（默认 dryRun: false）。
   * 若底层连接器未配置 API 凭证或未开启 liveTrading，由服务缝闸门抛出标准错误，
   * 桥层如实向前端返回，杜绝伪造假成交。
   */
  async placeOrderFromGui(market: string, body: GuiOrderBody): Promise<PlaceOrderWire> {
    const trade = this.#requireTradeService(market)
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
    const side = body.side === 'sell' ? 'sell' as const : body.side === 'buy' ? 'buy' as const : undefined
    const type = body.type === 'limit' ? 'limit' as const : body.type === 'market' ? 'market' as const : undefined
    const quantity = typeof body.quantity === 'number' ? body.quantity : Number.NaN
    if (symbol === '') throw new BridgeProtocolError(400, 'place order: symbol is required')
    if (side === undefined) throw new BridgeProtocolError(400, 'place order: side must be buy or sell')
    if (type === undefined) throw new BridgeProtocolError(400, 'place order: type must be market or limit')
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BridgeProtocolError(400, 'place order: quantity must be a positive number')
    }
    const price = typeof body.price === 'number' ? body.price : undefined
    if (type === 'limit' && (price === undefined || !Number.isFinite(price) || price <= 0)) {
      throw new BridgeProtocolError(400, 'place order: limit orders require a positive price')
    }
    const requestedDryRun = typeof body.dryRun === 'boolean' ? body.dryRun : false
    const order = await trade.placeOrder({
      symbol,
      side,
      type,
      quantity,
      ...(price !== undefined ? { price } : {}),
      dryRun: requestedDryRun,
    })
    return { ok: true, order }
  }

  /** GUI 撤单（issue #40）：按 market + orderId + 可选 symbol 分发到激活的交易服务。 */
  async cancelOrderFromGui(market: string, orderId: string, symbol?: string): Promise<{ ok: true; canceled: boolean }> {
    const trade = this.#requireTradeService(market)
    const trimmedId = orderId.trim()
    if (!trimmedId) throw new BridgeProtocolError(400, 'cancel order: id is required')
    await trade.cancelOrder(trimmedId, symbol?.trim())
    return { ok: true, canceled: true }
  }

  /** 自定义指标列表。 */
  async customIndicators(): Promise<CustomIndicatorsWire> {
    const store = this.host.customIndicatorsStore
    if (store === undefined) return { ok: true, indicators: [] }
    const indicators = await store.list()
    return { ok: true, indicators }
  }

  /** 删除自定义指标。 */
  async deleteCustomIndicator(id: string): Promise<{ ok: boolean; removed: boolean }> {
    const store = this.host.customIndicatorsStore
    if (store === undefined) return { ok: true, removed: false }
    const removed = await store.remove(id)
    return { ok: true, removed }
  }

  /** 获取全部沉淀的知识卡片列表。 */
  async knowledgeCards(): Promise<KnowledgeCardsWire> {
    const store = this.host.knowledgeStore
    if (store === undefined) return { ok: true, cards: [] }
    const cards = await store.list()
    return { ok: true, cards }
  }

  /* -- 统一资产台账（issue #65，契约 §3）------------------------------------ */

  /** 台账快照（staged 待确认区 + holdings 正式区 + revision）。 */
  async holdings(): Promise<HoldingsWire> {
    const store = this.host.holdingsStore
    if (store === undefined) return { ok: true, revision: 0, staged: [], holdings: [] }
    const snap = await store.snapshot()
    return { ok: true, revision: snap.revision, staged: [...snap.staged], holdings: [...snap.holdings] }
  }

  /**
   * 写操作 revision 宽容解析（契约未刊 store 返回形状，已回报）：
   * number / { revision } / 其它 → 回退 snapshot().revision。
   */
  async #holdingsRevision(result: unknown): Promise<number> {
    if (typeof result === 'number' && Number.isFinite(result)) return result
    if (typeof result === 'object' && result !== null) {
      const revision = (result as { revision?: unknown }).revision
      if (typeof revision === 'number' && Number.isFinite(revision)) return revision
    }
    const snap = await this.host.holdingsStore?.snapshot()
    return snap?.revision ?? 0
  }

  #requireHoldingsStore(): HoldingsStoreLike {
    const store = this.host.holdingsStore
    if (store === undefined) {
      throw Object.assign(new Error('holdings store is not mounted'), { code: 'TRADING_HOLDINGS_UNAVAILABLE' })
    }
    return store
  }

  /** staged 待确认区入库（Agent 截图解析唯一写入口）。 */
  async stageHoldings(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    const items = typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: unknown[] }).items
      : undefined
    if (items === undefined) return holdingsRejected('stage: body.items must be an array')
    if (items.length === 0) return holdingsRejected('stage: items is empty')
    if (items.length > MAX_HOLDINGS_STAGE_ITEMS) {
      return holdingsRejected(`stage: too many items (${items.length} > ${MAX_HOLDINGS_STAGE_ITEMS})`)
    }
    const parsed: NewHoldingInput[] = []
    for (const item of items) {
      const result = parseNewHolding(item)
      if ('ok' in result) return result
      parsed.push(result)
    }
    const store = this.#requireHoldingsStore()
    const result = await store.stage(parsed)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 确认 staged 入账（可带逐条编辑）。 */
  async confirmHoldings(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    if (typeof body !== 'object' || body === null) return holdingsRejected('confirm: body must be an object')
    const raw = body as { ids?: unknown; edits?: unknown }
    const ids = Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === 'string' && id !== '') : []
    if (ids.length === 0) return holdingsRejected('confirm: ids must be a non-empty string array')
    let edits: Record<string, Partial<NewHolding>> | undefined
    if (raw.edits !== undefined) {
      if (typeof raw.edits !== 'object' || raw.edits === null) return holdingsRejected('confirm: edits must be an object')
      edits = {}
      for (const [id, patchBody] of Object.entries(raw.edits as Record<string, unknown>)) {
        if (typeof patchBody !== 'object' || patchBody === null) return holdingsRejected(`confirm: edits[${id}] must be an object`)
        const patch = parseHoldingPatch(patchBody as Record<string, unknown>)
        if ('ok' in patch) return patch
        edits[id] = patch
      }
    }
    const store = this.#requireHoldingsStore()
    const result = edits === undefined ? await store.confirm(ids) : await store.confirm(ids, edits)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 丢弃 staged 条目。 */
  async discardHoldings(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    if (typeof body !== 'object' || body === null) return holdingsRejected('discard: body must be an object')
    const ids = Array.isArray((body as { ids?: unknown }).ids)
      ? (body as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    if (ids.length === 0) return holdingsRejected('discard: ids must be a non-empty string array')
    const store = this.#requireHoldingsStore()
    const result = await store.discard(ids)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 手动新增一条导入持仓（直入正式区）。 */
  async addHolding(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    const parsed = parseNewHolding(body)
    if ('ok' in parsed) return parsed
    const store = this.#requireHoldingsStore()
    const result = await store.add(parsed)
    // add 返回形状契约未刊：对象带 id 则取之；否则回退快照末位（本地单写者语义）。
    let id = typeof result === 'object' && result !== null ? (result as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || id === '') {
      const snap = await store.snapshot()
      id = snap.holdings[snap.holdings.length - 1]?.id
    }
    if (typeof id !== 'string' || id === '') {
      throw Object.assign(new Error('holdings store add() did not yield an id'), { code: 'TRADING_UNKNOWN' })
    }
    return { ok: true, revision: await this.#holdingsRevision(result), id }
  }

  /** 编辑一条导入持仓。 */
  async updateHolding(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    if (typeof body !== 'object' || body === null) return holdingsRejected('update: body must be an object')
    const raw = body as { id?: unknown; patch?: unknown }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') return holdingsRejected('update: id is required')
    if (typeof raw.patch !== 'object' || raw.patch === null) return holdingsRejected('update: patch must be an object')
    const patch = parseHoldingPatch(raw.patch as Record<string, unknown>)
    if ('ok' in patch) return patch
    const store = this.#requireHoldingsStore()
    const result = await store.update(id, patch)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 删除一条导入持仓。 */
  async removeHolding(id: string): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    const trimmed = id.trim()
    if (trimmed === '') return holdingsRejected('remove: id is required')
    const store = this.#requireHoldingsStore()
    const result = await store.remove(trimmed)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** FX 汇率快照（契约 §3/§4；host.fetchFxRates 缺席 → 桥内兜底 fetcher）。 */
  async fx(base: string): Promise<FxRatesSnapshot & { ok: true }> {
    const normalized = base.trim().toUpperCase()
    if (!FX_BASES.includes(normalized)) {
      throw new BridgeProtocolError(400, `fx: unsupported base ${JSON.stringify(base)} (supported: ${FX_BASES.join('/')})`)
    }
    const fetcher = this.host.fetchFxRates ?? this.#fallbackFxFetcher
    const snap = await fetcher(normalized)
    return { ok: true, base: snap.base, rates: snap.rates, asOf: snap.asOf, stale: snap.stale }
  }

  /**
   * 标的新闻与公告聚合（issue #37）：按市场从 newsRegistry 解析到 Kit 注册的
   * 聚合器；未注册时回退到各 Kit 导出的 aggregateNews 纯函数（无活跃会话时亦可用）。
   * 只返回与标的相关的条目（2026-09-03 owner 裁决）：无相关新闻/公告就返回空列表，
   * 不再回退展示大盘要闻——此前的智能回退会把已抓到的公告挤出 limit 截尾窗。
   */
  async news(market: string, symbol: string | null, rawLimit: string | null): Promise<NewsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const aggregator = this.host.newsRegistry?.get(market)
      ?? (market === 'cn' ? aggregateCnNews : undefined)

    if (aggregator === undefined) {
      throw Object.assign(
        new Error(`market ${market} does not have a news provider`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_NEWS_LIMIT)) {
      throw new BridgeProtocolError(400, `news: limit must be an integer in 1..${MAX_NEWS_LIMIT}`)
    }
    const result = await aggregator({
      symbol: symbol ?? undefined,
      limit: limit ?? 20,
      windowHours: 24,
    })

    return { ok: true, items: result.items, unavailable: result.unavailable }
  }

  /** 自定义策略名册（issue #31）：返回记录（含内置覆盖记录），前端校验后并入名册。 */
  async customStrategies(): Promise<{ ok: boolean; strategies: CustomStrategyRecord[] }> {
    const store = this.host.strategyStore
    if (store === undefined) return { ok: true, strategies: [] }
    const strategies = await store.list()
    return { ok: true, strategies }
  }

  /**
   * 删除策略（策略管理）：自定义 = 移除记录；内置范式 = 落墓碑（出厂代码不动，
   * POST /strategies/reset 可恢复），顺带丢弃该内置的覆盖记录。
   */
  async deleteCustomStrategy(rawId: string): Promise<{ ok: boolean; removed: boolean; scope: 'custom' | 'builtin' }> {
    // 与 PUT 同款归一化（PUT 在 isBuiltinStrategyId 前先 trim+lowercase，两侧对称）。
    const id = rawId.trim().toLowerCase()
    if (isBuiltinStrategyId(id)) {
      await this.host.tombstonesStore?.add(id)
      // 内置删除丢弃覆盖记录：归档后可找回（出厂代码由墓碑/恢复语义保证）。
      await this.host.strategyStore?.remove(id, true)
      return { ok: true, removed: true, scope: 'builtin' }
    }
    const store = this.host.strategyStore
    if (store === undefined) return { ok: true, removed: false, scope: 'custom' }
    const removed = await store.remove(id)
    return { ok: true, removed, scope: 'custom' }
  }

  /**
   * 保存自定义策略（策略管理，PUT /strategies/custom）：桥侧 vm 沙箱全量校验
   * （结构/语法/多场景试算/信号序列）通过才落盘。同 id 既有自定义记录即 upsert
   * 覆盖；id 命中内置范式 = 覆盖内置，必须显式带 overridesBuiltin 确认位
   * （防 GUI 误覆盖），成功时顺带清除该 id 的删除墓碑。
   */
  async saveCustomStrategy(body: unknown): Promise<
    | { ok: true; strategy: CustomStrategyRecord; overridesBuiltin: boolean }
    | { ok: false; code: string; message: string }
  > {
    const store = this.host.strategyStore
    if (store === undefined) {
      return { ok: false, code: 'TRADING_STRATEGY_UNAVAILABLE', message: 'strategy store is not mounted' }
    }
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
    const overridesBuiltin = isBuiltinStrategyId(id)
    if (overridesBuiltin && input.overridesBuiltin !== true) {
      return {
        ok: false,
        code: 'TRADING_STRATEGY_OVERRIDE_CONFIRM',
        message: `id "${id}" is a built-in paradigm strategy — pass overridesBuiltin:true to confirm overriding it`,
      }
    }
    const result = await validateCustomStrategyNode(input)
    if (!result.ok) {
      return { ok: false, code: 'TRADING_STRATEGY_INVALID', message: result.reason }
    }
    if (overridesBuiltin) {
      await this.host.tombstonesStore?.remove(id)
      // 上一次覆盖记录将被本次 save 顶掉：先归档删除再落盘，旧修改可找回。
      const previousOverride = await store.get(id)
      if (previousOverride !== undefined) await store.remove(id, true)
    }
    await store.save(result.record)
    return { ok: true, strategy: result.record, overridesBuiltin }
  }

  /** 内置删除墓碑清单（策略管理；GUI 据此展示灰卡与恢复入口）。 */
  async builtinTombstones(): Promise<{ ok: boolean; deleted: string[] }> {
    const deleted = await this.host.tombstonesStore?.list() ?? []
    return { ok: true, deleted }
  }

  /**
   * 恢复内置策略出厂默认（策略管理，POST /strategies/reset）：清覆盖记录与墓碑。
   * 自定义策略无出厂版本 → 业务拒绝。
   */
  async resetStrategy(id: string): Promise<
    | { ok: true; reset: true; changed: boolean; removedOverride: boolean; liftedTombstone: boolean }
    | { ok: false; code: string; message: string }
  > {
    if (!isBuiltinStrategyId(id)) {
      return { ok: false, code: 'TRADING_STRATEGY_NOT_BUILTIN', message: `"${id}" is not a built-in paradigm strategy id` }
    }
    // 恢复出厂丢弃覆盖记录：归档后可找回。
    const removedOverride = await this.host.strategyStore?.remove(id, true) ?? false
    const liftedTombstone = await this.host.tombstonesStore?.remove(id) ?? false
    return { ok: true, reset: true, changed: removedOverride || liftedTombstone, removedOverride, liftedTombstone }
  }

  /** 自定义选股器名册（选股器管理）：返回记录（含内置覆盖记录），前端校验后并入名册。 */
  async customScreeners(): Promise<{ ok: boolean; screeners: CustomScreenerRecord[] }> {
    const store = this.host.screenerStore
    if (store === undefined) return { ok: true, screeners: [] }
    const screeners = await store.list()
    return { ok: true, screeners }
  }

  /**
   * 保存自定义选股器（选股器管理，PUT /strategies/screeners）：桥侧 vm 沙箱全量
   * 校验（结构/语法/多场景试算/ScreenerMatch 形状）通过才落盘。id 命中内置选股器
   * = 覆盖内置，必须显式带 overridesScreener 确认位，成功时顺带清除删除墓碑。
   */
  async saveCustomScreener(body: unknown): Promise<
    | { ok: true; screener: CustomScreenerRecord; overridesScreener: boolean }
    | { ok: false; code: string; message: string }
  > {
    const store = this.host.screenerStore
    if (store === undefined) {
      return { ok: false, code: 'TRADING_SCREENER_UNAVAILABLE', message: 'screener store is not mounted' }
    }
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
    const overridesScreener = isBuiltinScreenerId(id)
    if (overridesScreener && input.overridesScreener !== true) {
      return {
        ok: false,
        code: 'TRADING_SCREENER_OVERRIDE_CONFIRM',
        message: `id "${id}" is a built-in screener — pass overridesScreener:true to confirm overriding it`,
      }
    }
    const result = await validateCustomScreenerNode(input)
    if (!result.ok) {
      return { ok: false, code: 'TRADING_SCREENER_INVALID', message: result.reason }
    }
    if (overridesScreener) {
      await this.host.tombstonesStore?.remove(id)
      // 上一次覆盖记录将被本次 save 顶掉：先归档删除再落盘，旧修改可找回。
      const previousOverride = await store.get(id)
      if (previousOverride !== undefined) await store.remove(id, true)
    }
    await store.save(result.record)
    return { ok: true, screener: result.record, overridesScreener }
  }

  /**
   * 删除选股器（选股器管理）：自定义 = 移除记录；内置 = 落墓碑（恢复出厂走
   * POST /strategies/screeners/reset），顺带丢弃该内置的覆盖记录。
   */
  async deleteCustomScreener(rawId: string): Promise<{ ok: boolean; removed: boolean; scope: 'custom' | 'builtin' }> {
    // 与 PUT 同款归一化（与 deleteCustomStrategy 对称）。
    const id = rawId.trim().toLowerCase()
    if (isBuiltinScreenerId(id)) {
      await this.host.tombstonesStore?.add(id)
      // 内置删除丢弃覆盖记录：归档后可找回。
      await this.host.screenerStore?.remove(id, true)
      return { ok: true, removed: true, scope: 'builtin' }
    }
    const store = this.host.screenerStore
    if (store === undefined) return { ok: true, removed: false, scope: 'custom' }
    const removed = await store.remove(id)
    return { ok: true, removed, scope: 'custom' }
  }

  /** 恢复内置选股器出厂默认（选股器管理）：清覆盖记录与墓碑；自定义 → 业务拒绝。 */
  async resetScreener(id: string): Promise<
    | { ok: true; reset: true; changed: boolean; removedOverride: boolean; liftedTombstone: boolean }
    | { ok: false; code: string; message: string }
  > {
    if (!isBuiltinScreenerId(id)) {
      return { ok: false, code: 'TRADING_SCREENER_NOT_BUILTIN', message: `"${id}" is not a built-in screener id` }
    }
    // 恢复出厂丢弃覆盖记录：归档后可找回。
    const removedOverride = await this.host.screenerStore?.remove(id, true) ?? false
    const liftedTombstone = await this.host.tombstonesStore?.remove(id) ?? false
    return { ok: true, reset: true, changed: removedOverride || liftedTombstone, removedOverride, liftedTombstone }
  }

  /**
   * 标的基本面快照与多期财务矩阵（GUI「基本面」页签，2026-09-02 / Issue #36）。
   *
   * 语义（重构自协作者初版，2026-09-02 审查整改）：
   * - 数据包（kit 的多期报表/股东/分红等下钻）直接按市场取，不要求连接器实现
   *   getFundamentals——us/crypto 由此可达；快照部分为可选增强（连接器实现了才合并）。
   * - 快照与数据包并行取（Promise.all）；任一失败只降级自己那半，另一半照常返回。
   * - 两个都失败 → TRADING_NOT_IMPLEMENTED 业务错误（HTTP 200 + ok:false），
   *   前端显示诚实空态；不再有「半旧数据冒充新标的」的路径。
   * - 5 分钟进程内 TTL 缓存（财报级数据，非 tick）+ 同键 in-flight 去重，
   *   对齐本桥 symbols() 的缓存先例；一次 tab 翻转只打一轮上游。
   */
  async fundamentals(market: string, symbol: string): Promise<FundamentalsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'fundamentals: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)

    const cacheKey = `${market}:${trimmed}`
    const cached = this.fundamentalsCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.fetchedAt < FUNDAMENTALS_CACHE_TTL_MS) {
      return { ok: true, fundamentals: cached.pkg }
    }
    const inflight = this.fundamentalsInflight.get(cacheKey)
    if (inflight !== undefined) return { ok: true, fundamentals: await inflight }

    const job = (async (): Promise<StockFundamentals> => {
      const [snapshot, pkg] = await Promise.all([
        typeof service.getFundamentals === 'function'
          ? service.getFundamentals(trimmed).catch(() => undefined)
          : Promise.resolve(undefined),
        this.#fetchPkg(market, trimmed),
      ])
      if (snapshot === undefined && pkg === undefined) {
        throw Object.assign(
          new Error(`no fundamentals data for ${market}/${trimmed} — provider and drill-down both unavailable`),
          { code: 'TRADING_NOT_IMPLEMENTED' },
        )
      }
      // 合并语义：pkg 是骨架（含 market/symbol），snapshot 只增强 stock 字段；
      // 只有快照没有 pkg 时，快照自身就是返回值（含 timestamp，满足契约必填）。
      const result: StockFundamentals = pkg !== undefined
        ? ({
            ...pkg,
            stock: { ...(pkg.stock ?? {}), ...(snapshot ?? {}) },
            timestamp: snapshot?.timestamp ?? Date.now(),
          } as unknown as StockFundamentals)
        : snapshot as StockFundamentals
      this.fundamentalsCache.set(cacheKey, { pkg: result, fetchedAt: Date.now() })
      return result
    })()

    this.fundamentalsInflight.set(cacheKey, job)
    try {
      const result = await job
      return { ok: true, fundamentals: result }
    } finally {
      this.fundamentalsInflight.delete(cacheKey)
    }
  }

  /** 按市场拉 kit 基本面数据包；kit 未覆盖或上游失败 → undefined（不算错误）。 */
  async #fetchPkg(market: MarketId, symbol: string): Promise<FundamentalsPackage | undefined> {
    try {
      const pkg = market === 'cn' ? await fetchCnFundamentalsPackage(symbol) : undefined
      // 骨架包（全部上游失败时 kit 仍返回 market/symbol + 空数组）不算数据：
      // 只有携带实质下钻（matrix/stock/profile 详情/股东等任一）才压过快照，
      // 否则快照字段会被空骨架挤到 stock 子对象里丢掉顶层估值字段。
      if (pkg === undefined) return undefined
      const hasSubstance = pkg.matrix !== undefined
        || pkg.stock !== undefined
        || pkg.profile?.description !== undefined
        || pkg.profile?.industry !== undefined
        || (pkg.shareholders?.length ?? 0) > 0
        || (pkg.reports?.length ?? 0) > 0
        || (pkg.mainOperations?.length ?? 0) > 0
        || (pkg.dividends?.length ?? 0) > 0
        || pkg.forecast !== undefined
        || pkg.holderSummary !== undefined
        || pkg.efficiency !== undefined
        || (pkg.insiderTrades?.length ?? 0) > 0
        || (pkg.institutionalHoldings?.length ?? 0) > 0
        || (pkg.dividends?.length ?? 0) > 0
        || (pkg.splits?.length ?? 0) > 0
      return hasSubstance ? pkg : undefined
    } catch {
      // 下钻失败不阻断快照：调用方以 snapshot 兜底
    }
    return undefined
  }

  /* ---------------------------------------------------------------- */
  /* 自选股 + 选中（issue #32 / P3）：host store 为 SSOT，localStorage 降级镜像 */
  /* ---------------------------------------------------------------- */

  /** 全量读取自选行（不含客户端种子回退）。 */
  async watchlistRows(): Promise<{ ok: boolean; watchlists: WatchlistsMap }> {
    const store = this.host.watchlistStore
    if (store === undefined) return { ok: true, watchlists: {} }
    return { ok: true, watchlists: await store.list() }
  }

  /** 全量替换自选（客户端启动同步）。 */
  async replaceWatchlists(body: unknown): Promise<{ ok: boolean; watchlists: WatchlistsMap }> {
    const store = this.host.watchlistStore
    if (store === undefined) return { ok: true, watchlists: {} }
    const map = parseWatchlistsMap(body)
    await store.save(map)
    return { ok: true, watchlists: await store.list() }
  }

  /** 追加一行（POST /watchlists）。 */
  async addWatchlistRow(body: unknown): Promise<{ ok: boolean; added: boolean; instrument: WatchlistInstrument }> {
    const store = this.host.watchlistStore
    if (store === undefined) {
      const instrument = parseInstrumentBody(body)
      return { ok: true, added: false, instrument }
    }
    const instrument = parseInstrumentBody(body)
    const added = await store.add(instrument.market, instrument)
    return { ok: true, added, instrument }
  }

  /** 移除一行（DELETE /watchlists?market&symbol）。 */
  async removeWatchlistRow(market: string, symbol: string): Promise<{ ok: boolean; removed: boolean }> {
    const store = this.host.watchlistStore
    if (store === undefined || !market || !symbol) return { ok: true, removed: false }
    const removed = await store.remove(market, symbol)
    return { ok: true, removed }
  }

  /**
   * 一次性迁移导入（POST /watchlists/import）：host 非空拒绝（幂等，防重复导入）。
   */
  async importWatchlists(body: unknown): Promise<{ ok: boolean; imported: boolean; reason?: string }> {
    const store = this.host.watchlistStore
    if (store === undefined) return { ok: false, imported: false, reason: 'watchlist store is not mounted' }
    const existing = await store.list()
    if (Object.keys(existing).length > 0) {
      return { ok: false, imported: false, reason: 'host watchlist store is not empty — migration already done (idempotent guard)' }
    }
    const map = parseWatchlistsMap(body)
    await store.save(map)
    return { ok: true, imported: true }
  }

  /* ---------------------------------------------------------------- */
  /* 图表激活名册（issue #63）：host store 为 SSOT，localStorage 降级镜像  */
  /* ---------------------------------------------------------------- */

  /** 全量读取激活名册（GET /chart/indicators）。 */
  async chartActivations(): Promise<ChartActivationsWire> {
    const store = this.host.chartActivationsStore
    if (store === undefined) return { ok: true, instances: [] }
    return { ok: true, instances: await store.list() }
  }

  /**
   * 挂载/更新一个激活实例（PUT /chart/indicators，body { id, params?, market?, symbol?, clearSymbol?, visible? }）：
   * id 必须能解析为预置或自定义指标（未知 id 业务拒绝——与 GUI 可渲染集合同源）；
   * params 按 schema clamp，缺失键取 schema 默认值。
   * issue #72：body 同时带 market+symbol 时写入该标的的参数覆盖（symbolParams[
   * `${market}:${symbol}`]），clearSymbol:true 改为删除该覆盖；不带 scope 时写
   * 全局 params。两种写法都保留实例上已有的其他覆盖。market/symbol 只给其一是
   * 业务拒绝（TRADING_INVALID_SCOPE）；clearSymbol 对未挂载 id 是无操作不建实例。
   * symbol visibility：body 带 visible:boolean 时为可见性写——仅 market 即整市场
   * 隐藏/显示，market+symbol 为单标的；实例缺席为幂等 no-op 不反向创建；visible
   * 优先于 params/clearSymbol（同请求带 params 时被忽略）。
   */
  async putChartActivation(body: unknown): Promise<ChartActivationsWire | ChartActivationRejectedWire> {
    const store = this.host.chartActivationsStore
    const raw = (body ?? {}) as { id?: unknown; params?: unknown; market?: unknown; symbol?: unknown; clearSymbol?: unknown; visible?: unknown }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id) throw new BridgeProtocolError(400, 'chart activation body requires string id')
    const spec = await resolveIndicatorSpec(id, this.host.customIndicatorsStore)
    if (spec === undefined) {
      return {
        ok: false,
        code: 'TRADING_UNKNOWN_INDICATOR',
        message: 'unknown indicator id ' + JSON.stringify(id) + ' — presets and authored custom ids only (see indicator_list)',
      }
    }
    const overrides: Record<string, number> = {}
    if (typeof raw.params === 'object' && raw.params !== null && !Array.isArray(raw.params)) {
      for (const [key, value] of Object.entries(raw.params as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value
      }
    }
    const params = clampActivationParams(spec.params, overrides)
    const market = typeof raw.market === 'string' ? raw.market.trim() : ''
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
    const hasVisible = typeof raw.visible === 'boolean'
    const scope = market !== '' && symbol !== '' ? symbolScopeKey(market, symbol) : undefined
    if (scope === undefined && !hasVisible && (market !== '' || symbol !== '')) {
      // 与 indicator_activate 工具同规则：params 覆盖只收成对 market+symbol，
      // 半参业务拒绝而非静默落全局（全局写影响所有标的）。可见性写例外：仅
      // market 合法（整市场隐藏/显示）。
      return {
        ok: false,
        code: 'TRADING_INVALID_SCOPE',
        message: 'market and symbol must be supplied together (or neither) — got market='
          + JSON.stringify(market) + ', symbol=' + JSON.stringify(symbol),
      }
    }
    const existing = store !== undefined ? (await store.list()).find(instance => instance.id === id) : undefined

    if (hasVisible) {
      // 可见性写：实例缺席为幂等 no-op（隐藏未挂载指标无意义，不反向创建）。
      if (market === '') {
        return { ok: false, code: 'TRADING_INVALID_SCOPE', message: 'visibility write requires market (optionally symbol)' }
      }
      if (existing === undefined) {
        return { ok: true, instances: store !== undefined ? await store.list() : [] }
      }
      const hideScope = symbol !== '' ? symbolScopeKey(market, symbol) : market
      const next = withHiddenScopes(existing, hideScope, raw.visible === true)
      // existing 来自 store.list()，存在即 store 已定义；此处守卫只为类型窄化。
      if (store !== undefined && next !== existing) await store.activate(next)
      return { ok: true, instances: store !== undefined ? await store.list() : [next] }
    }

    let instance: IndicatorInstance
    if (scope !== undefined) {
      // 清除不存在的覆盖是无操作：不反向创建激活实例。
      if (raw.clearSymbol === true && existing === undefined) {
        return { ok: true, instances: store !== undefined ? await store.list() : [] }
      }
      // 新实例的全局 params 取 schema 默认值——首个标的的覆盖不得泄漏成全局值。
      const base: IndicatorInstance = existing ?? { id, params: clampActivationParams(spec.params, {}) }
      const symbolParams: Record<string, Record<string, number>> = { ...(base.symbolParams ?? {}) }
      if (raw.clearSymbol === true) delete symbolParams[scope]
      else symbolParams[scope] = params
      instance = Object.keys(symbolParams).length > 0
        ? { id, params: base.params, symbolParams }
        : { id, params: base.params }
    } else {
      instance = existing?.symbolParams !== undefined
        ? { id, params, symbolParams: existing.symbolParams }
        : { id, params }
    }
    if (store !== undefined) await store.activate(instance)
    return { ok: true, instances: store !== undefined ? await store.list() : [instance] }
  }

  /** 摘除一个激活实例（DELETE /chart/indicators?id=）。 */
  async removeChartActivation(id: string): Promise<{ ok: boolean; removed: boolean; instances: IndicatorInstance[] }> {
    const store = this.host.chartActivationsStore
    if (store === undefined) return { ok: true, removed: false, instances: [] }
    const removed = await store.deactivate(id)
    return { ok: true, removed, instances: await store.list() }
  }

  /**
   * 一次性迁移导入（POST /chart/indicators/import）：host 非空拒绝（幂等，防重复导入）。
   * 客户端把 localStorage 存量激活名册搬进 host SSOT（issue #32 watchlist 同款）。
   */
  async importChartActivations(body: unknown): Promise<{ ok: boolean; imported: boolean; reason?: string }> {
    const store = this.host.chartActivationsStore
    if (store === undefined) return { ok: false, imported: false, reason: 'chart activation store is not mounted' }
    const existing = await store.list()
    if (existing.length > 0) {
      return { ok: false, imported: false, reason: 'host chart activation store is not empty — migration already done (idempotent guard)' }
    }
    const instances = parseChartInstances(body)
    await store.replaceAll(instances)
    return { ok: true, imported: true }
  }

  /** 读取选中标的（GET /selection）。 */
  async selection(): Promise<{ ok: boolean; instrument: WatchlistInstrument | null }> {
    const store = this.host.selectionStore
    if (store === undefined) return { ok: true, instrument: null }
    const record = await store.get()
    return { ok: true, instrument: record.instrument }
  }

  /** 设置选中标的（PUT /selection；watchlist_select 工具与左栏点击同源）。 */
  async putSelection(body: unknown): Promise<{ ok: boolean; instrument: WatchlistInstrument | null }> {
    const store = this.host.selectionStore
    const parsed = body as { instrument?: WatchlistInstrument | null } | undefined
    const instrument = parsed?.instrument === undefined || parsed.instrument === null
      ? null
      : {
        market: String(parsed.instrument.market ?? ''),
        symbol: String(parsed.instrument.symbol ?? ''),
        ...(parsed.instrument.name !== undefined ? { name: String(parsed.instrument.name) } : {}),
      }
    if (store === undefined) return { ok: true, instrument }
    await store.set({ instrument })
    return { ok: true, instrument }
  }
}

/** 查询串可选数字：undefined/空串 → undefined；非有限数 → 400。 */
function parseOptionalFinite(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new BridgeProtocolError(400, `options arbitrage: ${field} must be a finite number (got ${raw})`)
  }
  return value
}

/** 自选 map 的形状校验（Record<market, Instrument[]>，宽容 name 缺省）。 */
function parseWatchlistsMap(body: unknown): WatchlistsMap {
  if (typeof body !== 'object' || body === null) {
    throw new BridgeProtocolError(400, 'watchlists body must be an object')
  }
  const raw = (body as { watchlists?: unknown }).watchlists ?? body
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BridgeProtocolError(400, 'watchlists must be an object keyed by market')
  }
  const out: WatchlistsMap = {}
  for (const [market, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    out[market] = rows.map((row) => {
      const r = row as { market?: unknown; symbol?: unknown; name?: unknown }
      if (typeof r?.symbol !== 'string' || !r.symbol) {
        throw new BridgeProtocolError(400, `watchlists[${market}] rows must have string symbol`)
      }
      return {
        market: typeof r.market === 'string' ? r.market : market,
        symbol: r.symbol,
        ...(typeof r.name === 'string' && r.name ? { name: r.name } : {}),
      }
    })
  }
  return out
}

/** 单行 instrument 的形状校验。 */
function parseInstrumentBody(body: unknown): WatchlistInstrument {
  const raw = (body ?? {}) as { market?: unknown; symbol?: unknown; name?: unknown }
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (!market || !symbol) {
    throw new BridgeProtocolError(400, 'instrument body requires string market and symbol')
  }
  return {
    market,
    symbol,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
  }
}

/**
 * 激活名册迁移导入的形状校验（{ instances: [...] } 或裸数组）：坏形行丢弃、
 * params 只收有限数字（host 侧参数 clamp 在 put 语义里，迁移保真原样搬运）。
 */
function parseChartInstances(body: unknown): IndicatorInstance[] {
  const raw = typeof body === 'object' && body !== null && Array.isArray((body as { instances?: unknown }).instances)
    ? (body as { instances: unknown[] }).instances
    : Array.isArray(body)
      ? body
      : []
  const out: IndicatorInstance[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as { id?: unknown }).id
    const params = (item as { params?: unknown }).params
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof params !== 'object' || params === null) continue
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value
    }
    // 行保留语义不变（脏值清洗成空 params），symbolParams/hiddenScopes 经 sanitizeInstance 保真（issue #72 / symbol visibility）。
    const normalized = sanitizeInstance({
      id,
      params: clean,
      symbolParams: (item as { symbolParams?: unknown }).symbolParams,
      hiddenScopes: (item as { hiddenScopes?: unknown }).hiddenScopes,
    })
    if (normalized !== undefined) out.push(normalized)
  }
  return out
}

/** 请求分发：把 (method, pathname, searchParams) 路由到桥方法，返回 (status, payload)。 */
export async function dispatchBridgeRequest(
  bridge: TradingBridge,
  method: string,
  pathname: string,
  search: URLSearchParams,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  if (method === 'GET') {
    switch (pathname) {
      case '/markets':
        return { status: 200, payload: bridge.markets() }
      case '/tickers': {
        const market = search.get('market') ?? ''
        const symbols = (search.get('symbols') ?? '').split(',')
        return { status: 200, payload: await bridge.tickers(market, symbols) }
      }
      case '/klines': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        const interval = search.get('interval') ?? '1d'
        const limit = search.get('limit')
        return { status: 200, payload: await bridge.klines(market, symbol, interval, limit) }
      }
      case '/symbols': {
        const market = search.get('market') ?? ''
        const query = search.get('query') ?? undefined
        return { status: 200, payload: await bridge.symbols(market, query) }
      }
      case '/fundamentals': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.fundamentals(market, symbol) }
      }
      case '/options/underlyings': {
        return { status: 200, payload: await bridge.optionUnderlyings(search.get('source') ?? undefined) }
      }
      case '/options/resolve': {
        return { status: 200, payload: await bridge.optionResolve(search.get('symbol') ?? '') }
      }
      case '/options/expiries': {
        return {
          status: 200,
          payload: await bridge.optionExpiries(
            search.get('underlying') ?? '',
            search.get('source') ?? undefined,
          ),
        }
      }
      case '/options/chain': {
        return {
          status: 200,
          payload: await bridge.optionChain(
            search.get('underlying') ?? '',
            search.get('expiryMonth') ?? '',
            search.get('source') ?? undefined,
          ),
        }
      }
      case '/options/arbitrage': {
        return {
          status: 200,
          payload: await bridge.optionArbitrage(
            search.get('underlying') ?? '',
            search.get('expiryMonth') ?? '',
            search.get('source') ?? undefined,
            search.get('threshold') ?? undefined,
            search.get('fee') ?? undefined,
            search.get('verticals') ?? undefined,
          ),
        }
      }
      case '/options/implied-vol': {
        return {
          status: 200,
          payload: await bridge.optionImpliedVol(
            search.get('underlying') ?? '',
            search.get('expiryMonth') ?? '',
            search.get('rate') ?? '',
            search.get('source') ?? undefined,
            search.get('priceField') ?? undefined,
          ),
        }
      }
      case '/options/vol-analytics': {
        return {
          status: 200,
          payload: await bridge.optionVolAnalytics(
            search.get('underlying') ?? '',
            search.get('expiryMonths'),
            search.get('asOf'),
            search.get('rate'),
            search.get('dividendYield'),
            search.get('source') ?? undefined,
          ),
        }
      }
      case '/options/positions': {
        return { status: 200, payload: await bridge.optionPositions() }
      }
      case '/options/paper/account': {
        return { status: 200, payload: await bridge.optionPaperAccount(search.get('book') ?? undefined) }
      }
      case '/options/paper/accounts': {
        return { status: 200, payload: await bridge.optionPaperAccounts() }
      }
      case '/options/paper/fills': {
        return {
          status: 200,
          payload: await bridge.optionPaperFills(
            search.get('limit') ?? undefined,
            search.get('book') ?? undefined,
          ),
        }
      }
      case '/options/paper/desk': {
        return { status: 200, payload: await bridge.optionPaperDesk(search.get('days') ?? undefined) }
      }
      case '/options/overview': {
        return {
          status: 200,
          payload: await bridge.optionOverview(
            search.get('source') ?? undefined,
            search.get('sort') ?? undefined,
            search.get('includeIv') ?? undefined,
          ),
        }
      }
      case '/options/intraday-box': {
        return {
          status: 200,
          payload: await bridge.optionIntradayBox(
            search.get('underlying') ?? undefined,
            search.get('horizon') ?? undefined,
            search.get('asOf') ?? undefined,
          ),
        }
      }
      case '/options/cycles': {
        return {
          status: 200,
          payload: bridge.optionCycles(
            search.get('underlying') ?? undefined,
            search.get('limit') ?? undefined,
          ),
        }
      }
      case '/options/cycles/loop': {
        return { status: 200, payload: await bridge.optionCycleLoop() }
      }
      case '/options/bar-packet': {
        return { status: 200, payload: await bridge.optionBarPacket() }
      }
      case '/options/predictions': {
        return {
          status: 200,
          payload: await bridge.optionPredictions(
            search.get('underlying') ?? undefined,
            search.get('asOf') ?? undefined,
          ),
        }
      }
      case '/options/predictions/track': {
        return {
          status: 200,
          payload: await bridge.optionPredictionTrack(
            search.get('underlying') ?? undefined,
            search.get('limit') ?? undefined,
          ),
        }
      }
      case '/options/predictions/knowledge': {
        return {
          status: 200,
          payload: await bridge.optionPredictionKnowledge(search.get('underlying') ?? undefined),
        }
      }
      case '/orderbook': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.orderbook(market, symbol) }
      }
      case '/trades': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.trades(market, symbol, search.get('limit')) }
      }
      case '/trade/positions': {
        return { status: 200, payload: await bridge.positions(search.get('market') ?? '') }
      }
      case '/trade/balances': {
        return { status: 200, payload: await bridge.balances(search.get('market') ?? '') }
      }
      case '/trade/orders': {
        return { status: 200, payload: await bridge.openOrders(search.get('market') ?? '') }
      }
      case '/trade/fills': {
        return { status: 200, payload: await bridge.tradeFills(search.get('market') ?? '') }
      }
      case '/indicators/custom': {
        return { status: 200, payload: await bridge.customIndicators() }
      }
      case '/chart/indicators': {
        return { status: 200, payload: await bridge.chartActivations() }
      }
      case '/knowledge/cards': {
        return { status: 200, payload: await bridge.knowledgeCards() }
      }
      case '/holdings': {
        return { status: 200, payload: await bridge.holdings() }
      }
      case '/fx': {
        // base 缺省 USD；非法 base → 400 协议错误（契约 §4）。
        return { status: 200, payload: await bridge.fx(search.get('base') ?? 'USD') }
      }
      case '/news': {
        const market = search.get('market') ?? ''
        if (!market) throw new BridgeProtocolError(400, 'news: market is required')
        return { status: 200, payload: await bridge.news(market, search.get('symbol'), search.get('limit')) }
      }
      case '/strategies/custom': {
        return { status: 200, payload: await bridge.customStrategies() }
      }
      case '/strategies/tombstones': {
        return { status: 200, payload: await bridge.builtinTombstones() }
      }
      case '/strategies/screeners': {
        return { status: 200, payload: await bridge.customScreeners() }
      }
      case '/watchlists': {
        return { status: 200, payload: await bridge.watchlistRows() }
      }
      case '/selection': {
        return { status: 200, payload: await bridge.selection() }
      }
      default:
        throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
    }
  }

  if (method === 'DELETE') {
    if (pathname === '/indicators/custom') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom indicator: id is required')
      return { status: 200, payload: await bridge.deleteCustomIndicator(id) }
    }
    if (pathname === '/chart/indicators') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete chart activation: id is required')
      return { status: 200, payload: await bridge.removeChartActivation(id) }
    }
    if (pathname === '/strategies/custom') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom strategy: id is required')
      return { status: 200, payload: await bridge.deleteCustomStrategy(id) }
    }
    if (pathname === '/strategies/screeners') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete screener: id is required')
      return { status: 200, payload: await bridge.deleteCustomScreener(id) }
    }
    if (pathname === '/trade/order') {
      const market = search.get('market') ?? ''
      const orderId = search.get('id') ?? search.get('orderId') ?? ''
      const symbol = search.get('symbol') ?? undefined
      if (!market) throw new BridgeProtocolError(400, 'cancel order: market is required')
      if (!orderId) throw new BridgeProtocolError(400, 'cancel order: id is required')
      return { status: 200, payload: await bridge.cancelOrderFromGui(market, orderId, symbol) }
    }
    if (pathname === '/options/order') {
      const orderId = search.get('id') ?? search.get('orderId') ?? ''
      const symbol = search.get('symbol') ?? undefined
      if (!orderId) throw new BridgeProtocolError(400, 'options cancel: id is required')
      return { status: 200, payload: await bridge.cancelOptionOrderFromGui(orderId, symbol) }
    }
    if (pathname === '/watchlists') {
      const market = search.get('market') ?? ''
      const symbol = search.get('symbol') ?? ''
      if (!market || !symbol) throw new BridgeProtocolError(400, 'delete watchlist row: market and symbol are required')
      return { status: 200, payload: await bridge.removeWatchlistRow(market, symbol) }
    }
    if (pathname === '/holdings') {
      return { status: 200, payload: await bridge.removeHolding(search.get('id') ?? '') }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  if (method === 'PUT') {
    if (pathname === '/watchlists') {
      return { status: 200, payload: await bridge.replaceWatchlists(body) }
    }
    if (pathname === '/selection') {
      return { status: 200, payload: await bridge.putSelection(body) }
    }
    if (pathname === '/chart/indicators') {
      return { status: 200, payload: await bridge.putChartActivation(body) }
    }
    if (pathname === '/holdings') {
      return { status: 200, payload: await bridge.updateHolding(body) }
    }
    if (pathname === '/strategies/custom') {
      return { status: 200, payload: await bridge.saveCustomStrategy(body) }
    }
    if (pathname === '/strategies/screeners') {
      return { status: 200, payload: await bridge.saveCustomScreener(body) }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  if (method === 'POST') {
    if (pathname === '/trade/order') {
      return { status: 200, payload: await bridge.placeOrderFromGui(search.get('market') ?? '', body as GuiOrderBody) }
    }
    if (pathname === '/strategies/reset') {
      const input = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown }
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!id) throw new BridgeProtocolError(400, 'reset strategy: id is required')
      return { status: 200, payload: await bridge.resetStrategy(id) }
    }
    if (pathname === '/strategies/screeners/reset') {
      const input = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown }
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!id) throw new BridgeProtocolError(400, 'reset screener: id is required')
      return { status: 200, payload: await bridge.resetScreener(id) }
    }
    if (pathname === '/watchlists') {
      return { status: 200, payload: await bridge.addWatchlistRow(body) }
    }
    if (pathname === '/watchlists/import') {
      return { status: 200, payload: await bridge.importWatchlists(body) }
    }
    if (pathname === '/chart/indicators/import') {
      return { status: 200, payload: await bridge.importChartActivations(body) }
    }
    if (pathname === '/holdings') {
      return { status: 200, payload: await bridge.addHolding(body) }
    }
    if (pathname === '/holdings/stage') {
      return { status: 200, payload: await bridge.stageHoldings(body) }
    }
    if (pathname === '/holdings/confirm') {
      return { status: 200, payload: await bridge.confirmHoldings(body) }
    }
    if (pathname === '/holdings/discard') {
      return { status: 200, payload: await bridge.discardHoldings(body) }
    }
    if (pathname === '/options/cycles/tick') {
      const asOf = typeof body === 'object' && body !== null && typeof (body as { asOf?: unknown }).asOf === 'string'
        ? (body as { asOf: string }).asOf
        : undefined
      return { status: 200, payload: await bridge.optionCycleTick(asOf) }
    }
    if (pathname === '/options/paper/reset') {
      const fromBody = typeof body === 'object' && body !== null
        && typeof (body as { book?: unknown }).book === 'string'
        ? (body as { book: string }).book
        : undefined
      return { status: 200, payload: await bridge.resetOptionPaper(search.get('book') ?? fromBody) }
    }
    if (pathname === '/options/strategy') {
      return { status: 200, payload: await bridge.optionStrategy(body) }
    }
    if (pathname === '/options/order') {
      return { status: 200, payload: await bridge.placeOptionOrderFromGui(body as GuiOptionOrderBody) }
    }
    if (pathname === '/options/predictions') {
      return { status: 200, payload: await bridge.createOptionPrediction(body) }
    }
    if (pathname === '/options/predictions/settle') {
      return { status: 200, payload: await bridge.settleOptionPrediction(body) }
    }
    if (pathname === '/options/predictions/settle-auto') {
      return { status: 200, payload: await bridge.autoSettleOptionPredictions(body) }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  throw new BridgeProtocolError(405, 'only GET/PUT/POST/DELETE are supported')
}
