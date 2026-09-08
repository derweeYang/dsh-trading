/**
 * 腾讯公共行情客户端（dsh-trading cn 市场切片）——cn 单市场的数据面。
 *
 * 独立于插件 glue：仅依赖 @dshtrading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。
 *
 * 数据面（2026-08-31 本出口实测，原始证据 spikes/impl-cn-hk/r1-*.raw / r2-*.json）：
 *   - 实时报价：GET https://qt.gtimg.cn/q=<wire>。响应 **GBK 编码**（content-type:
 *     text/html; charset=GBK）——必须 TextDecoder('gbk') 解码，UTF-8 解出中文乱码。
 *     body 形如 `v_sh600519="1~贵州茅台~600519~1297.40~..."`，`~` 分隔，字段布局
 *     详见 parseCnTicker 注释。
 *   - 日/周/月 K：GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get
 *     ?param=<code>,<tf>,,,<count>,qfq → JSON data.<code>.qfq<day|week|month>。
 *     行字段序是 **开收高低量**（open,close,high,low,volume）——与 OHLC 直觉相反，
 *     解析错序 K 线整体失真。
 *   - 分钟 K（m5/m30）：GET https://ifzq.gtimg.cn/appstock/app/kline/mkline
 *     ?param=<code>,<tf>,,<count> → JSON data.<code>.m5/m30，行首 6 元素同开收
 *     高低量布局，时间戳为 `YYYYMMDDHHmm`（Asia/Shanghai 墙钟）。
 *
 * 合规（README 铁律 #5）：腾讯公共行情端点、无 key、无官方授权；个人使用边界自负，
 * 本仓不缓存、不再分发行情数据（详见 README 数据源节）。
 *
 * @module @dshtrading/connector-tencent/rest
 */

import type { Interval, Kline, Orderbook, OrderbookLevel, StockFundamentals, Ticker, TradingErrorCode } from '@dshtrading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射，与 connector-stooq 同构）               */
/* ------------------------------------------------------------------ */

/** api 包 TradingError 契约的运行时 Error 实现。 */
export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/* ------------------------------------------------------------------ */
/* 符号规范化                                                                */
/* ------------------------------------------------------------------ */

// 规范词汇（docs/symbol-vocabulary.md）：接受 600519.SH / 600519.sh / SH600519 / 裸 6 位。
const CN_SYMBOL_PATTERN = /^(?:(sh|sz)(\d{6})|(\d{6})(?:\.(sh|sz))?)$/
// 常见知名上海指数代码（深交所无对应证券，裸 6 位数字时推断为 sh）
const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

/**
 * 规范化 A 股符号：接受 `600519` / `SH600519` / `sh600519` / `sz000001`，统一为
 * 腾讯 wire 形态小写 `<sh|sz><6位数字>`。6/9 开头→sh（沪，含科创板 688），5 开头→sh（沪市基金/ETF），
 * 0/3 开头→sz（深，含创业板 300；知名上海指数 000688/000300 等推断为 sh）。4/8 开头（北交所）不在本切片支持范围。
 */
export function normalizeCnSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. 600519 / SH600519 / sz000001',
    )
  }
  const raw = symbol.trim().toLowerCase()
  const m = CN_SYMBOL_PATTERN.exec(raw)
  if (!m) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid CN A-share symbol (expected 6-digit code, optionally SH/SZ prefixed)`,
    )
  }
  if (m[1]) return `${m[1]}${m[2]}` // 前缀形 sh600519
  const code = m[3] ?? ''
  if (!code) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid CN A-share symbol (expected 6-digit code, optionally SH/SZ prefixed)`,
    )
  }
  if (m[4]) return `${m[4]}${code}` // 规范形 600519.SH（后缀即交易所）
  const prefix =
    code.startsWith('6') || code.startsWith('9') || code.startsWith('5') || KNOWN_SH_INDICES.has(code)
      ? 'sh'
      : 'sz' // 裸码宽容输入：按首位及已知上海指数推断
  return `${prefix}${code}`
}

/**
 * 输出归一 → 规范形（docs/symbol-vocabulary.md）：cn wire 形 sh600519 → 600519.SH。
 * 下游永远看到市场规范词汇。
 */
export function toCanonicalTencentSymbol(wireOrCode: string): string {
  const m = /^(sh|sz)(\d{6})$/i.exec(wireOrCode)
  return m ? `${m[2]}.${(m[1] ?? '').toUpperCase()}` : wireOrCode
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* interval → 腾讯周期参数（日周月 fqkline / 分钟 mkline）              */
/* ------------------------------------------------------------------ */

export type TencentKlineType = 'fqkline' | 'mkline'

export interface TencentIntervalDef {
  readonly type: TencentKlineType
  readonly tf: string
  readonly key: string
  readonly durationMs: number
}

/** api Interval 词汇的受支持子集 → 腾讯 tf= 值与响应键。 */
const INTERVAL_TO_TENCENT: ReadonlyMap<Interval, TencentIntervalDef> = new Map([
  ['5m', { type: 'mkline', tf: 'm5', key: 'm5', durationMs: 5 * 60_000 }],
  ['30m', { type: 'mkline', tf: 'm30', key: 'm30', durationMs: 30 * 60_000 }],
  ['1d', { type: 'fqkline', tf: 'day', key: 'qfqday', durationMs: 86_400_000 }],
  ['1w', { type: 'fqkline', tf: 'week', key: 'qfqweek', durationMs: 7 * 86_400_000 }],
  ['1M', { type: 'fqkline', tf: 'month', key: 'qfqmonth', durationMs: 30 * 86_400_000 }],
])

/** 工具 parameters enum 用：受支持 interval 词汇。 */
export const INTERVAL_VOCABULARY: readonly string[] = [...INTERVAL_TO_TENCENT.keys()]

/* ------------------------------------------------------------------ */
/* 时间处理                                                                */
/* ------------------------------------------------------------------ */

/**
 * 分钟 K 线时间 `YYYYMMDDHHmm` → epoch ms（Asia/Shanghai 墙钟，12 位紧凑格式）。
 */
export function minuteKlineTimeToEpochMs(value: string, timeZone = 'Asia/Shanghai'): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent minute kline timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0)
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/** K 线日期 `YYYY-MM-DD` → epoch ms（UTC 当日零点锚定，行情日界语义，与 stooq 映射同构）。 */
export function klineDateToEpochMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent kline date ${JSON.stringify(date)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 交易所当地墙钟 → epoch ms（Intl 求时区偏移，含夏令时；同 stooq easternWallTimeToEpochMs
 * 的两轮逼近法，泛化时区参数）。cn 报价时间是 `YYYYMMDDHHMMSS`（Asia/Shanghai）。
 */
export function wallTimeToEpochMs(value: string, timeZone: string): number {
  // cn 报价时间是紧凑形态 YYYYMMDDHHMMSS——先归一化为 ISO 形再统一解析。
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  const normalized = (compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}`
    : value
  ).replace(/^(\d{4}-\d{2}-\d{2})$/, '$1T00:00:00')
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent quote timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi, s] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/* ------------------------------------------------------------------ */
/* 行解析                                                                  */
/* ------------------------------------------------------------------ */

/** 宽松转 number（非有限值返回 undefined）。 */
function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** cn 报价扩展字段（Ticker 契约的超集；风控 skill 用涨停/跌停价）。 */
export interface CnTickerExtra {
  readonly market: 'cn'
  readonly name: string
  readonly prevClose?: number
  readonly open?: number
  readonly high?: number
  readonly low?: number
  /** 涨停价（f47）。 */
  readonly limitUp?: number
  /** 跌停价（f48）。 */
  readonly limitDown?: number
  readonly change?: number
  readonly changePercent?: number
  readonly currency: 'CNY'
}

export type TencentTicker = Ticker & CnTickerExtra

/**
 * cn 报价字段布局（v_sh600519，2026-08-31 实测 sh600519，88 字段）：
 * 1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量(**手**) 9=买一价 19=卖一价
 * 30=时间 YYYYMMDDHHMMSS(Asia/Shanghai) 31=涨跌 32=涨跌% 33=最高 34=最低
 * 35="价/量(手)/额(元)" 47=涨停价 48=跌停价 82=币种(CNY)。
 */
function parseCnTicker(fields: string[], timestamp: number): TencentTicker {
  const price = num(fields[3])
  if (price === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Tencent CN ticker: missing/invalid price field')
  }
  const bid = num(fields[9])
  const ask = num(fields[19])
  const volumeLots = num(fields[6])
  return {
    market: 'cn',
    currency: 'CNY',
    name: fields[1] ?? '',
    symbol: String(fields[2] ?? ''),
    price,
    ...(bid !== undefined && bid > 0 ? { bid } : {}),
    ...(ask !== undefined && ask > 0 ? { ask } : {}),
    // cn 成交量单位是手（100 股）：统一归一到股。
    ...(volumeLots !== undefined ? { volume: volumeLots * 100 } : {}),
    timestamp,
    prevClose: num(fields[4]),
    open: num(fields[5]),
    high: num(fields[33]),
    low: num(fields[34]),
    limitUp: num(fields[47]),
    limitDown: num(fields[48]),
    change: num(fields[31]),
    changePercent: num(fields[32]),
  }
}

/**
 * cn 五档盘口解析（issue #39）。字段布局（v_sh600519，与 parseCnTicker 同一行）：
 * 9=买一价 10=买一量(**手**) … 17=买五价 18=买五量；19=卖一价 20=卖一量 … 27=卖五价
 * 28=卖五量。档位全 0/缺省时该档丢弃——全部无效时返回空档位（消费方显示空态，
 * 盘后/集合竞价外时段属正常），不抛错。
 */
export function parseCnOrderbook(fields: string[], timestamp: number): Orderbook {
  const bids: OrderbookLevel[] = []
  const asks: OrderbookLevel[] = []
  // 买档：价 fields[9,11,13,15,17]，量 fields[10,12,14,16,18]（手 → 股 ×100）。
  for (let i = 0; i < 5; i++) {
    const price = num(fields[9 + i * 2])
    const amountLots = num(fields[10 + i * 2])
    if (price !== undefined && amountLots !== undefined && price > 0 && amountLots > 0) {
      bids.push({ price, amount: amountLots * 100 })
    }
  }
  // 卖档：价 fields[19,21,23,25,27]，量 fields[20,22,24,26,28]（手 → 股 ×100）。
  for (let i = 0; i < 5; i++) {
    const price = num(fields[19 + i * 2])
    const amountLots = num(fields[20 + i * 2])
    if (price !== undefined && amountLots !== undefined && price > 0 && amountLots > 0) {
      asks.push({ price, amount: amountLots * 100 })
    }
  }
  // 行内保证：bids 降序（买一在前）、asks 升序（卖一在前）——腾讯行天然按档位排布。
  return { symbol: '', bids, asks, timestamp }
}

/** 基本面快照 = api 契约形（币种单位 cn=CNY，展示层标注）。 */
export type TencentFundamentals = StockFundamentals

/**
 * cn 基本面字段布局（与 parseCnTicker 同一行报价；字段号 2026-09-02 实测
 * spikes/impl-cn-hk/r4-fundamentals/ 核对）：38=换手率% 39=动态PE 44=流通市值(亿)
 * 45=总市值(亿) 46=PB 52=静态PE 53=PE(TTM) **67=52周高 68=52周低**。
 * 注意：kit-cn/fundamentals 的 68/69 与其实测夹具自洽，但夹具比真实响应多一个空字段
 * （真实行 53 之后只有两个空位，52 周高在 67）——本解析器以 r4 原始字节证据为准。
 * 字段缺省（指数/ETF）时 num() 置 undefined 后整字段省略。
 */
function parseCnFundamentals(fields: string[], timestamp: number): TencentFundamentals {
  const peDynamic = num(fields[39])
  const peTtm = num(fields[53]) ?? peDynamic
  const totalMarketCapYi = num(fields[45])
  const floatMarketCapYi = num(fields[44])
  return {
    symbol: '',
    name: fields[1] ?? '',
    ...(totalMarketCapYi !== undefined ? { marketCap: totalMarketCapYi * 100_000_000 } : {}),
    ...(floatMarketCapYi !== undefined ? { floatMarketCap: floatMarketCapYi * 100_000_000 } : {}),
    ...(peTtm !== undefined ? { peTtm } : {}),
    ...(peDynamic !== undefined ? { peDynamic } : {}),
    ...(num(fields[46]) !== undefined ? { pb: num(fields[46]) } : {}),
    ...(num(fields[38]) !== undefined ? { turnoverRate: num(fields[38]) } : {}),
    ...(num(fields[67]) !== undefined ? { fiftyTwoWeekHigh: num(fields[67]) } : {}),
    ...(num(fields[68]) !== undefined ? { fiftyTwoWeekLow: num(fields[68]) } : {}),
    timestamp,
  }
}

/* ------------------------------------------------------------------ */
/* 腾讯行情客户端（无凭证、可注入 fetch，便于单测）                            */
/* ------------------------------------------------------------------ */

const DEFAULT_QUOTE_BASE_URL = 'https://qt.gtimg.cn'
const DEFAULT_KLINE_BASE_URL = 'https://web.ifzq.gtimg.cn'
const DEFAULT_MKLINE_BASE_URL = 'https://ifzq.gtimg.cn'
const DEFAULT_SEARCH_BASE_URL = 'https://smartbox.gtimg.cn'
const DEFAULT_TIMEOUT_MS = 10_000

export interface TencentRestOptions {
  /** 覆盖报价 base（测试/反代用），末尾不带斜杠。 */
  readonly quoteBaseUrl?: string
  /** 覆盖 K 线 base（测试/反代用），末尾不带斜杠。 */
  readonly klineBaseUrl?: string
  /** 覆盖分钟 K 线 base（测试/反代用），末尾不带斜杠。 */
  readonly mklineBaseUrl?: string
  /** 覆盖智能联想搜索 base（测试/反代用），末尾不带斜杠。 */
  readonly searchBaseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
}

export class TencentRestClient {
  // 纯数据客户端（非 cordis Service 类），可用 # 私有字段（realm 代理风险只涉 Service 基类）。
  readonly #quoteBaseUrl: string
  readonly #klineBaseUrl: string
  readonly #mklineBaseUrl: string
  readonly #searchBaseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(options: TencentRestOptions = {}) {
    this.#quoteBaseUrl = options.quoteBaseUrl ?? DEFAULT_QUOTE_BASE_URL
    this.#klineBaseUrl = options.klineBaseUrl ?? DEFAULT_KLINE_BASE_URL
    this.#mklineBaseUrl = options.mklineBaseUrl ?? DEFAULT_MKLINE_BASE_URL
    this.#searchBaseUrl = options.searchBaseUrl ?? DEFAULT_SEARCH_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async #requestArrayBuffer(url: string): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.#timeoutMs}ms`, 'TimeoutError')),
      this.#timeoutMs,
    )
    let res: Response
    try {
      res = await this.#fetchImpl(url, { signal: controller.signal })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `Tencent ${url}: request timed out after ${this.#timeoutMs}ms` : `Tencent ${url}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      throw new TradingServiceError(
        res.status === 429 ? 'TRADING_RATE_LIMITED' : 'TRADING_EXCHANGE_ERROR',
        `Tencent ${url}: HTTP ${res.status} ${res.statusText}`,
      )
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * 报价行取数（getTicker/getFundamentals 共用）：**GBK 解码**（响应 charset=GBK，
   * UTF-8 直接乱码）；未知代码返回 `v_pv_none="1"` 之类短 body，按
   * TRADING_UNSUPPORTED_SYMBOL 上报。返回 `~` 分隔字段数组 + 行情时间戳。
   * cn 的 wire 形态即规范化符号本身（sh600519，报价与 K 线端点同形）。
   */
  async #fetchQuoteFields(symbol: string): Promise<{ fields: string[]; timestamp: number; sym: string }> {
    const sym = normalizeCnSymbol(symbol)
    const url = `${this.#quoteBaseUrl}/q=${sym}`
    const bytes = await this.#requestArrayBuffer(url)
    const text = new TextDecoder('gbk').decode(bytes)
    const m = /="([^"]*)"/.exec(text)
    if (!m) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent ticker for ${sym}: unparseable payload ${JSON.stringify(text.slice(0, 80))} (unknown symbol?)`,
      )
    }
    const fields = m[1].split('~')
    if (fields.length < 35) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent ticker for ${sym}: payload has ${fields.length} fields, expected >= 35 (unknown/delisted symbol?)`,
      )
    }
    const timestamp = wallTimeToEpochMs(fields[30] ?? '', 'Asia/Shanghai')
    return { fields, timestamp, sym }
  }

  /**
   * 最新行情快照（同一报价行含基本面字段，getFundamentals 零额外请求成本地解析）。
   */
  async getTicker(symbol: string): Promise<TencentTicker> {
    const { fields, timestamp, sym } = await this.#fetchQuoteFields(symbol)
    const parsed = parseCnTicker(fields, timestamp)
    // 输出一律规范形（响应体 fields[2] 是裸代码，交易所信息在请求时的 wire 前缀里）。
    return { ...parsed, symbol: toCanonicalTencentSymbol(sym) }
  }

  /**
   * 基本面与估值快照：与 getTicker 同一行报价（字段布局见 parseCnFundamentals 注释），
   * 无额外端点。估值字段缺省（指数/ETF）时整字段省略。
   */
  async getFundamentals(symbol: string): Promise<TencentFundamentals> {
    const { fields, timestamp, sym } = await this.#fetchQuoteFields(symbol)
    const parsed = parseCnFundamentals(fields, timestamp)
    return { ...parsed, symbol: toCanonicalTencentSymbol(sym) }
  }

  /**
   * 盘口快照（api 可选契约 getOrderbook，issue #39）：与 getTicker 同一行报价的
   * 五档字段（cn 布局 fields 9-28，见 parseCnOrderbook）。
   */
  async getOrderbook(symbol: string): Promise<Orderbook> {
    const { fields, timestamp, sym } = await this.#fetchQuoteFields(symbol)
    const parsed = parseCnOrderbook(fields, timestamp)
    return { ...parsed, symbol: toCanonicalTencentSymbol(sym) }
  }

  /**
   * K 线（日/周/月走 fqkline 前权 qfq；5m/30m 分钟线走 mkline 端点）。
   */
  async getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    const sym = normalizeCnSymbol(symbol)
    const mapping = INTERVAL_TO_TENCENT.get(interval)
    if (!mapping) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Tencent klines: unsupported interval ${String(interval)} — supported: ${INTERVAL_VOCABULARY.join('/')}`,
      )
    }
    const count = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 800) : 100
    const isMinute = mapping.type === 'mkline'
    const url = isMinute
      ? `${this.#mklineBaseUrl}/appstock/app/kline/mkline?param=${sym},${mapping.tf},,${count}`
      : `${this.#klineBaseUrl}/appstock/app/fqkline/get?param=${sym},${mapping.tf},,,${count},qfq`

    const bytes = await this.#requestArrayBuffer(url)
    let payload: { code?: number; msg?: string; data?: Record<string, Record<string, unknown>> }
    try {
      payload = JSON.parse(new TextDecoder('utf-8').decode(bytes))
    } catch (cause) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: non-JSON payload`, cause)
    }
    if (payload.code !== 0) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Tencent klines for ${sym}: upstream code=${String(payload.code)} msg=${JSON.stringify(payload.msg ?? '')}`,
      )
    }
    const market = payload.data?.[sym]
    // 键回落（2026-08-31 实证）：无前权事件的代码可能返回 `day`（未复权）而非
    // `qfqday`——优先 qfq 键，缺失回落裸键，行结构相同。
    const raw = isMinute
      ? market?.[mapping.key]
      : (market?.[mapping.key] ?? market?.[mapping.tf])
    const rows = Array.isArray(raw) ? raw : undefined
    if (rows === undefined || rows.length === 0) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent klines for ${sym}: no ${mapping.key}/${mapping.tf} rows (unknown/delisted symbol?)`,
      )
    }
    const klines: Kline[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: malformed row ${JSON.stringify(row)?.slice(0, 80)}`)
      }
      const open = num(String(row[1]))
      const close = num(String(row[2]))
      const high = num(String(row[3]))
      const low = num(String(row[4]))
      const volume = num(String(row[5]))
      if (open === undefined || close === undefined || high === undefined || low === undefined) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: malformed row values ${JSON.stringify(row).slice(0, 80)}`)
      }
      const openTime = isMinute ? minuteKlineTimeToEpochMs(row[0]) : klineDateToEpochMs(row[0])
      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
        closeTime: openTime + mapping.durationMs - 1,
      })
    }
    return klines
  }

  /**
   * 智能联想标的列表（按名称、代码、拼音模糊检索）：
   * 接入腾讯证券智能联想端点，统一格式输出标的 symbol、name、pinyin。
   */
  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string; pinyin?: string }>> {
    const q = query?.trim()
    if (!q) return []
    const url = `${this.#searchBaseUrl}/s3/?t=all&q=${encodeURIComponent(q)}`
    let text = ''
    try {
      const res = await this.#fetchImpl(url)
      if (!res.ok) return []
      text = await res.text()
    } catch {
      return []
    }
    const m = /v_hint="([^"]*)"/.exec(text)
    if (!m || !m[1]) return []
    const rawContent = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    const records = rawContent.split('^').filter(Boolean)
    const results: Array<{ symbol: string; name: string; pinyin?: string }> = []
    const seen = new Set<string>()

    for (const rec of records) {
      const parts = rec.split('~')
      if (parts.length < 3) continue
      const [mkt, code, name, pinyin] = parts
      if (!mkt || !code || !name) continue

      // 只保留 cn 市场前缀（sh/sz/bj），其余市场记录过滤。
      const lowerMkt = mkt.toLowerCase()
      let canonicalSymbol = ''
      if (lowerMkt === 'sh') {
        canonicalSymbol = `${code}.SH`
      } else if (lowerMkt === 'sz') {
        canonicalSymbol = `${code}.SZ`
      } else if (lowerMkt === 'bj') {
        canonicalSymbol = `${code}.BJ`
      } else {
        continue
      }

      if (seen.has(canonicalSymbol)) continue
      seen.add(canonicalSymbol)
      results.push({
        symbol: canonicalSymbol,
        name,
        ...(pinyin ? { pinyin: pinyin.toUpperCase() } : {}),
      })
    }

    return results
  }
}
