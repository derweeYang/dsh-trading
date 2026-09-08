/**
 * @dshtrading/api — 纯类型契约包。
 *
 * 零运行时、零依赖：服务契约由连接器实现（ctx 键按市场命名空间，如 ctx.tradingCn），
 * 消费方只依赖这里的类型。交易安全闸门（铁律 #3）在类型层面体现为
 * OrderRequest.dryRun 默认 true、错误词汇含 LIVE_TRADING_DISABLED / APPROVAL_DENIED。
 *
 * @module @dshtrading/api
 */

// cordis Context augmentation 的解析锚点：无此 type-only import，TS2664 下 augmentation 整体失效。
import type {} from '@deepseek-ai/cordis'

/** K线周期（与主流行情源 interval 词汇对齐）。 */
export type Interval =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '8h'
  | '12h'
  | '1d'
  | '3d'
  | '1w'
  | '1M'

/** 最新行情快照（公共数据，无需凭证）。 */
export interface Ticker {
  /** 交易对符号，**市场规范词汇**（docs/symbol-vocabulary.md：cn=600519.SH）。 */
  readonly symbol: string
  /** 标的/公司名称（如“紫光股份”、“苹果”、“腾讯控股”；部分数据源可缺省）。 */
  readonly name?: string
  /** 最新成交价。 */
  readonly price: number
  /** 最优买价（部分数据源可缺省）。 */
  readonly bid?: number
  /** 最优卖价（部分数据源可缺省）。 */
  readonly ask?: number
  /** 24h 成交量（base 资产计）。 */
  readonly volume?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
  /** 官方昨收（涨跌基准锚点；部分数据源可缺省，缺省时消费方退回日 K 自算）。 */
  readonly prevClose?: number
  /** 相对昨收的涨跌幅（百分比，如 -0.89 表示 -0.89%；部分数据源可缺省）。 */
  readonly changePercent?: number
}

/** 单根 K 线。 */
export interface Kline {
  readonly openTime: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly closeTime: number
}

/* ── CN ETF 期权（只读分析面，2026-09-08）──────────────────────────────── */

/** 认购 / 认沽。规范长代码用 C/P。 */
export type OptionRight = 'C' | 'P'

/**
 * 期权数据源。synth = 离线确定性链（CI / 无网关）；akshare = 上交所研究级
 * （深市 NO_DATA）；iquant = 迅投研终端（沪深皆可达，解深市行情缺口）。
 */
export type OptionSource = 'synth' | 'akshare' | 'iquant'

/** 已注册的 ETF 期权标的（与 python/options underlyings.json 对齐）。 */
export interface OptionUnderlying {
  readonly underlying: string
  readonly exchange: 'SSE' | 'SZSE' | 'SYNTH'
  readonly name: string
  readonly multiplier: number
  readonly tickSize: number
  /** sse_board 有 T 板；szse_static_only 只有静态表；iquant_board 走迅投研。 */
  readonly quotesSource: 'sse_board' | 'szse_static_only' | 'iquant_board' | 'synth'
  /** 阶段 4 互联：桥侧从 holdings 聚合的持仓份额（现货腿预填/备兑覆盖参考；无持仓缺省）。 */
  readonly heldQty?: number
}

/** 合约静态（规范主键 = 长代码，如 510050C2609M02850）。 */
export interface OptionContract {
  readonly code: string
  readonly underlying: string
  readonly optionType: OptionRight
  readonly strike: number
  readonly expiryMonth: string
  readonly expiryDate: string
  readonly multiplier: number
  readonly tickSize: number
}

/** T 型报价一行。IV 由 impliedVol 接口回填，链快照可缺省。 */
export interface OptionQuoteRow {
  readonly code: string
  readonly strike: number
  readonly last?: number
  readonly prevSettle?: number
  readonly changePct?: number
  readonly volume?: number
  readonly impliedVol?: number
  readonly converged?: boolean
}

/** 单标的单到期月 T 型报价。 */
export interface OptionChain {
  readonly underlying: string
  readonly expiryMonth: string
  readonly expiryDate?: string
  readonly snapshotAt?: string
  readonly source: OptionSource | string
  readonly spot?: number
  readonly calls: readonly OptionQuoteRow[]
  readonly puts: readonly OptionQuoteRow[]
}

export interface OptionGreeks {
  readonly delta: number
  readonly gamma: number
  readonly vega: number
  readonly theta: number
  readonly rho: number
}

export interface OptionImpliedVolRow extends OptionQuoteRow {
  readonly impliedVol?: number
  readonly converged: boolean
  readonly failReason?: string
}

export interface OptionImpliedVolResult {
  readonly underlying: string
  readonly expiryMonth: string
  readonly source: OptionSource | string
  readonly rate: number
  readonly priceField: 'last' | 'prevSettle'
  readonly rows: readonly OptionImpliedVolRow[]
}

export interface OptionStrategyRequest {
  readonly underlying: string
  readonly expiryMonth?: string
  readonly template?: 'covered_call' | 'collar' | 'vertical' | 'straddle' | 'butterfly'
  readonly legs?: readonly unknown[]
  readonly source?: OptionSource
  readonly rate?: number
  /**
   * 阶段 4 互联：真实持仓份额（ETF 份）。仅 covered_call / collar 有效——python 内核
   * 据此预填现货腿（qty = floor(holdingQty / multiplier) 张，不足 1 张报错）。
   */
  readonly holdingQty?: number
}

/** 策略组合一腿（python strategy `_public_leg` 形状；认购/认沽由 optionType）。 */
export interface OptionStrategyLeg {
  readonly index?: number
  readonly kind: 'option' | 'underlying'
  readonly side: 'buy' | 'sell'
  readonly qty: number
  /** 期权长代码（kind=option 时）。 */
  readonly code?: string
  readonly underlying?: string
  readonly optionType?: OptionRight
  readonly strike?: number
  readonly expiryMonth?: string
  readonly expiryDate?: string
  /** 腿权利金（元/张，kind=option）。 */
  readonly premium?: number
  /** 备兑腿（covered short call 现货已锁）。 */
  readonly covered?: boolean
}

/** 到期损益曲线一点。 */
export interface OptionPayoffPoint {
  readonly spot: number
  readonly pnl: number
}

/** 净敞口希腊字母（带方向/张数/乘数符号；vegaPerVolPoint 按 1 vol 点、thetaPerDay 按 日）。 */
export interface OptionNetGreeks {
  readonly delta: number
  readonly gamma: number
  readonly vega: number
  readonly vegaPerVolPoint: number
  readonly theta: number
  readonly thetaPerDay: number
  readonly rho: number
  readonly rhoPerBp: number
}

/** 组合希腊汇总（status=insufficient 表示至少一腿 IV 缺失，net 为部分和）。 */
export interface OptionStrategyGreeksBlock {
  readonly status: 'ok' | 'insufficient'
  readonly net: OptionNetGreeks
  readonly legs: readonly ({
    readonly index?: number
    readonly kind: 'option' | 'underlying'
    readonly status: 'ok' | 'insufficient'
  } & OptionNetGreeks)[]
}

/** 义务仓保证金一腿（SSE/SZSE ETF 标准比例 12%/7%，备兑认购权利仓现金 0）。 */
export interface OptionStrategyMarginLeg {
  readonly index?: number
  readonly kind: 'option' | 'underlying'
  readonly side?: 'buy' | 'sell'
  readonly qty?: number
  /** unsupported = 现货卖出腿无标准保证金口径。 */
  readonly status?: 'unsupported'
  readonly covered?: boolean
  readonly initial?: number
  readonly maintenance?: number
}

export interface OptionStrategyMarginBlock {
  readonly perLeg: readonly OptionStrategyMarginLeg[]
  readonly totalInitial: number
  readonly totalMaintenance: number
  readonly note: string
}

/** 到期月解析失败行（过期/无数据不中断整次策略计算）。 */
export interface OptionStrategyFailure {
  readonly expiryMonth: string
  readonly code: string
  readonly message: string
}

/** 策略组合全量报告（python strategy handle_strategy 返回形状的强类型）。 */
export interface OptionStrategyResult {
  readonly underlying: string
  readonly source: OptionSource | string
  readonly spot: number
  readonly multiplier: number
  readonly snapshotAt?: string
  readonly priceBasis?: string
  readonly priceBasisNote?: string
  readonly template?: string
  readonly legs: readonly OptionStrategyLeg[]
  readonly entry: { readonly debitCredit: number; readonly note: string }
  readonly payoff: readonly OptionPayoffPoint[]
  readonly greeks: OptionStrategyGreeksBlock
  readonly margin: OptionStrategyMarginBlock
  readonly charts?: readonly unknown[]
  readonly failures?: readonly OptionStrategyFailure[]
}

export interface CnOptionsQuery {
  readonly underlying: string
  readonly expiryMonth?: string
  readonly source?: OptionSource
  readonly rate?: number
  readonly priceField?: 'last' | 'prevSettle'
}

/**
 * python 内核报告透传类型：形状由 python/options 各 handler 文档字符串定义
 * （vol_analytics / fetch_underlying_daily / price / parity_check），桥与 agent
 * 工具只 JSON 序列化不解释字段——与 OptionStrategyResult 的强类型（UI 消费）区分。
 */
export type KernelReport = Readonly<Record<string, unknown>>

/** vol_analytics 查询（多月 IV 截面 + 标的已实现波动率）。 */
export interface OptionVolAnalyticsQuery extends CnOptionsQuery {
  /** 缺省 = 标准四季月全集。 */
  readonly expiryMonths?: readonly string[]
  readonly asOf?: string
  readonly dividendYield?: number
  /** 已实现波动率窗口（交易日），python 默认 [21, 63, 252]。 */
  readonly hvWindows?: readonly number[]
  /** IV 分位窗口，python 默认 [252]。 */
  readonly ivWindows?: readonly number[]
}

/** fetch_underlying_daily 查询（标的 ETF 现货日线，parquet cache-first）。 */
export interface OptionUnderlyingDailyQuery {
  readonly source: 'akshare' | 'iquant'
  /** 缺省 / 'all' = 该 source 注册表全表。 */
  readonly underlying?: string
  readonly start?: string
  readonly end?: string
  readonly adjust?: '' | 'qfq' | 'hfq'
  readonly forceRefresh?: boolean
}

/** price 查询（单腿欧式 BSM 定价与全 Greeks；expiryDate+asOf 与 years 二选一）。 */
export interface OptionPriceQuery {
  readonly spot: number
  readonly strike: number
  readonly optionType: OptionRight
  readonly vol: number
  readonly expiryDate?: string
  readonly asOf?: string
  readonly years?: number
  readonly rate?: number
  readonly dividendYield?: number
}

/** parity_check 查询（同链同期同行权价 C−P 配对平价检验）。 */
export interface OptionParityQuery extends CnOptionsQuery {
  /** 偏差阈值（元），缺省 max(2×tickSize, 0.0005)。 */
  readonly threshold?: number
  readonly asOf?: string
}

/** 标准四季月一行（当月 / 次月 / +3 / +6），到期日 = 该月第四个周三。 */
export interface OptionExpiryMonth {
  readonly expiryMonth: string
  readonly expiryDate: string
}

export interface OptionExpiryCalendar {
  readonly underlying: string
  readonly source: OptionSource | string
  readonly months: readonly OptionExpiryMonth[]
}

/**
 * CN ETF 期权只读服务（独立键 tradingCnOptions，不挂行情 provider）。
 * 实现方：@dshtrading/connector-options → 本地 HTTP 网关 → python/options。
 */
export interface CnOptionsService {
  listUnderlyings(source?: OptionSource): Promise<readonly OptionUnderlying[]>
  getOptionExpiries(query: CnOptionsQuery): Promise<OptionExpiryCalendar>
  getOptionChain(query: CnOptionsQuery): Promise<OptionChain>
  getImpliedVol(query: CnOptionsQuery & { readonly rate: number }): Promise<OptionImpliedVolResult>
  getStrategy(request: OptionStrategyRequest): Promise<OptionStrategyResult>
  /** 阶段 3 内核上桥：波动率分析报告（python vol_analytics）。 */
  getVolAnalytics(query: OptionVolAnalyticsQuery): Promise<KernelReport>
  /** 阶段 3 内核上桥：标的 ETF 现货日线（python fetch_underlying_daily）。 */
  getUnderlyingDaily(query: OptionUnderlyingDailyQuery): Promise<KernelReport>
  /** 阶段 3 内核上桥：单腿 BSM 定价与 Greeks（python price）。 */
  getPrice(query: OptionPriceQuery): Promise<KernelReport>
  /** 阶段 3 内核上桥：Put-Call 平价检验（python parity_check）。 */
  getParityCheck(query: OptionParityQuery): Promise<KernelReport>
}

/* ── CN ETF 期权交易契约（2026-09-08 阶段 3，双闸照 TradeService 范式）──────── */

/** 期权委托类型（上交所/深交所期权均以限价为主，市价仅部分标的支持）。 */
export type OptionOrderType = 'limit' | 'market'

/**
 * 期权下单请求。认购/认沽由长代码内嵌（…C…/…P…）；CN 期权实物交割需显式开平标志。
 * 铁律 #3：dryRun 缺省 true（模拟回执），实盘需 dryRun=false + 服务侧 liveTrading=true 双开。
 */
export interface OptionOrderRequest {
  /** 期权长代码（规范主键），如 510050C2609M02850。 */
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  /** 开平仓（CN 期权必填语义：义务仓开仓收保证金，权利仓开仓付权利金）。 */
  readonly offset: 'open' | 'close'
  /** 张数（1 张 = multiplier 份 ETF，当前名册 multiplier=10000）。 */
  readonly quantity: number
  /** 委托价（元/张权利金口径；orderType=limit 时必填）。 */
  readonly price?: number
  readonly orderType: OptionOrderType
  /** 缺省 true：本地构造模拟回执，不触 QMT 网关。 */
  readonly dryRun?: boolean
}

/** 期权下单回执。premiumAmount 为换算好的权利金金额（price × quantity × multiplier）。 */
export interface OptionOrder {
  readonly id: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly offset: 'open' | 'close'
  readonly orderType: OptionOrderType
  readonly status: 'new' | 'filled' | 'canceled' | 'rejected'
  readonly quantity: number
  readonly price?: number
  /** 权利金金额（元）：price × quantity × multiplier。 */
  readonly premiumAmount?: number
  readonly multiplier: number
  readonly dryRun: boolean
  readonly timestamp: number
}

/** 期权持仓行。quantity 正 = 权利仓（多头），负 = 义务仓（空头）。 */
export interface OptionPosition {
  /** 期权长代码。 */
  readonly symbol: string
  readonly underlying: string
  readonly optionType: OptionRight
  readonly strike: number
  readonly expiryMonth: string
  readonly quantity: number
  readonly avgPrice?: number
  /** 义务仓保证金占用（元；权利仓恒 0/缺省）。 */
  readonly marginOccupied?: number
  readonly timestamp?: number
}

/**
 * CN ETF 期权交易服务（独立键 tradingCnOptionsTrade）。与 TradeService 同款服务缝双闸
 * （dryRun 缺省 true + liveTrading 显式）：dry-run 本地构造回执；live 路径打 QMT 网关
 * （qmtGatewayUrl，MiniQMT 期权通道）。只读面（positions）不走闸门。
 */
export interface CnOptionsTradeService {
  placeOptionOrder(request: OptionOrderRequest): Promise<OptionOrder>
  cancelOptionOrder(orderId: string, symbol?: string): Promise<void>
  listOptionPositions(): Promise<readonly OptionPosition[]>
}

/** 现货 ETF ↔ 期权名册关联（阶段 4 互联：双向跳转与现价拼接）。 */
export interface UnderlyingLink {
  /** 期权名册主键（6 位 ETF 代码，如 510050）。 */
  readonly underlying: string
  /** 现货市场规范符号（cn 词汇，如 510050.SH / 159915.SZ）。 */
  readonly spotSymbol: string
  readonly exchange: 'SSE' | 'SZSE' | 'SYNTH'
  /** 期权长代码前缀（行权价与到期月接在其后）。 */
  readonly callPrefix: string
  readonly putPrefix: string
}

/** 期权总览排序键（C1：默认 5 日强弱，可切 IV 分位 / 持仓优先）。 */
export type OptionOverviewSort = 'strength' | 'iv' | 'holdings'

/** T-5 量价矩阵一格（近 5 个交易日；色深用 changePct，放量边框用 volumeSurge）。 */
export interface OptionOverviewDay {
  /** 交易日 YYYY-MM-DD（由 K 线 closeTime 推出，UTC 日界；CN 日 K 收盘即当日）。 */
  readonly date: string
  /** 当日涨跌幅（百分比，相对前收；首日相对开盘）。 */
  readonly changePct: number
  /** 当日成交量 / 近 5 日均量 > 1.5。 */
  readonly volumeSurge: boolean
}

/**
 * 9 标的期权总览一行（桥侧聚合，不打期权网关除非 includeIv）。
 * 行情/IV 缺席时对应键缺席，UI 按行容错，不整页失败。
 */
export interface OptionOverviewRow {
  readonly underlying: string
  readonly name: string
  readonly exchange: 'SSE' | 'SZSE' | 'SYNTH'
  readonly spotSymbol?: string
  readonly link?: UnderlyingLink
  readonly last?: number
  readonly changePct?: number
  /** 近 5 个交易日累计涨跌幅（百分比）。 */
  readonly return5d?: number
  /** 近 5 日均量 / 近 20 日均量。 */
  readonly volumeRatio?: number
  /** 5 日动量 × 量能确认（return5d × volumeRatio）；默认排序键。 */
  readonly strengthScore?: number
  readonly days: readonly OptionOverviewDay[]
  /** 价升量缩 = weak_rally；价跌量增 = accelerating_sell。 */
  readonly divergence?: 'weak_rally' | 'accelerating_sell'
  readonly heldQty?: number
  /** 该标的期权持仓张数合计（权利+义务取绝对值后相加）。 */
  readonly optionQty?: number
  /** ATM IV 分位 0–1（includeIv=1 且报告有 iv_percentile 时）。 */
  readonly ivPercentile?: number
  /** C2：填进 composer 的扫描 prompt（技术分析，非投资建议）。 */
  readonly scanPrompt: string
}

export interface OptionOverview {
  readonly source: OptionSource | string
  readonly sort: OptionOverviewSort
  readonly asOf: string
  readonly rows: readonly OptionOverviewRow[]
  /** C2：总览「扫描标的」预填（全表摘要）。 */
  readonly scanAllPrompt: string
}

/** 股票市场标的基本面与财务估值快照（CN）。 */
export interface StockFundamentals {
  /** 标的规范符号（如 600519.SH）。 */
  readonly symbol: string
  /** 公司/标的名称。 */
  readonly name?: string
  /** 总市值（本位币计价）。 */
  readonly marketCap?: number
  /** 流通市值（A 股/港股适用）。 */
  readonly floatMarketCap?: number
  /** 滚动市盈率 PE (TTM)。 */
  readonly peTtm?: number
  /** 静态市盈率 PE (静)。 */
  readonly peStatic?: number
  /** 动态/预测市盈率 Forward / Dynamic PE。 */
  readonly peDynamic?: number
  /** 市净率 PB。 */
  readonly pb?: number
  /** 市销率 PS。 */
  readonly ps?: number
  /** 每股收益 EPS。 */
  readonly eps?: number
  /** 每股净资产 BPS。 */
  readonly bps?: number
  /** 股息率（小数，如 0.015 表示 1.5%）。 */
  readonly dividendYield?: number
  /** 换手率（小数或百分比）。 */
  readonly turnoverRate?: number
  /** 振幅（百分比）。 */
  readonly amplitudePercent?: number
  /** 涨停价（A 股适用）。 */
  readonly limitUpPrice?: number
  /** 跌停价（A 股适用）。 */
  readonly limitDownPrice?: number
  /** 52 周最高价。 */
  readonly fiftyTwoWeekHigh?: number
  /** 52 周最低价。 */
  readonly fiftyTwoWeekLow?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 盘口档位（价格 + 挂单量，量单位=标的基准单位：股票股）。 */
export interface OrderbookLevel {
  readonly price: number
  readonly amount: number
}

/**
 * 盘口快照（GUI「盘口」竖栏用，issue #39）。实现保证：bids 按价格降序（买一在前）、
 * asks 按价格升序（卖一在前），档位数由数据源决定（沪深五档）。
 */
export interface Orderbook {
  readonly symbol: string
  readonly bids: readonly OrderbookLevel[]
  readonly asks: readonly OrderbookLevel[]
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 逐笔成交（taker 视角：side 为主动方；流水单条）。 */
export interface TradeTick {
  /** 交易所成交 id（字符串透传，排序稳定性由时间戳保证）。 */
  readonly id: string
  readonly symbol: string
  readonly price: number
  /** 成交量（基准单位，同 OrderbookLevel.amount）。 */
  readonly amount: number
  /** 主动方向：buy=主动买（外盘）、sell=主动卖（内盘）；数据源缺方向时 unknown。 */
  readonly side: 'buy' | 'sell' | 'unknown'
  readonly timestamp: number
}

/** 单期财务指标数值与同比变动。 */
export interface FinancialCell {
  /** 指标数值（如 14.18 元 或 19.02%）。 */
  readonly value?: number
  /** 同比增长率（百分比，如 -3.69 表示 -3.69%，+522.77 表示 +522.77%）。 */
  readonly changePercent?: number
}

/** 单个财务指标行（多期序列）。 */
export interface FinancialIndicatorRow {
  readonly id: string
  readonly name: string
  readonly unit?: string
  /** 期别映射 -> 该期读数与同比（key 对应 periods 数组中的元素，如 '2025/H1'）。 */
  readonly values: Record<string, FinancialCell>
}

/** 财务指标大类分组（如“每股指标”、“盈利能力”、“现金流量”等）。 */
export interface FinancialReportGroup {
  readonly id: string
  readonly title: string
  readonly rows: FinancialIndicatorRow[]
}

/** 历史多期财务报表与指标矩阵（富途牛牛同款）。 */
export interface FinancialReportMatrix {
  /** 币种（如 CNY）。 */
  readonly currency: string
  /** 最新报告期标题（如 "2026财年H1 财报"）。 */
  readonly latestReportTitle?: string
  /** 报告期有序列表（由远及近，如 ['2024/H1', '2024/Q3', '2024/FY', '2025/H1', '2025/Q3', '2025/FY', '2026/Q1', '2026/H1']）。 */
  readonly periods: string[]
  /** 分组列表。 */
  readonly groups: FinancialReportGroup[]
}

/** 股东持股信息行。 */
export interface ShareholderItem {
  readonly name: string
  readonly shares?: number
  readonly ratio?: number
  readonly change?: string
}

/** 公司/标的简况信息。 */
export interface CompanyProfile {
  readonly symbol: string
  readonly name?: string
  readonly fullName?: string
  readonly nameEn?: string
  readonly industry?: string
  readonly sector?: string
  readonly legalRepresentative?: string
  readonly chairman?: string
  readonly generalManager?: string
  readonly boardSecretary?: string
  readonly registeredCapital?: string
  readonly address?: string
  readonly businessScope?: string
  readonly employeeCount?: string
  readonly description?: string
  readonly listingDate?: string
  readonly website?: string
  readonly executives?: Array<{ name: string; title: string }>
}

/** 机构盈利预测与目标价一致预期（富途 预测）。 */
export interface ForecastSummary {
  readonly epsCurrentYear?: number
  readonly epsNextYear?: number
  readonly revenueGrowthAvg?: number
  readonly netProfitGrowthAvg?: number
  readonly targetPriceAvg?: number
  readonly buyRatingCount?: number
  readonly holdRatingCount?: number
  readonly sellRatingCount?: number
  readonly totalOrgs?: number
  readonly items?: Array<{
    readonly year: string
    readonly eps: number
    readonly revenue: number
    readonly netProfit: number
    readonly orgCount?: number
  }>
}

/** 研报精选（富途 晨星研报/券商研报）。 */
export interface ResearchReportItem {
  readonly id: string
  readonly title: string
  readonly orgName: string
  readonly author?: string
  readonly rating?: string
  readonly publishDate: string
  readonly summary?: string
  readonly url?: string
}

/** 主营构成（富途 经营分析/主营构成）。 */
export interface MainOperationSegment {
  readonly segmentName: string
  readonly classification: 'product' | 'industry' | 'region'
  readonly revenue: number
  readonly revenueRatio: number
  readonly grossProfit?: number
  readonly grossMargin?: number
}

/** 经营效率指标（富途 经营分析/经营效率）。 */
export interface OperatingEfficiency {
  readonly inventoryTurnoverDays?: number
  readonly accountsReceivableTurnoverDays?: number
  readonly operatingCycleDays?: number
  readonly totalAssetTurnover?: number
  readonly netProfitMargin?: number
  readonly grossProfitMargin?: number
  readonly currentRatio?: number
  readonly quickRatio?: number
  readonly roe?: number
}

/** 股东增减持 / 内部人交易（富途 聪明钱/股东增减持）。 */
export interface InsiderTradeItem {
  readonly holderName: string
  readonly changeType: '增持' | '减持' | '不变' | '新进' | string
  readonly changeShares: number
  readonly changeRatio?: number
  readonly postHoldingRatio?: number
  readonly date?: string
  readonly averagePrice?: number
}

/** 机构持股明细（富途 聪明钱/机构持股）。 */
export interface InstitutionalHoldingItem {
  readonly orgName?: string
  readonly orgType: string
  readonly orgCount?: number
  readonly holdingShares: number
  readonly holdingRatio: number
  readonly marketCap?: number
  readonly change?: string
  readonly changeRatio?: number
}

/** 分红派息方案（富途 公司行动/分红派息）。 */
export interface DividendItem {
  readonly planYear: string
  readonly dividendPlan: string
  readonly cashDividend?: number
  readonly exDividendDate?: string
  readonly dividendDate?: string
  readonly recordDate?: string
  readonly dividendYield?: number
}

/** 股份回购方案（富途 公司行动/回购）。 */
export interface BuybackItem {
  readonly date: string
  readonly buybackAmount?: number
  readonly buybackShares?: number
  readonly priceRange?: string
  readonly status: string
}

/** 拆股并股 / 送转（富途 公司行动/拆股并股）。 */
export interface SplitItem {
  readonly date: string
  readonly ratio: string
  readonly description: string
}

/** 股东户数与筹码集中度（富途 聪明钱）。 */
export interface HolderNumSummary {
  readonly totalHolders?: number
  readonly totalHoldersChangeRatio?: number
  readonly avgFreeShares?: number
  readonly avgHoldAmount?: number
  readonly concentration?: string
  readonly reportDate?: string
}

/** 集合竞价快照与强弱基准（同花顺 A 股竞价数据面）。 */
export interface AuctionSnapshot {
  readonly symbol: string
  readonly matchPrice?: number
  readonly matchVolume?: number
  readonly unmatchedVolume?: number
  readonly unmatchedSide?: 'buy' | 'sell'
  readonly strengthIndex?: number
  readonly stage?: 'call' | 'final'
  readonly timestamp: number
}

/** 涨跌停池与连板天梯条目（同花顺特色短线数据面）。 */
export interface LimitUpPoolItem {
  readonly symbol: string
  readonly name: string
  readonly price: number
  readonly changePercent: number
  readonly limitType: 'up' | 'down' | 'broken'
  readonly firstLimitTime?: string
  readonly lastLimitTime?: string
  readonly limitOrderVolume?: number
  readonly limitOrderAmount?: number
  readonly consecutiveBoards?: number
  readonly breakCount?: number
  readonly sectorConcept?: string
}

/** 龙虎榜席位与机构明细条目（同花顺特色资金数据面）。 */
export interface DragonTigerItem {
  readonly symbol: string
  readonly name: string
  readonly closePrice: number
  readonly changePercent: number
  readonly reason: string
  readonly netBuyAmount: number
  readonly buyAmount: number
  readonly sellAmount: number
  readonly institutionalNetBuy?: number
  readonly topBrokers?: Array<{
    readonly rank: number
    readonly brokerName: string
    readonly type: 'buy' | 'sell'
    readonly buyAmount: number
    readonly sellAmount: number
    readonly isInstitutional: boolean
  }>
  readonly tradeDate: string
}

/** 聚合基本面数据包（供 Bridge 端点向前端全量交付）。 */
export interface FundamentalsPackage {
  readonly market: string
  readonly symbol: string
  readonly stock?: StockFundamentals
  readonly matrix?: FinancialReportMatrix
  readonly profile?: CompanyProfile
  readonly shareholders?: ShareholderItem[]
  readonly forecast?: ForecastSummary
  readonly reports?: ResearchReportItem[]
  readonly mainOperations?: MainOperationSegment[]
  readonly efficiency?: OperatingEfficiency
  readonly insiderTrades?: InsiderTradeItem[]
  readonly institutionalHoldings?: InstitutionalHoldingItem[]
  readonly holderSummary?: HolderNumSummary
  readonly dividends?: DividendItem[]
  readonly buybacks?: BuybackItem[]
  readonly splits?: SplitItem[]
  readonly auction?: AuctionSnapshot
  readonly limitUpItem?: LimitUpPoolItem
  readonly dragonTiger?: DragonTigerItem
}

export type PositionSide = 'long' | 'short'

/** 持仓快照。 */
export interface Position {
  readonly symbol: string
  readonly side: PositionSide
  /** 仓位数量（正数；方向由 side 表达）。 */
  readonly size: number
  readonly entryPrice: number
  readonly markPrice?: number
  readonly unrealizedPnl?: number
  readonly leverage?: number
  readonly timestamp: number
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'limit' | 'market'
export type OrderStatus = 'new' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'

/** 下单请求（安全闸门：dryRun 缺省视为 true）。 */
export interface OrderRequest {
  readonly symbol: string
  readonly side: OrderSide
  readonly type: OrderType
  readonly quantity: number
  /** limit 单必填。 */
  readonly price?: number
  /** 缺省/true 时仅模拟，不触碰交易所。实盘还受插件 liveTrading 闸门与 approval 约束 [S4]。 */
  readonly dryRun?: boolean
}

/** 订单回执/状态。 */
export interface Order {
  readonly id: string
  readonly symbol: string
  readonly side: OrderSide
  readonly type: OrderType
  readonly status: OrderStatus
  readonly price?: number
  readonly quantity: number
  readonly filledQuantity?: number
  /** 本次订单是否为模拟单（回执必须显式回带，防 dry-run 语义丢失）。 */
  readonly dryRun: boolean
  readonly timestamp: number
}

export interface AccountBalance {
  readonly asset: string
  readonly free: number
  readonly locked: number
}

/** 成交流水单条（GUI 交易台「成交历史」用，issue #40）。 */
export interface TradeFill {
  /** 交易所成交 id。 */
  readonly id: string
  readonly symbol: string
  readonly side: OrderSide
  readonly price: number
  /** 成交量（base 币数）。 */
  readonly amount: number
  /** 手续费（绝对值，币种由 feeAsset 表达）。 */
  readonly fee?: number
  readonly feeAsset?: string
  readonly timestamp: number
}

/** 账户快照（需凭证，BYOK 经 ctx.credentials 引用 [S4]）。 */
export interface IAccount {
  readonly id: string
  readonly balances: readonly AccountBalance[]
}

/** 订阅句柄：dispose 即退订（连接器用 ctx.effect/cordis 生命周期托管）。 */
export interface Disposable {
  dispose(): void
}

/**
 * 行情服务契约：由市场连接器实现，注册到按市场命名空间的 ctx 键（如 ctx.tradingCnMarketData）。
 * 符号词汇（2026-08-31 规范，docs/symbol-vocabulary.md）：入参接受市场规范形与连接器原生形，
 * 输出 `symbol` 一律市场规范形——消费方（GUI/Agent/工作流）与数据源方言解耦。
 */
export interface MarketDataService {
  getTicker(symbol: string): Promise<Ticker>
  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]>
  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void): Disposable
  /**
   * 查询本市场/交易所支持的全部标的名册（动态全集，Issue #15）。
   * 输出 `symbol` 一律市场规范词汇（docs/symbol-vocabulary.md）。
   * 可选方法：无公开全集端点的数据源可缺省或由桥/前端回退。
   */
  listInstruments?(): Promise<Array<{ symbol: string; name?: string }>>
  /**
   * 标的基本面与估值快照（GUI「基本面」页签用，2026-09-02）。
   * 可选方法：仅当数据源在同一公共端点里携带基本面字段时实现
   * （腾讯行情行 cn 已实现）；未实现的市场由消费方降级为派生数据（日K 52 周高低）。
   * 输出 `symbol` 一律市场规范词汇（docs/symbol-vocabulary.md）。
   */
  getFundamentals?(symbol: string): Promise<StockFundamentals>
  /**
   * 盘口快照（GUI「盘口」竖栏用，issue #39）：档位词汇见 Orderbook。可选方法：
   * 数据源无盘口能力时不实现（消费方降级为「该市场未提供盘口」）。
   * 入参接受规范形与连接器原生形，输出 `symbol` 一律市场规范词汇。
   */
  getOrderbook?(symbol: string): Promise<Orderbook>
  /**
   * 最近逐笔成交流水（GUI「分笔」用，issue #39）：取最近 limit 笔（缺省 ≤50），
   * **时间升序（旧→新）**，与 K 线序列同向；方向缺省的数据源 side='unknown'。
   * 可选方法：无公共逐笔端点的数据源（腾讯沪深行情行）不实现。
   */
  getRecentTrades?(symbol: string, limit?: number): Promise<TradeTick[]>
}

/**
 * 交易服务契约：placeOrder 默认 dry-run；实盘前必须过插件 liveTrading 开关与
 * ctx.approval.request（交互形态；headless 下 ask=deny，fail-closed [S4]）。
 *
 * cancelOrder 的可选 symbol 与 getOrder 的 (symbol, id) 双键定位是历史切片
 * （2026-08-29）沿用的形态：按双键定位订单的交易所需要，其余实现方可忽略。
 */
export interface TradeService {
  placeOrder(req: OrderRequest): Promise<Order>
  /** 撤单。symbol 可选：按 (symbol, id) 双键定位订单的通道建议提供。 */
  cancelOrder(id: string, symbol?: string): Promise<void>
  /** 查询单笔订单状态（按 (symbol, id) 双键）。 */
  getOrder(symbol: string, id: string): Promise<Order>
  getPositions(): Promise<Position[]>
  /**
   * 账户余额快照（issue #40 GUI 交易台；只读，需凭证）。
   * 可选方法：实现方已有只读余额面时实现。
   */
  getBalances?(): Promise<AccountBalance[]>
  /**
   * 当前挂单列表（issue #40 GUI 交易台；只读，需凭证）。
   * 可选方法：无批量挂单端点的实现方可缺省（GUI 隐藏挂单区）。
   * 输出 `symbol` 一律市场规范词汇；status 只含 new / partially_filled。
   */
  listOpenOrders?(symbol?: string): Promise<Order[]>
  /**
   * 最近成交流水（issue #40 GUI 交易台；只读，需凭证）。
   * 可选方法：时间升序（旧→新），最多 limit 条（缺省 ≤50）。
   */
  listTradeFills?(symbol?: string, limit?: number): Promise<TradeFill[]>
}

/**
 * 统一错误词汇（本包不做运行时 Error 类；实现方自行映射到该词汇）。
 * 命名空间 `TRADING_`，跨市场/跨连接器稳定。
 */
export type TradingErrorCode =
  /** 功能未实现（骨架/占位阶段）。 */
  | 'TRADING_NOT_IMPLEMENTED'
  | 'TRADING_UNSUPPORTED_SYMBOL'
  | 'TRADING_UNSUPPORTED_INTERVAL'
  /** 凭证缺失或无效（ctx.credentials 引用解析失败 [S4]）。 */
  | 'TRADING_CREDENTIALS_MISSING'
  | 'TRADING_AUTH_FAILED'
  | 'TRADING_RATE_LIMITED'
  | 'TRADING_NETWORK'
  /** 上游 HTTP/网关非 2xx（连接器常用；期权内核 NO_DATA 不走此码）。 */
  | 'TRADING_UPSTREAM_ERROR'
  /** 注册标的存在但该源无报价（如 akshare 深市期权行情缺口）。 */
  | 'TRADING_NO_DATA'
  | 'TRADING_INSUFFICIENT_BALANCE'
  /** liveTrading=false 闸门拒绝实盘（铁律 #3）。 */
  | 'TRADING_LIVE_TRADING_DISABLED'
  /** approval 被拒/无应答（headless fail-closed [S4]）。 */
  | 'TRADING_APPROVAL_DENIED'
  /** 本次为 dry-run 模拟结果（非故障语义）。 */
  | 'TRADING_DRY_RUN'
  | 'TRADING_EXCHANGE_ERROR'
  | 'TRADING_UNKNOWN'

/** 结构化错误载体（实现方在 Error 上附加该形状，或直接以 code 抛出）。 */
export interface TradingError {
  readonly code: TradingErrorCode
  readonly message: string
  /** 交易所原始错误/上游 cause。 */
  readonly cause?: unknown
}

/**
 * Cordis Context 服务键（能力三角色之「声明」）：市场命名空间键由契约包统一声明，
 * 连接器 provide、消费方 inject 时获得完整类型。此处仅类型增强——本包保持
 * 零运行时依赖，不产生任何 JS 输出。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** cn 市场行情服务（由腾讯连接器以公共端点提供，无需凭证）。 */
    tradingCnMarketData: MarketDataService
    /**
     * 交易服务注册表（issue #40 GUI 交易台，@dshtrading/api 类型声明）：
     * 与 tradingMarketDataRegistry 同构的宿主平面注册面——交易连接器 host 面数据行
     * 注册，GUI 桥按路由当前值惰性解析。**注册不改变安全语义**：placeOrder 的
     * 服务缝闸门（dryRun 缺省 true + liveTrading 显式开关）随服务实例生效；
     * GUI 桥只放行 dry-run 下单与只读查询，实盘路径仍走 Agent 工具的 base 审批闸门。
     */
    tradingTradeRegistry: TradeRegistry
    /**
     * 市场路由服务（R5 2026-08-29 补齐，@dshtrading/router 提供）：
     * 连接器 apply 时 consult activeProvider(market) 决定是否激活——用户设置
     * dshtrading.markets.<market>.provider 选谁谁激活（docs/exchange-routing.md）。
     */
    tradingMarketRouter: MarketRouterService
    /**
     * 行情服务注册表（2026-08-30 注册表模式定稿，@dshtrading/router 同插件提供）：
     * 连接器 host 面数据行注册，GUI 行情桥按路由当前值惰性解析（热切换）。
     */
    tradingMarketDataRegistry: MarketDataRegistry
    /**
     * 新闻聚合器注册表（Issue #37，@dshtrading/router 同插件提供）：
     * 各市场 Kit apply 时注册 aggregateNews 纯函数，GUI 行情桥按市场获取。
     */
    tradingNewsRegistry: TradingNewsRegistry
    /**
     * CN ETF 期权只读服务（2026-09-08）：由 connector-options host 面提供，
     * 不走 tradingMarketDataRegistry / CN 行情 provider（默认腾讯无期权链）。
     */
    tradingCnOptions: CnOptionsService
    /**
     * CN ETF 期权交易服务（2026-09-08 阶段 3）：connector-options 交易半提供。
     * 服务缝双闸与 TradeService 同款（dryRun 缺省 true + liveTrading 显式），
     * 注册不改变安全语义——实盘路径仍需 base 审批闸门（ORDER_GATE_PATTERN）。
     */
    tradingCnOptionsTrade: CnOptionsTradeService
  }
}

/**
 * 行情服务注册表契约（router 插件提供，2026-08-30 注册表模式定稿）：
 * 连接器 host 面数据行不再互斥式 provide 市场键，而是全部注册进本注册表；
 * 消费方（GUI 行情桥）经 active() 按路由当前值惰性解析——settings 变更即刻生效
 * （GUI 热切换），无 watch、无进程重启。preset 平面不走注册表：会话内数据源
 * 一致性是有意语义，切交易所对会话 = 新建会话生效（docs/exchange-routing.md §2.2）。
 *
 * 与 tradeProvider 预留的衔接：本注册表只承载 MarketDataService；数据/交易分离
 * 落地时 TradeService 走独立注册面（不复用本键），铁律 #4 到时再抽象。
 */
export interface MarketDataRegistration {
  /** 市场 slug（cn；开放词汇，新市场 = 新键）。 */
  readonly market: string
  /** 提供者 slug（tencent/eastmoney/tushare/qmt/…；开放词汇，第三方连接器可注册新 slug）。 */
  readonly provider: string
  readonly service: MarketDataService
}

export interface MarketDataRegistry {
  /**
   * 注册一个市场的某 provider 行情服务；同 (market, provider) 重复注册抛错
   * （配置错误必须响亮）。返回注销函数（调用方包进 ctx.effect 随 fiber 注销）。
   */
  register(market: string, provider: string, service: MarketDataService): () => void
  /**
   * 路由裁决后的当前激活注册项：router 选中的 provider 已注册 → 返回之；
   * 选中了但未注册（包未装/enabled=false）→ undefined（调用方面向用户报错，
   * 不静默降级到别家——用户设置是权威）；router 无该市场路由（未知市场键）
   * 且恰好一个注册项 → 返回之（新市场零配置可用）；否则 undefined。
   */
  active(market: string): MarketDataRegistration | undefined
  /** 某市场全部注册项（诊断/设置 UI 展示用）。 */
  list(market: string): readonly MarketDataRegistration[]
}

/** 交易服务注册项（tradingTradeRegistry 的条目，issue #40）。 */
export interface TradeRegistration {
  readonly market: string
  readonly provider: string
  readonly service: TradeService
}

/**
 * 交易服务注册表（router 插件同款注册模式，issue #40）：交易连接器在 host 面
 * 数据行注册（凭证经 ctx.credentials / 环境变量解析，缺失时只读方法 fail-closed
 * 报 TRADING_CREDENTIALS_MISSING）；注册面本身不做安全裁决——闸门在服务缝
 * （placeOrder 三态）与桥层（GUI 只放行 dry-run）。
 */
export interface TradeRegistry {
  register(market: string, provider: string, service: TradeService): () => void
  active(market: string): TradeRegistration | undefined
  list(market: string): readonly TradeRegistration[]
}

/**
 * 市场路由服务契约（router 插件提供）：按市场查询当前激活的数据/交易所提供方。
 * 用户设置（dshtrading namespace，settings.yaml）是权威；无设置时 = 组合默认值
 * （现状零变化）。供应商取值与连接器的 provider slug 比对，相符者激活。
 */
export interface MarketRouterService {
  /** 某市场当前激活的 provider slug（settings resolved：用户层赢，缺省 base 默认）。 */
  activeProvider(market: string): string | undefined
  /** 订阅激活变化（settings commit 驱动）。 */
  watch(cb: (next: string | undefined, prev: string | undefined) => void): () => void
}

/* ── 新闻聚合契约（Issue #37）──────────────────────────────── */

/** 新闻/快讯条目（各市场 Kit 统一输出形状）。 */
export interface NewsItem {
  /** 来源标识（如 'eastmoney'、'eastmoney-announcement'、'cninfo-announcement'）。 */
  readonly source: string
  /** 新闻/快讯标题。 */
  readonly title: string
  /** 详情页 URL。 */
  readonly url: string
  /** ISO 8601 发布时间。 */
  readonly publishedAt: string
  /** 关联标的代码（可选，格式随源不同）。 */
  readonly relatedCodes?: readonly string[]
}

/** 新闻聚合请求选项。 */
export interface AggregateNewsOptions {
  /** 输出条数上限（1~50，默认 20）。 */
  limit?: number | undefined
  /** 时间窗口（小时，1~168，默认 24）。 */
  windowHours?: number | undefined
  /** 按标的代码过滤（可选）。 */
  symbol?: string | undefined
}

/** 新闻聚合结果。 */
export interface AggregateNewsResult {
  /** 按发布时间倒序的新闻条目。 */
  readonly items: readonly NewsItem[]
  /** 失败的数据源名称（fail-soft 容错：可用源正常返回，不可用源记录在此）。 */
  readonly unavailable: readonly string[]
}

/** 新闻聚合器函数签名（各 Kit 导出的 aggregateNews 符合此形状）。 */
export type NewsAggregator = (options?: AggregateNewsOptions) => Promise<AggregateNewsResult>

/** 新闻聚合器注册表契约（Issue #37，router 插件提供）。 */
export interface TradingNewsRegistry {
  register(market: string, aggregator: NewsAggregator): () => void
  get(market: string): NewsAggregator | undefined
  markets(): string[]
}

