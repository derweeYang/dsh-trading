/**
 * Bridge client: same-origin fetch wrappers over /dshtrading/api (the node
 * half registers the route behind the browser-auth fence; same-origin fetch
 * carries the auth cookie by default).
 */
import type { AccountBalance, Kline, MarketId, MarketInfo, Order, Orderbook, Position, TickerOutcome, TradeFill, TradeTick } from './types.ts'
import type {
  FundamentalsPackage, KernelReport, OptionBarContextPacket, OptionChain, OptionCycle, OptionCycleLoop,
  OptionExpiryCalendar, OptionIntradayBox, OptionOrder, OptionOverview, OptionOverviewSort,
  OptionPaperAccountsWire, OptionPaperBookId, OptionPaperBookWire, OptionPaperDesk, OptionPosition,
  OptionStrategyRequest, OptionStrategyResult, OptionUnderlying,
  OptionPrediction, OptionPredictionBoard, OptionPredictionTrack, OptionPredictionDraft,
  OptionPredictionSettle, PaperFill, PredictionKnowledgeItem,
} from '@dshtrading/api'
import type { CustomIndicatorRecord, IndicatorInstance } from '@dshtrading/indicators'
import type { KnowledgeCard } from '@dshtrading/knowledge'
import type { CustomStrategyRecord, CustomScreenerRecord } from '@dshtrading/strategies'
import type { FxSnapshot, HoldingsBaseCurrency, HoldingsBookSnapshot, NewHolding, NewHoldingInput } from './holdings-types.ts'

export class BridgeError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, ...(signal === undefined ? {} : { signal }) })
  if (response.status === 401) throw new BridgeError(401, 'unauthorized')
  if (response.status === 403) throw new BridgeError(403, 'forbidden')
  if (!response.ok) {
    // 非 2xx 也读 body（2026-09-04）：桥的协议错误带 code（如 TRADING_NO_TRADE_SERVICE），
    // 调用方据此区分「服务未挂」与「凭证缺失」；body 非 JSON 时静默回退状态码信息。
    const body = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    const detail = typeof body?.message === 'string' && body.message !== '' ? `: ${body.message}` : ''
    throw new BridgeError(response.status, `bridge ${path} failed: ${response.status}${detail}`, body?.code)
  }
  const wire = await response.json() as T
  // 桥的业务错误信封是 HTTP 200 + { ok:false, code, message }；必须转成 rejection，
  // 否则调用方拿到 undefined 当成功值（会以 .map-of-undefined 之类的次生错误炸开）。
  if (wire !== null && typeof wire === 'object' && (wire as { ok?: unknown }).ok === false) {
    const business = wire as { code?: string; message?: string }
    throw new BridgeError(200, `${business.code ?? 'TRADING_UNKNOWN'}: ${business.message ?? 'bridge business error'}`, business.code)
  }
  return wire
}

/** Installed markets + active provider slugs (drives the sidebar tab strip). */
export async function fetchMarkets(): Promise<MarketInfo[]> {
  const wire = await getJson<{ markets: MarketInfo[] }>('/dshtrading/api/markets')
  return wire.markets ?? []
}

/** Batched tickers; per-symbol outcomes are independent (bad codes don't sink the batch). */
export async function fetchTickers(market: MarketId, symbols: string[]): Promise<Record<string, TickerOutcome>> {
  const query = new URLSearchParams({ market, symbols: symbols.join(',') })
  const wire = await getJson<{ tickers: Record<string, TickerOutcome> }>(`/dshtrading/api/tickers?${query.toString()}`)
  return wire.tickers ?? {}
}

export async function fetchKlines(market: MarketId, symbol: string, interval: string, limit: number): Promise<Kline[]> {
  const query = new URLSearchParams({ market, symbol, interval, limit: String(limit) })
  const wire = await getJson<{ klines: Kline[] }>(`/dshtrading/api/klines?${query.toString()}`)
  return Array.isArray(wire.klines) ? wire.klines : []
}

/**
 * 盘口快照（issue #39）。连接器未实现 getOrderbook（yahoo/stooq/腾讯 r_hk）或
 * 取数失败 → null：竖栏降级为「未提供盘口」提示，不报错横幅。
 */
export async function fetchOrderbook(market: MarketId, symbol: string): Promise<Orderbook | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; orderbook: Orderbook }>(`/dshtrading/api/orderbook?${query.toString()}`)
    return wire.orderbook ?? null
  } catch {
    return null
  }
}

/**
 * 最近逐笔成交（issue #39，时间升序）。连接器未实现 getRecentTrades 或失败 → null：
 * 流水段隐藏；成功但空数组 → []（展示空态由调用方判断 length）。
 */
export async function fetchRecentTrades(market: MarketId, symbol: string, limit = 50): Promise<TradeTick[] | null> {
  try {
    const query = new URLSearchParams({ market, symbol, limit: String(limit) })
    const wire = await getJson<{ ok: boolean; trades: TradeTick[] }>(`/dshtrading/api/trades?${query.toString()}`)
    return Array.isArray(wire.trades) ? wire.trades : []
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* CN ETF 期权（2026-09-08 第一期只读面；T 板用，契约见 docs/options-bridge.md） */
/* ------------------------------------------------------------------ */

/**
 * 期权取数结果。与其余 fetch（失败一律 null）不同，期权面要按错误码分诊：
 * NOT_IMPLEMENTED → 页签隐藏；NETWORK → 提示起网关；NO_DATA → 空态 + 原文。
 */
export type OptionsOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

function optionsFailure(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof BridgeError) {
    return { ok: false, code: err.code ?? `HTTP_${err.status}`, message: err.message }
  }
  return { ok: false, code: 'TRADING_UNKNOWN', message: err instanceof Error ? err.message : String(err) }
}

/**
 * 注册标的名册（连接器静态表，不打网关）——T 板页签显隐判据。
 * 未挂 connector-options → TRADING_NOT_IMPLEMENTED，UI 隐藏「期权」页签。
 */
export async function fetchOptionsUnderlyings(): Promise<OptionsOutcome<readonly OptionUnderlying[]>> {
  try {
    const wire = await getJson<{ ok: boolean; underlyings: readonly OptionUnderlying[] }>(
      '/dshtrading/api/options/underlyings',
    )
    return { ok: true, data: wire.underlyings ?? [] }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 标准四季月（当月/次月/+3/+6），本地算不打网关 → 网关未起也能画出到期胶囊。 */
export async function fetchOptionsExpiries(underlying: string): Promise<OptionsOutcome<OptionExpiryCalendar>> {
  try {
    const query = new URLSearchParams({ underlying })
    const wire = await getJson<{ ok: boolean; expiries: OptionExpiryCalendar }>(
      `/dshtrading/api/options/expiries?${query.toString()}`,
    )
    if (wire.expiries === undefined) return optionsFailure(new Error('expiries missing in wire'))
    return { ok: true, data: wire.expiries }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** T 型报价链（需要网关 127.0.0.1:8090）。expiryMonth 为 YYMM。 */
export async function fetchOptionsChain(
  underlying: string,
  expiryMonth: string,
): Promise<OptionsOutcome<OptionChain>> {
  try {
    const query = new URLSearchParams({ underlying, expiryMonth })
    const wire = await getJson<{ ok: boolean; chain: OptionChain }>(
      `/dshtrading/api/options/chain?${query.toString()}`,
    )
    if (wire.chain === undefined) return optionsFailure(new Error('chain missing in wire'))
    return { ok: true, data: wire.chain }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 现货 ↔ 期权长代码双向规范化结果（阶段 4 互联；形状镜像桥端 OptionResolveWire，
 * SSOT 在 src/bridge.ts——client 不 import node 半，只声明消费的字段）。
 */
export interface OptionResolveResult {
  input: string
  /** 规范 6 位 ETF 代码（名册主键）。 */
  underlying: string
  /** 名册命中时给出现货跳转符号与长代码前缀；名册外（如个股）缺席 → 隐藏期权入口。 */
  link?: { underlying: string; spotSymbol: string; exchange: string; callPrefix: string; putPrefix: string }
  /** 输入本身是期权长代码时解析出的合约要素。 */
  contract?: { code: string; optionType: 'C' | 'P'; strike: number; expiryMonth: string }
}

/** 双向规范化（纯本地解析，不打网关）；非 CN 格式输入 → 400。 */
export async function fetchOptionsResolve(symbol: string): Promise<OptionsOutcome<OptionResolveResult>> {
  try {
    const query = new URLSearchParams({ symbol })
    const wire = await getJson<{ ok: boolean } & OptionResolveResult>(
      `/dshtrading/api/options/resolve?${query.toString()}`,
    )
    if (wire.underlying === undefined) return optionsFailure(new Error('underlying missing in wire'))
    return { ok: true, data: wire }
  } catch (err) {
    return optionsFailure(err)
  }
}

/* ── 期权聚合面（C1 总览 / L2 箱体 / 5 分钟闭环；2026-09-09 WB-0）────────── */

/**
 * 七标的总览（C1）。桥侧聚合现货/日 K/底仓/期权持仓，**只拉这一条**——
 * 不要再拼 tickers + klines + positions（交接单 WB-1 明令禁止）。
 *
 * `includeIv` 默认 false：置 1 会逐标的打 vol_analytics 网关，多路并发打爆
 * 网关；仅排序切到 `iv` 时由调用方显式打开。单行缺键由 UI 按行容错。
 */
export async function fetchOptionsOverview(query: {
  sort?: OptionOverviewSort
  includeIv?: boolean
}): Promise<OptionsOutcome<OptionOverview>> {
  try {
    const search = new URLSearchParams()
    if (query.sort !== undefined) search.set('sort', query.sort)
    search.set('includeIv', query.includeIv === true ? '1' : '0')
    const wire = await getJson<{ ok: boolean; overview: OptionOverview }>(
      `/dshtrading/api/options/overview?${search.toString()}`,
    )
    if (wire.overview === undefined) return optionsFailure(new Error('overview missing in wire'))
    return { ok: true, data: wire.overview }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 1 分钟 → 5 分钟箱体（L2，展示用）。
 * `horizon` 只接受 5 且不是 UI 选项 → 不传（桥缺省即 5）。
 * T 板优先读闭环 `loop.latest.forecast`，本端点是降级路径（见 WB-3）。
 */
export async function fetchOptionsIntradayBox(query: {
  underlying?: string
  asOf?: string
}): Promise<OptionsOutcome<OptionIntradayBox>> {
  try {
    const search = new URLSearchParams()
    if (query.underlying !== undefined) search.set('underlying', query.underlying)
    if (query.asOf !== undefined) search.set('asOf', query.asOf)
    const wire = await getJson<{ ok: boolean; box: OptionIntradayBox }>(
      `/dshtrading/api/options/intraday-box?${search.toString()}`,
    )
    if (wire.box === undefined) return optionsFailure(new Error('box missing in wire'))
    return { ok: true, data: wire.box }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 5 分钟闭环最新周期 + 命中率（页面可视化 SSOT）。
 * 宿主 node 半每 30s 已对齐上海 5 分钟桶，**页面不要自己算箱体/打分**。
 */
export async function fetchOptionsCycleLoop(): Promise<OptionsOutcome<OptionCycleLoop>> {
  try {
    const wire = await getJson<{ ok: boolean; loop: OptionCycleLoop }>(
      '/dshtrading/api/options/cycles/loop',
    )
    if (wire.loop === undefined) return optionsFailure(new Error('loop missing in wire'))
    return { ok: true, data: wire.loop }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 当天最新 5 分钟桶 ContextPacket（2026-09-10 WB-12）。
 *
 * **没有 packet 文件是正常态**，不是错误：桥返回 `{ ok: true }` 且**不写** `packet`
 * 键（见 docs/options-bridge.md）。这里如实映射成 `data: null`，让调用方
 * 「无键 → 不渲染整条智能体所见」，而不是弹一个空白报错条。
 *
 * 与 `cycles/loop` 同频 30s 即可——packet 一天只在定时桶落地时推进，5s 轮询纯属打桥。
 */
export async function fetchOptionsBarPacket(): Promise<OptionsOutcome<OptionBarContextPacket | null>> {
  try {
    const wire = await getJson<{ ok: boolean; packet?: OptionBarContextPacket }>(
      '/dshtrading/api/options/bar-packet',
    )
    return { ok: true, data: wire.packet ?? null }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 纸账户执行台快照（近 N 日候选→成交→打分执行链路统计 + 账户 + 跨日流水）。
 * 空账本（零成交、全 skip）是有效诊断载荷：桥返回空 days/全 0 行而非错误，
 * 页面照常渲染——与 detected opportunities 的「无数据即隐藏」语义相反。
 * 30s 轮询与闭环同频即可（账本只在 5 分钟桶推进时变化）。
 */
export async function fetchOptionsPaperDesk(): Promise<OptionsOutcome<OptionPaperDesk>> {
  try {
    const wire = await getJson<{ ok: boolean; desk: OptionPaperDesk }>(
      '/dshtrading/api/options/paper/desk',
    )
    if (wire.desk === undefined) return optionsFailure(new Error('desk missing in wire'))
    return { ok: true, data: wire.desk }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 单标的闭环历史（点周期卡展开；先 forecast，下一桶补 score）。 */
export async function fetchOptionsCycles(query: {
  underlying?: string
  limit?: number
}): Promise<OptionsOutcome<readonly OptionCycle[]>> {
  try {
    const search = new URLSearchParams()
    if (query.underlying !== undefined) search.set('underlying', query.underlying)
    if (query.limit !== undefined) search.set('limit', String(query.limit))
    const wire = await getJson<{ ok: boolean; cycles: readonly OptionCycle[] }>(
      `/dshtrading/api/options/cycles?${search.toString()}`,
    )
    if (wire.cycles === undefined) return optionsFailure(new Error('cycles missing in wire'))
    return { ok: true, data: wire.cycles }
  } catch (err) {
    return optionsFailure(err)
  }
}

/* ── T+1 预测模块（盘势/波动预期 + 跟踪回溯 + 经验沉淀；2026-09-12）────────── */

/** 预测看板：每个标的的最新一条 T+1 预测（GET /options/predictions）。 */
export async function fetchOptionPredictions(query?: {
  underlying?: string
  asOf?: string
}): Promise<OptionsOutcome<OptionPredictionBoard>> {
  try {
    const search = new URLSearchParams()
    if (query?.underlying !== undefined) search.set('underlying', query.underlying)
    if (query?.asOf !== undefined) search.set('asOf', query.asOf)
    const wire = await getJson<{ ok: boolean; board: OptionPredictionBoard }>(
      `/dshtrading/api/options/predictions?${search.toString()}`,
    )
    if (wire.board === undefined) return optionsFailure(new Error('board missing in wire'))
    return { ok: true, data: wire.board }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 跟踪回溯：单标的（或全局）历史 + 统计 + 经验沉淀
 * （GET /options/predictions/track）。limit 仅约束返回的预测条数（统计仍按全量）。
 */
export async function fetchOptionPredictionTrack(query?: {
  underlying?: string
  limit?: number
}): Promise<OptionsOutcome<OptionPredictionTrack>> {
  try {
    const search = new URLSearchParams()
    if (query?.underlying !== undefined) search.set('underlying', query.underlying)
    if (query?.limit !== undefined) search.set('limit', String(query.limit))
    const wire = await getJson<{ ok: boolean; track: OptionPredictionTrack }>(
      `/dshtrading/api/options/predictions/track?${search.toString()}`,
    )
    if (wire.track === undefined) return optionsFailure(new Error('track missing in wire'))
    return { ok: true, data: wire.track }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 新建一条 T+1 预测（POST /options/predictions；桥补全 id / createdAt / asOfDate）。 */
export async function createOptionPrediction(draft: OptionPredictionDraft): Promise<OptionsOutcome<OptionPrediction>> {
  try {
    const response = await fetch('/dshtrading/api/options/predictions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
    const wire = await response.json().catch(() => undefined) as
      | { ok?: boolean; prediction?: OptionPrediction; code?: string; message?: string }
      | undefined
    if (!response.ok || wire?.ok !== true || wire.prediction === undefined) {
      const code = wire?.code ?? `HTTP_${response.status}`
      return { ok: false, code, message: wire?.message ?? code }
    }
    return { ok: true, data: wire.prediction }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** T+1 收盘后回填实盘结果（POST /options/predictions/settle；桥重写 hit/score 等）。 */
export async function settleOptionPrediction(input: OptionPredictionSettle): Promise<OptionsOutcome<OptionPrediction>> {
  try {
    const response = await fetch('/dshtrading/api/options/predictions/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const wire = await response.json().catch(() => undefined) as
      | { ok?: boolean; prediction?: OptionPrediction; code?: string; message?: string }
      | undefined
    if (!response.ok || wire?.ok !== true || wire.prediction === undefined) {
      const code = wire?.code ?? `HTTP_${response.status}`
      return { ok: false, code, message: wire?.message ?? code }
    }
    return { ok: true, data: wire.prediction }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 经验沉淀汇总（GET /options/predictions/knowledge；可选 underlying 过滤）。 */
export async function fetchOptionPredictionKnowledge(query?: {
  underlying?: string
}): Promise<OptionsOutcome<readonly PredictionKnowledgeItem[]>> {
  try {
    const search = new URLSearchParams()
    if (query?.underlying !== undefined) search.set('underlying', query.underlying)
    const wire = await getJson<{ ok: boolean; knowledge: readonly PredictionKnowledgeItem[] }>(
      `/dshtrading/api/options/predictions/knowledge?${search.toString()}`,
    )
    if (wire.knowledge === undefined) return optionsFailure(new Error('knowledge missing in wire'))
    return { ok: true, data: wire.knowledge }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 波动率分析报告（python vol_analytics JSON 透传不解释；总览页 IV 分位排序用）。 */
export async function fetchOptionVolAnalytics(query: {
  underlying: string
  expiryMonths?: readonly string[]
  asOf?: string
  rate?: number
  dividendYield?: number
  source?: string
}): Promise<OptionsOutcome<KernelReport>> {
  try {
    const search = new URLSearchParams({ underlying: query.underlying })
    if (query.expiryMonths !== undefined && query.expiryMonths.length > 0) {
      search.set('expiryMonths', query.expiryMonths.join(','))
    }
    if (query.asOf !== undefined) search.set('asOf', query.asOf)
    if (query.rate !== undefined) search.set('rate', String(query.rate))
    if (query.dividendYield !== undefined) search.set('dividendYield', String(query.dividendYield))
    if (query.source !== undefined) search.set('source', query.source)
    const wire = await getJson<{ ok: boolean; volAnalytics: KernelReport }>(
      `/dshtrading/api/options/vol-analytics?${search.toString()}`,
    )
    if (wire.volAnalytics === undefined) return optionsFailure(new Error('volAnalytics missing in wire'))
    return { ok: true, data: wire.volAnalytics }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 组合策略/保证金计算（义务仓保证金预估：单腿 legs=[{kind:'option',side,qty,code}]）。 */
export async function fetchOptionStrategy(request: OptionStrategyRequest): Promise<OptionsOutcome<OptionStrategyResult>> {
  try {
    const response = await fetch('/dshtrading/api/options/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const wire = await response.json().catch(() => undefined) as
      | { ok?: boolean; strategy?: OptionStrategyResult; code?: string; message?: string }
      | undefined
    if (!response.ok || wire?.ok !== true || wire.strategy === undefined) {
      const code = wire?.code ?? `HTTP_${response.status}`
      return { ok: false, code, message: wire?.message ?? code }
    }
    return { ok: true, data: wire.strategy }
  } catch (err) {
    return optionsFailure(err)
  }
}

/** 期权下单回执：error 带 code（双闸拒绝 TRADING_LIVE_TRADING_DISABLED 原文展示）。 */
export interface OptionOrderCallResult {
  order?: OptionOrder
  error?: { code: string; message: string }
}

/**
 * GUI 期权下单（阶段 3 T 板直接下单）。默认请求实盘（dryRun: false，与现货交易台
 * 一致）；安全由服务缝双闸 fail-closed 兜底——连接器 dryRun 缺省 true（本地模拟
 * 回执）、实盘需宿主显式开 liveTrading。闸门拒绝原文转达，不在 UI 层伪造 dry-run 成功。
 * 回执 premiumAmount 已换算为权利金金额（元），勿再乘 multiplier。
 */
export async function placeOptionOrder(input: {
  symbol: string
  side: 'buy' | 'sell'
  offset: 'open' | 'close'
  orderType: 'limit' | 'market'
  quantity: number
  price?: number
}): Promise<OptionOrderCallResult> {
  try {
    const response = await fetch('/dshtrading/api/options/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, dryRun: false }),
    })
    const wire = await response.json().catch(() => ({})) as
      | { ok?: boolean; order?: OptionOrder; code?: string; message?: string }
    if (!response.ok || wire.ok !== true || wire.order === undefined) {
      const code = wire.code ?? `HTTP_${response.status}`
      const message = wire.message || code
      console.warn('[dsh-trading] option order rejected:', code, wire.message)
      return { error: { code, message } }
    }
    return { order: wire.order }
  } catch (err) {
    return { error: { code: 'TRADING_UNKNOWN', message: err instanceof Error ? err.message : 'Network request failed' } }
  }
}

/** GUI 期权撤单（与真实下单同门槛：liveTrading=true 且 dryRun=false）。 */
export async function cancelOptionOrder(orderId: string, symbol?: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id: orderId, ...(symbol !== undefined ? { symbol } : {}) })
    const response = await fetch(`/dshtrading/api/options/order?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; canceled?: boolean }
    return wire.ok === true && wire.canceled === true
  } catch {
    return false
  }
}

/** 期权持仓（只读透传，不走闸门）。quantity 正 = 权利仓、负 = 义务仓。 */
export async function fetchOptionPositions(): Promise<OptionsOutcome<readonly OptionPosition[]>> {
  try {
    const wire = await getJson<{ ok: boolean; positions: readonly OptionPosition[] }>(
      '/dshtrading/api/options/positions',
    )
    return { ok: true, data: Array.isArray(wire.positions) ? wire.positions : [] }
  } catch (err) {
    return optionsFailure(err)
  }
}

/* ------------------------------------------------------------------ */
/* 期权纸账户（多账本：strategy 策略 / arbitrage 套利，2026-09-13 WB-15）    */
/* ------------------------------------------------------------------ */

/**
 * 期权纸账户成交流水默认条数（桥端 `limit` 缺省值，两侧必须一致）。
 * 语义是「最近 N 笔」，不是分页——面板只要一屏流水，不做翻页。
 */
export const OPTION_PAPER_FILLS_LIMIT = 48

/**
 * 两账本一次拉全（资产面板主入口）。桥按 `[arbitrage, strategy]` 顺序回，
 * 账本缺一（例如只有 strategy 落过盘）也不补桩：按返回如实渲染。
 *
 * 走 `OptionsOutcome` 分诊信封——「桥未挂」与「有账本但为空」必须能分开，
 * 否则资产面板会把 404 画成「权益 0」，那是把故障显示成事实。
 */
export async function fetchOptionPaperAccounts(): Promise<OptionsOutcome<OptionPaperAccountsWire>> {
  try {
    const wire = await getJson<OptionPaperAccountsWire>('/dshtrading/api/options/paper/accounts')
    return { ok: true, data: { ok: true, books: Array.isArray(wire.books) ? wire.books : [] } }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 单账本视图（`book` 缺省 strategy，与桥一致）。
 * 重置后用它的回包刷新卡片，省一次往返。
 */
export async function fetchOptionPaperAccount(book?: OptionPaperBookId): Promise<OptionsOutcome<OptionPaperBookWire>> {
  try {
    const search = new URLSearchParams()
    if (book !== undefined) search.set('book', book)
    const query = search.toString()
    const wire = await getJson<OptionPaperBookWire>(
      `/dshtrading/api/options/paper/account${query === '' ? '' : `?${query}`}`,
    )
    if (wire.account === undefined) return optionsFailure(new Error('account missing in wire'))
    return { ok: true, data: { ok: true, book: wire.book, account: wire.account, equity: wire.equity, positions: wire.positions ?? [] } }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 成交流水（倒序，最新在前；`limit` 正整数，非正整数桥回 400）。
 *
 * 只返回 `fills`（不带 wire 包裹）：调用方要的是一屏流水，账本元信息
 * 由 `fetchOptionPaperAccounts` 提供，重复拉一遍账户是纯浪费。
 */
export async function fetchOptionPaperFills(
  book?: OptionPaperBookId,
  limit: number = OPTION_PAPER_FILLS_LIMIT,
): Promise<OptionsOutcome<readonly PaperFill[]>> {
  try {
    const search = new URLSearchParams({ limit: String(limit) })
    if (book !== undefined) search.set('book', book)
    const wire = await getJson<{ ok: boolean; fills: readonly PaperFill[] }>(
      `/dshtrading/api/options/paper/fills?${search.toString()}`,
    )
    return { ok: true, data: Array.isArray(wire.fills) ? wire.fills : [] }
  } catch (err) {
    return optionsFailure(err)
  }
}

/**
 * 重置单个账本回初始资金（10 万）。**破坏性操作**：调用方必须先做二次确认，
 * 本封装不做任何确认——保持「api 只搬数据」的分层。
 *
 * 账本经 query 传递（桥 `search.get('book') ?? body.book` 两条路都收，
 * 这里选 query：reset 语义上是「对某个资源动手」，不是提交表单）。
 */
export async function resetOptionPaper(book?: OptionPaperBookId): Promise<OptionsOutcome<OptionPaperBookWire>> {
  try {
    const search = new URLSearchParams()
    if (book !== undefined) search.set('book', book)
    const query = search.toString()
    const response = await fetch(
      `/dshtrading/api/options/paper/reset${query === '' ? '' : `?${query}`}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    const wire = await response.json().catch(() => undefined) as
      | { ok?: boolean; book?: OptionPaperBookId; account?: OptionPaperBookWire['account']; equity?: number; positions?: readonly OptionPaperBookWire['positions'][number][]; code?: string; message?: string }
      | undefined
    if (!response.ok || wire?.ok !== true || wire?.account === undefined) {
      const code = wire?.code ?? `HTTP_${response.status}`
      return { ok: false, code, message: wire?.message ?? code }
    }
    return {
      ok: true,
      data: {
        ok: true,
        book: wire.book ?? book ?? 'strategy',
        account: wire.account,
        equity: wire.equity ?? wire.account.cash,
        positions: wire.positions ?? [],
      },
    }
  } catch (err) {
    return optionsFailure(err)
  }
}

/* ------------------------------------------------------------------ */
/* 交易台（issue #40）：只读查询 + 强制 dry-run 下单                        */
/* ------------------------------------------------------------------ */

/**
 * 交易只读面的不可用原因（2026-09-04）：此前 400（服务未挂）与 TRADING_CREDENTIALS_MISSING
 * 都被吞成 null，分区一律显示「凭证未配置」——把服务缺失误导成配置问题。
 */
export type TradeRowsReason = 'ok' | 'no-trade-service' | 'credentials-missing' | 'unavailable'

export interface TradeRowsResult<Row> {
  /** 行数据；null = 不可用（原因见 reason）。 */
  rows: Row[] | null
  reason: TradeRowsReason
}

/** BridgeError → 分区语义原因映射（老部署无 code 时按 400 状态回退判服务未挂）。 */
export function tradeRowsReasonOf(error: unknown): TradeRowsReason {
  if (error instanceof BridgeError) {
    if (error.code === 'TRADING_NO_TRADE_SERVICE' || error.status === 400) return 'no-trade-service'
    if (error.code === 'TRADING_CREDENTIALS_MISSING') return 'credentials-missing'
  }
  return 'unavailable'
}

/** 持仓快照。交易服务未挂（400）→ no-trade-service；凭证缺失 → credentials-missing。 */
export async function fetchTradePositions(market: MarketId): Promise<TradeRowsResult<Position>> {
  try {
    const wire = await getJson<{ ok: boolean; positions: Position[] }>(`/dshtrading/api/trade/positions?market=${market}`)
    return { rows: Array.isArray(wire.positions) ? wire.positions : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

/** 余额快照（可选面）。未实现/失败 → unavailable；服务未挂/凭证缺失同持仓语义。 */
export async function fetchTradeBalances(market: MarketId): Promise<TradeRowsResult<AccountBalance>> {
  try {
    const wire = await getJson<{ ok: boolean; balances: AccountBalance[] }>(`/dshtrading/api/trade/balances?market=${market}`)
    return { rows: Array.isArray(wire.balances) ? wire.balances : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

/** 当前挂单（可选面）。未实现/失败 → unavailable（rows null）。 */
export async function fetchTradeOpenOrders(market: MarketId): Promise<TradeRowsResult<Order>> {
  try {
    const wire = await getJson<{ ok: boolean; orders: Order[] }>(`/dshtrading/api/trade/orders?market=${market}`)
    return { rows: Array.isArray(wire.orders) ? wire.orders : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

/** 最近成交流水（可选面）。未实现/失败 → unavailable（rows null）。 */
export async function fetchTradeFills(market: MarketId): Promise<TradeRowsResult<TradeFill>> {
  try {
    const wire = await getJson<{ ok: boolean; fills: TradeFill[] }>(`/dshtrading/api/trade/fills?market=${market}`)
    return { rows: Array.isArray(wire.fills) ? wire.fills : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

export interface GuiOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  quantity: number
  price?: number | undefined
}

export interface GuiOrderResult {
  order?: Order
  error?: string
}

/**
 * GUI 实盘下单（只做真交易）：直接打到连接器报单。返回订单或失败原因。
 */
export async function placeGuiOrder(market: MarketId, input: GuiOrderInput): Promise<GuiOrderResult> {
  try {
    const response = await fetch(`/dshtrading/api/trade/order?market=${market}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, dryRun: false }),
    })
    const wire = await response.json().catch(() => ({})) as { ok?: boolean; order?: Order; code?: string; message?: string }
    if (!response.ok || wire.ok !== true || wire.order === undefined) {
      const msg = wire.message || wire.code || 'Order rejected or service not mounted'
      console.warn('[dsh-trading] gui order rejected:', wire.code, wire.message)
      return { error: msg }
    }
    return { order: wire.order }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network request failed' }
  }
}

/** 兼容别名 */
export async function placeGuiDryRunOrder(market: MarketId, input: GuiOrderInput): Promise<Order | null> {
  const res = await placeGuiOrder(market, input)
  return res.order ?? null
}

/** GUI 撤单（issue #40）：DELETE /trade/order?market&id&symbol */
export async function cancelGuiOrder(market: MarketId, orderId: string, symbol?: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ market, id: orderId, ...(symbol ? { symbol } : {}) })
    const response = await fetch(`/dshtrading/api/trade/order?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; canceled?: boolean }
    return wire.ok === true && wire.canceled === true
  } catch {
    return false
  }
}

/** 动态全集标的名册（Issue #15）：可传 q 进行上游在线检索。未支持或失败时回退空数组。 */
export async function fetchSymbols(market: MarketId, q?: string): Promise<Array<{ symbol: string; name?: string }>> {
  const query = new URLSearchParams({ market, ...(q ? { query: q } : {}) })
  const wire = await getJson<{ symbols: Array<{ symbol: string; name?: string }> }>(`/dshtrading/api/symbols?${query.toString()}`)
  return Array.isArray(wire.symbols) ? wire.symbols : []
}

/** 拉取自定义指标列表（Issue #19）。 */
export async function fetchCustomIndicators(): Promise<CustomIndicatorRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; indicators: CustomIndicatorRecord[] }>('/dshtrading/api/indicators/custom')
    return Array.isArray(wire.indicators) ? wire.indicators : []
  } catch {
    return []
  }
}

/** 删除自定义指标。 */
export async function deleteCustomIndicator(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/indicators/custom?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 拉取知识库卡片全集列表（Issue #24）。 */
export async function fetchKnowledgeCards(): Promise<KnowledgeCard[]> {
  try {
    const wire = await getJson<{ ok: boolean; cards: KnowledgeCard[] }>('/dshtrading/api/knowledge/cards')
    return Array.isArray(wire.cards) ? wire.cards : []
  } catch (err) {
    console.warn('[dsh-trading] fetchKnowledgeCards failed, fallback to empty:', err)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 新闻情报流（issue #37）                                                */
/* ------------------------------------------------------------------ */

export interface ClientNewsItem {
  source: string
  title: string
  url: string
  publishedAt: string
}

export interface ClientNewsResult {
  items: ClientNewsItem[]
  unavailable: string[]
}

/**
 * 标的新闻（issue #37）。Kit 未注册或会话不活跃 → null：面板显示空态提示。
 * 只返回与标的相关的条目；无相关内容即空列表，无市场要闻兜底。
 */
export async function fetchNews(market: MarketId, symbol?: string, limit = 20, signal?: AbortSignal): Promise<ClientNewsResult | null> {
  try {
    const query = new URLSearchParams({ market, ...(symbol ? { symbol } : {}), limit: String(limit) })
    const wire = await getJson<{ ok: boolean; items: ClientNewsItem[]; unavailable: string[] }>(
      `/dshtrading/api/news?${query.toString()}`, signal,
    )
    return { items: wire.items ?? [], unavailable: wire.unavailable ?? [] }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* SSE 失效信号订阅（issue #30 / P1）                                        */
/* ------------------------------------------------------------------ */

/** 拉取自定义策略名册（issue #31，桥 /strategies/custom；前端校验后并入名册）。 */
export async function fetchCustomStrategies(): Promise<CustomStrategyRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; strategies: CustomStrategyRecord[] }>('/dshtrading/api/strategies/custom')
    return Array.isArray(wire.strategies) ? wire.strategies : []
  } catch (err) {
    console.warn('[dsh-trading] fetchCustomStrategies failed, fallback to empty:', err)
    return []
  }
}

/** 删除策略（策略管理）：自定义移除 / 内置落墓碑，均返回是否生效。 */
export async function deleteCustomStrategy(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/strategies/custom?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 保存（新增/覆盖）自定义策略（策略管理）：桥侧 vm 沙箱校验通过才落盘。 */
export async function saveCustomStrategy(input: {
  id: string
  title: string
  horizon: string
  summary: string
  paramsJson: string
  computeSource: string
  overridesBuiltin?: boolean
}): Promise<{ ok: true; overridesBuiltin: boolean } | { ok: false; reason: string } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/custom', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; message?: string; overridesBuiltin?: boolean }
    if (wire.ok === true) return { ok: true, overridesBuiltin: wire.overridesBuiltin === true }
    return { ok: false, reason: wire.message ?? 'validation failed' }
  } catch (err) {
    console.warn('[dsh-trading] saveCustomStrategy failed:', err)
    return null
  }
}

/** 恢复内置策略出厂默认（策略管理）：清覆盖记录与墓碑。 */
export async function resetStrategy(id: string): Promise<{ ok: boolean; changed: boolean } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; changed?: boolean }
    return { ok: wire.ok === true, changed: wire.changed === true }
  } catch (err) {
    console.warn('[dsh-trading] resetStrategy failed:', err)
    return null
  }
}

/** 内置删除墓碑清单（策略管理）：GUI 据此展示灰卡与恢复入口。 */
export async function fetchStrategyTombstones(): Promise<string[]> {
  try {
    const wire = await getJson<{ ok: boolean; deleted: string[] }>('/dshtrading/api/strategies/tombstones')
    return Array.isArray(wire.deleted) ? wire.deleted : []
  } catch (err) {
    console.warn('[dsh-trading] fetchStrategyTombstones failed, fallback to empty:', err)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 自定义选股器（选股器管理，2026-09-07）                                     */
/* ------------------------------------------------------------------ */

/** 拉取自定义选股器名册（含内置覆盖记录；前端校验后并入名册）。 */
export async function fetchCustomScreeners(): Promise<CustomScreenerRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; screeners: CustomScreenerRecord[] }>('/dshtrading/api/strategies/screeners')
    return Array.isArray(wire.screeners) ? wire.screeners : []
  } catch (err) {
    console.warn('[dsh-trading] fetchCustomScreeners failed, fallback to empty:', err)
    return []
  }
}

/** 保存（新增/覆盖）自定义选股器：桥侧 vm 沙箱校验通过才落盘。 */
export async function saveCustomScreener(input: {
  id: string
  title: string
  summary: string
  paramsJson: string
  columnsJson: string
  evaluateSource: string
  overridesScreener?: boolean
}): Promise<{ ok: true; overridesScreener: boolean } | { ok: false; reason: string } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/screeners', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; message?: string; overridesScreener?: boolean }
    if (wire.ok === true) return { ok: true, overridesScreener: wire.overridesScreener === true }
    return { ok: false, reason: wire.message ?? 'validation failed' }
  } catch (err) {
    console.warn('[dsh-trading] saveCustomScreener failed:', err)
    return null
  }
}

/** 删除选股器（选股器管理）：自定义移除 / 内置落墓碑，均返回是否生效。 */
export async function deleteCustomScreener(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/strategies/screeners?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 恢复内置选股器出厂默认（选股器管理）：清覆盖记录与墓碑。 */
export async function resetScreener(id: string): Promise<{ ok: boolean; changed: boolean } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/screeners/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; changed?: boolean }
    return { ok: wire.ok === true, changed: wire.changed === true }
  } catch (err) {
    console.warn('[dsh-trading] resetScreener failed:', err)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 自选股 + 选中标的（issue #32 / P3）：host store 为 SSOT                  */
/* ------------------------------------------------------------------ */

/** host 侧自选行（WatchlistsMap：market → 行数组；不含客户端种子回退）。 */
export type HostWatchlists = Record<string, Array<{ market: string; symbol: string; name?: string }>>

/** 读取 host 自选全量（启动同步与 SSE 重拉）。 */
export async function fetchHostWatchlists(): Promise<HostWatchlists> {
  try {
    const wire = await getJson<{ ok: boolean; watchlists: HostWatchlists }>('/dshtrading/api/watchlists')
    return wire.watchlists ?? {}
  } catch (err) {
    console.warn('[dsh-trading] fetchHostWatchlists failed, fallback to local mirror:', err)
    throw err instanceof BridgeError ? err : new BridgeError(0, 'watchlists unavailable')
  }
}

/** 追加一行（POST /watchlists）。 */
export async function addHostWatchlistRow(instrument: { market: string; symbol: string; name?: string }): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(instrument),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 移除一行（DELETE /watchlists?market&symbol）。 */
export async function removeHostWatchlistRow(market: string, symbol: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const response = await fetch(`/dshtrading/api/watchlists?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 一次性迁移导入（POST /watchlists/import；host 非空时服务端拒绝，幂等）。 */
export async function importHostWatchlists(rows: HostWatchlists): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlists/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchlists: rows }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 读取 host 选中标的（GET /selection）。 */
export async function fetchHostSelection(): Promise<{ market: string; symbol: string; name?: string } | null> {
  try {
    const wire = await getJson<{ ok: boolean; instrument: { market: string; symbol: string; name?: string } | null }>('/dshtrading/api/selection')
    return wire.instrument ?? null
  } catch {
    return null
  }
}

/** 设置 host 选中标的（PUT /selection；watchlist_select 工具与左栏点击同源）。 */
export async function putHostSelection(instrument: { market: string; symbol: string; name?: string } | null): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/selection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instrument }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 图表激活名册 host SSOT（issue #63）                                      */
/* ------------------------------------------------------------------ */

/** 全量读取 host 激活名册（GET /chart/indicators）。 */
export async function fetchChartActivations(): Promise<IndicatorInstance[]> {
  try {
    const wire = await getJson<{ ok: boolean; instances: IndicatorInstance[] }>('/dshtrading/api/chart/indicators')
    return Array.isArray(wire.instances) ? wire.instances : []
  } catch {
    return []
  }
}

/**
 * 挂载/更新一个激活实例（PUT /chart/indicators；未知 id → ok:false，转 false）。
 * issue #72：带 scope（market+symbol）时写该标的的参数覆盖，不动全局 params。
 * symbol visibility：scope 带 visible 时为可见性写（market 必带，symbol 可选——
 * 缺省即整市场），params 缺省。
 */
export async function putChartActivation(
  id: string,
  params?: Record<string, number>,
  scope?: { market: string; symbol?: string; visible?: boolean },
): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/chart/indicators', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        ...(params !== undefined ? { params } : {}),
        ...(scope !== undefined ? {
          market: scope.market,
          ...(scope.symbol !== undefined ? { symbol: scope.symbol } : {}),
          ...(scope.visible !== undefined ? { visible: scope.visible } : {}),
        } : {}),
      }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 摘除一个激活实例（DELETE /chart/indicators?id=）。 */
export async function removeChartActivation(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/chart/indicators?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 一次性迁移导入本地激活名册（POST /chart/indicators/import；host 非空拒绝 → false）。 */
export async function importChartActivations(instances: IndicatorInstance[]): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/chart/indicators/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; imported?: boolean }
    return wire.ok === true && wire.imported === true
  } catch {
    return false
  }
}

/**
 * store 词汇（v1）：镜像 host 半 @dshtrading/eventbus 的 TradingEventStore.
 * 浏览器半不 import node 包（避免把 cordis 拖进 client bundle）——词汇是封闭
 * 小集合，镜像漂移的代价是 handler 不触发（降级为现状），可接受。
 */
export type TradingEventStoreName =
  | 'indicators'
  | 'strategies'
  | 'knowledge'
  | 'watchlists'
  | 'selection'
  | 'routing'
  | 'chart'
  | 'tasks'
  | 'holdings'

type TradingEventHandlers = Partial<Record<TradingEventStoreName, () => void>>

/** 模块级单例：多视图共享一条 EventSource 连接（多标签页各自一条，天然隔离）。 */
let tradingEventSource: EventSource | null = null
const tradingEventListeners = new Set<(store: TradingEventStoreName) => void>()

function ensureTradingEventSource(): void {
  if (tradingEventSource !== null) return
  // 无 EventSource（老浏览器/非 web 环境）→ 一次性 fetch 的现状兜底。
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
  const source = new EventSource('/dshtrading/api/events')
  source.addEventListener('store.changed', (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data as string) as { store?: string }
      if (typeof data.store !== 'string') return
      for (const listener of [...tradingEventListeners]) listener(data.store as TradingEventStoreName)
    } catch {
      /* 坏帧忽略（总线只发 JSON 信号，正常不会发生） */
    }
  })
  source.onerror = () => {
    /* EventSource 原生自动重连；桥未挂载（503）时持续失败 = 降级现状，不打扰用户 */
  }
  tradingEventSource = source
}

/**
 * 订阅失效信号：store 名 → refetch 回调。返回退订函数；最后一个订阅者退订时
 * 关闭连接（视图互斥挂载下 quote/strategy/knowledge 轮流订阅不堆积）。
 */
export function subscribeTradingEvents(handlers: TradingEventHandlers): () => void {
  ensureTradingEventSource()
  const listener = (store: TradingEventStoreName): void => { handlers[store]?.() }
  tradingEventListeners.add(listener)
  return () => {
    tradingEventListeners.delete(listener)
    if (tradingEventListeners.size === 0 && tradingEventSource !== null) {
      tradingEventSource.close()
      tradingEventSource = null
    }
  }
}

/**
 * 更新提示点（自动更新插件 @dshtrading/client-ui-updater 的桥状态）：
 * GET /dshtrading/api/updater/state，仅取 available 布尔。桥缺席（老部署/
 * headless 404）→ null（点永不亮，不报错横幅）。
 */
export interface UpdateBadgeState {
  available: boolean
  version?: string
}

export async function fetchUpdateBadge(): Promise<UpdateBadgeState | null> {
  try {
    const wire = await getJson<{
      environment?: { supported?: boolean }
      check?: { available?: boolean, latest?: { version?: string } }
    }>('/dshtrading/api/updater/state')
    if (wire.environment?.supported !== true) return { available: false }
    return {
      available: wire.check?.available === true,
      ...(wire.check?.latest?.version === undefined ? {} : { version: wire.check.latest.version }),
    }
  } catch {
    return null
  }
}

/** 拉取标的综合基本面与多期财务矩阵数据（Issue #36，富途牛牛风格工作台数据源）。 */
export async function fetchFundamentals(market: MarketId, symbol: string, signal?: AbortSignal): Promise<FundamentalsPackage | undefined> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; fundamentals?: FundamentalsPackage }>(`/dshtrading/api/fundamentals?${query.toString()}`, signal)
    return wire.fundamentals
  } catch (err) {
    console.warn(`[dsh-trading] fetchFundamentals ${market}/${symbol} failed:`, err)
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* 统一资产台账（Issue #65，契约 §3）：导入持仓 CRUD + staged 待确认区 + FX   */
/* ------------------------------------------------------------------ */

/**
 * 持仓台账快照（staged 待确认区 + holdings 正式区 + revision）。
 * 桥缺席/老部署/失败 → null：imported 源静默降级为空，不报错横幅。
 */
export async function fetchHoldings(): Promise<HoldingsBookSnapshot | null> {
  try {
    const wire = await getJson<{ ok: true; revision: number; staged?: unknown[]; holdings?: unknown[] }>('/dshtrading/api/holdings')
    return {
      revision: typeof wire.revision === 'number' ? wire.revision : 0,
      staged: Array.isArray(wire.staged) ? wire.staged as HoldingsBookSnapshot['staged'] : [],
      holdings: Array.isArray(wire.holdings) ? wire.holdings as HoldingsBookSnapshot['holdings'] : [],
    }
  } catch {
    return null
  }
}

/** 写操作统一 POST/PUT 助手：成功 → revision；业务拒绝/网络失败 → null。 */
async function postHoldingsJson(path: string, method: 'POST' | 'PUT', body: unknown): Promise<{ revision: number; id?: string } | null> {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const wire = await response.json().catch(() => ({})) as { ok?: boolean; revision?: number; id?: string; code?: string; message?: string }
    if (!response.ok || wire.ok !== true || typeof wire.revision !== 'number') {
      console.warn('[dsh-trading] holdings write rejected:', wire.code, wire.message)
      return null
    }
    return typeof wire.id === 'string'
      ? { revision: wire.revision, id: wire.id }
      : { revision: wire.revision }
  } catch {
    return null
  }
}

/** staged 待确认区入库（Agent 截图解析的唯一写入口；UI 不直接调，agent 工具走宿主）。 */
export async function stageHoldings(items: NewHoldingInput[]): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings/stage', 'POST', { items })
  return res?.revision ?? null
}

/** 确认 staged 入账（可带逐条编辑）；返回新 revision。 */
export async function confirmHoldings(ids: string[], edits?: Record<string, Partial<NewHolding>>): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings/confirm', 'POST', edits === undefined ? { ids } : { ids, edits })
  return res?.revision ?? null
}

/** 丢弃 staged 条目。 */
export async function discardHoldings(ids: string[]): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings/discard', 'POST', { ids })
  return res?.revision ?? null
}

/** 手动新增一条导入持仓（直入正式区）；成功返回 { revision, id }。 */
export async function addHolding(item: NewHoldingInput): Promise<{ revision: number; id: string } | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings', 'POST', item)
  return res !== null && typeof res.id === 'string' ? { revision: res.revision, id: res.id } : null
}

/** 编辑一条导入持仓。 */
export async function updateHolding(id: string, patch: Partial<NewHolding>): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings', 'PUT', { id, patch })
  return res?.revision ?? null
}

/** 删除一条导入持仓（DELETE /holdings?id=）。 */
export async function removeHolding(id: string): Promise<number | null> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/holdings?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; revision?: number }
    return wire.ok === true && typeof wire.revision === 'number' ? wire.revision : null
  } catch {
    return null
  }
}

/**
 * FX 汇率快照（GET /fx?base=；rates[c] = 1 单位 c 折合多少 base）。
 * 桥缺席/失败 → null：聚合引擎降级为「一切不折算 + 未折算分区」。
 */
export async function fetchFx(base: HoldingsBaseCurrency): Promise<FxSnapshot | null> {
  try {
    const query = new URLSearchParams({ base })
    const wire = await getJson<{ ok: true; base: string; rates: Record<string, number>; asOf: number; stale: boolean }>(
      `/dshtrading/api/fx?${query.toString()}`,
    )
    return {
      base: (wire.base === 'USD' || wire.base === 'HKD' ? wire.base : 'CNY') as HoldingsBaseCurrency,
      rates: wire.rates ?? {},
      asOf: typeof wire.asOf === 'number' ? wire.asOf : 0,
      stale: wire.stale === true,
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* tradingBridge client 服务（issue #34 / P5）                              */
/* ------------------------------------------------------------------ */

/**
 * 中栏视图包（client-ui-strategies / client-ui-knowledge 及未来的第三方视图）
 * 对桥的唯一依赖面。收口为 cordis client 服务（provide 'tradingBridge'），
 * 原因有二：
 * 1. 插件间协作必须走服务 inject（一切皆插件裁决——client 插件间不得 import
 *    彼此内部模块）；
 * 2. SSE 单例与 fetch 封装留在 shell 内（本模块），多视图包共享同一条
 *    EventSource 连接——各包自开连接会随拆包数量线性堆积。
 *
 * 视图包不 import 本模块；未安装 shell 时 inject 回调不触发，视图静默不注册
 * （可选依赖语义）。
 */
export interface TradingBridgeService {
  fetchKlines: typeof fetchKlines
  fetchCustomStrategies: typeof fetchCustomStrategies
  saveCustomStrategy: typeof saveCustomStrategy
  deleteCustomStrategy: typeof deleteCustomStrategy
  resetStrategy: typeof resetStrategy
  fetchStrategyTombstones: typeof fetchStrategyTombstones
  fetchCustomScreeners: typeof fetchCustomScreeners
  saveCustomScreener: typeof saveCustomScreener
  deleteCustomScreener: typeof deleteCustomScreener
  resetScreener: typeof resetScreener
  fetchKnowledgeCards: typeof fetchKnowledgeCards
  fetchFundamentals: typeof fetchFundamentals
  fetchNews: typeof fetchNews
  fetchSymbols: typeof fetchSymbols
  subscribeTradingEvents: typeof subscribeTradingEvents
}

/* ------------------------------------------------------------------ *
 * 壳 / 宿主能力（P0-2，2026-09-12）
 * ------------------------------------------------------------------ */

/**
 * 「打开设置」契约事件名。与 node 半 `src/shell-settings.ts` 的 `OPEN_SETTINGS_EVENT`
 * **必须字面相同**——跨半契约不走 import（client 半零跨半 import，避免把 node 半模块
 * 打进浏览器 bundle），漂移由 `test/shell-open-settings.test.ts` 断言两边相等兜底。
 */
export const OPEN_SETTINGS_EVENT = 'dshtrading:open-settings' as const

/** 「打开设置」结果：宿主服务可用 / 上游能力缺口 / 桥不可达。 */
export type OpenSettingsOutcome =
  | { ok: true; via: 'settings.open' | 'ui.openSettings' }
  | { ok: false; reason: 'unsupported' | 'unreachable'; code?: string; message?: string }

/**
 * 请求宿主打开设置（POST /shell/open-settings）。node 半先探测宿主服务
 * （`settings.open` → `ui.openSettings`），都没有时返 501 `SETTINGS_OPEN_UNSUPPORTED`。
 *
 * 超时护栏（1.2s）：宿主服务调用走得是一条本地 HTTP 往返，正常 <1ms；但桥整体挂起时
 * 不能把「点设置」永久挂住——超时按 `unreachable` 处理，调用方据此退回 DOM 触发器。
 */
export async function requestOpenSettings(): Promise<OpenSettingsOutcome> {
  try {
    const response = await fetch('/dshtrading/api/shell/open-settings', {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(1200),
    })
    const wire = await response.json().catch(() => undefined) as
      | { ok?: boolean; invoked?: boolean; via?: string; code?: string; message?: string }
      | undefined
    const via = wire?.via
    if (response.ok && wire?.ok === true && wire.invoked === true && (via === 'settings.open' || via === 'ui.openSettings')) {
      return { ok: true, via }
    }
    const code = wire?.code ?? `HTTP_${response.status}`
    const message = wire?.message
    // 501 + SETTINGS_OPEN_UNSUPPORTED = 宿主确实没这个能力（上游缺口，属预期分支）；
    // 其余非 2xx（404 旧 node 半、5xx、超时）都算桥不可达——两者对调用方都意味着「退回 DOM」，
    // 但分开上报便于在 console 里区分「宿主缺 API」与「桥坏了」。
    const reason = response.status === 501 && code === 'SETTINGS_OPEN_UNSUPPORTED' ? 'unsupported' : 'unreachable'
    return { ok: false, reason, code, ...(message === undefined ? {} : { message }) }
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: err instanceof Error ? err.message : String(err) }
  }
}

/** 服务装配（shell apply 时以本模块函数 provide，零转发成本）。 */
export function createTradingBridgeService(): TradingBridgeService {
  return {
    fetchKlines,
    fetchCustomStrategies,
    saveCustomStrategy,
    deleteCustomStrategy,
    resetStrategy,
    fetchStrategyTombstones,
    fetchCustomScreeners,
    saveCustomScreener,
    deleteCustomScreener,
    resetScreener,
    fetchKnowledgeCards,
    fetchFundamentals,
    fetchNews,
    fetchSymbols,
    subscribeTradingEvents,
  }
}
