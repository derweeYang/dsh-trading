/**
 * @dshtrading/connector-options/rest
 * 本地期权网关 HTTP 客户端 + CN ETF 标的规范化。
 */
import type {
  CnOptionsQuery,
  CnOptionsService,
  KernelReport,
  OptionChain,
  OptionExpiryCalendar,
  OptionImpliedVolResult,
  OptionParityQuery,
  OptionPriceQuery,
  OptionSource,
  OptionStrategyRequest,
  OptionStrategyResult,
  OptionUnderlying,
  OptionUnderlyingDailyQuery,
  OptionVolAnalyticsQuery,
  TradingErrorCode,
} from '@dshtrading/api'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** 与 python/options underlyings.json 对齐的静态名册（桥/工具显隐用，不打网关）。 */
export const SSE_UNDERLYINGS = ['510050', '510300', '510500', '588000', '588080'] as const
export const SZSE_UNDERLYINGS = ['159919', '159915', '159901', '159922'] as const
export const SYNTH_UNDERLYINGS = ['910050'] as const
/** iquant（国信）名册：沪深皆可达；合约行情市场是 SHO/SZO，不是 SH/SZ。 */
export const IQUANT_UNDERLYINGS = ['510050', '159915'] as const

const STATIC_ROWS: Record<OptionSource, readonly OptionUnderlying[]> = {
  akshare: [
    { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
    { underlying: '510300', exchange: 'SSE', name: '华泰柏瑞沪深300ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
    { underlying: '510500', exchange: 'SSE', name: '南方中证500ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
    { underlying: '588000', exchange: 'SSE', name: '华夏科创50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
    { underlying: '588080', exchange: 'SSE', name: '易方达科创50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
    { underlying: '159919', exchange: 'SZSE', name: '嘉实沪深300ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'szse_static_only' },
    { underlying: '159915', exchange: 'SZSE', name: '创业板ETF易方达', multiplier: 10000, tickSize: 0.0001, quotesSource: 'szse_static_only' },
    { underlying: '159901', exchange: 'SZSE', name: '深证100ETF易方达', multiplier: 10000, tickSize: 0.0001, quotesSource: 'szse_static_only' },
    { underlying: '159922', exchange: 'SZSE', name: '嘉实中证500ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'szse_static_only' },
  ],
  iquant: [
    { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'iquant_board' },
    { underlying: '159915', exchange: 'SZSE', name: '创业板ETF易方达', multiplier: 10000, tickSize: 0.0001, quotesSource: 'iquant_board' },
  ],
  synth: [
    { underlying: '910050', exchange: 'SYNTH', name: 'synth50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'synth' },
  ],
}

export function listStaticUnderlyings(source: OptionSource): readonly OptionUnderlying[] {
  return STATIC_ROWS[source]
}

const SEASONAL_STEPS = [0, 1, 3, 6] as const

/** 到期月 YYMM → 该月第四个周三（沪深 ETF 期权行权日）。 */
export function expiryDateOf(expiryMonth: string, now = new Date()): string {
  const raw = expiryMonth.trim()
  if (!/^\d{4}$/.test(raw)) {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `options: expiryMonth must be YYMM: ${expiryMonth}`)
  }
  const century = now.getFullYear() - (now.getFullYear() % 100)
  const year = century + Number(raw.slice(0, 2))
  const month = Number(raw.slice(2))
  const wednesdays: number[] = []
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCMonth() !== month - 1) break
    if (date.getUTCDay() === 3) wednesdays.push(day)
  }
  const fourth = wednesdays[3]
  if (fourth === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `options: no fourth Wednesday in ${expiryMonth}`)
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(fourth).padStart(2, '0')}`
}

/** 当月 / 次月 / +3 / +6，与 python/options `_SEASONAL_STEPS` 对齐。 */
export function seasonalExpiryMonths(asOf = new Date()): readonly string[] {
  const year = asOf.getFullYear() % 100
  const month = asOf.getMonth() + 1
  return SEASONAL_STEPS.map((step) => {
    const total = year * 12 + (month - 1) + step
    const yy = Math.floor(total / 12)
    const mm = (total % 12) + 1
    return `${String(yy).padStart(2, '0')}${String(mm).padStart(2, '0')}`
  })
}

const LONG_CODE = /^(\d{6})[CP]\d{4}M\d{5}$/i
const SPOT_CODE = /^(\d{6})(?:\.(?:SH|SZ))?$/i

export function normalizeCnUnderlying(symbol: string): string {
  const raw = symbol.trim().toUpperCase()
  if (raw === '') {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options: underlying is required')
  }
  const long = raw.match(LONG_CODE)?.[1]
  if (long !== undefined) return long
  const spot = raw.match(SPOT_CODE)?.[1]
  if (spot !== undefined) return spot
  throw new TradingServiceError(
    'TRADING_UNSUPPORTED_SYMBOL',
    `options: not a CN ETF underlying or long code: ${symbol}`,
  )
}

export function isKnownUnderlying(underlying: string): boolean {
  return (
    (SSE_UNDERLYINGS as readonly string[]).includes(underlying)
    || (SZSE_UNDERLYINGS as readonly string[]).includes(underlying)
    || (IQUANT_UNDERLYINGS as readonly string[]).includes(underlying)
    || (SYNTH_UNDERLYINGS as readonly string[]).includes(underlying)
  )
}

export interface OptionsRestOptions {
  gatewayUrl?: string
  source?: OptionSource
  fetchImpl?: typeof fetch
}

const KERNEL_TO_TRADING: Record<string, TradingErrorCode> = {
  BAD_REQUEST: 'TRADING_UNSUPPORTED_SYMBOL',
  NO_DATA: 'TRADING_NO_DATA',
  NETWORK: 'TRADING_NETWORK',
  INTERNAL: 'TRADING_EXCHANGE_ERROR',
}

export class OptionsRestClient implements CnOptionsService {
  readonly gatewayUrl: string
  readonly source: OptionSource
  private readonly fetchImpl: typeof fetch

  constructor(options: OptionsRestOptions = {}) {
    this.gatewayUrl = (options.gatewayUrl ?? process.env.DSH_OPTIONS_GATEWAY_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '')
    this.source = options.source ?? (process.env.DSH_OPTIONS_SOURCE as OptionSource | undefined) ?? 'iquant'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  async listUnderlyings(source: OptionSource = this.source): Promise<readonly OptionUnderlying[]> {
    // 名册是随包静态数据：T 板显隐不依赖网关。链/IV/策略仍走 HTTP。
    return listStaticUnderlyings(source)
  }

  async getOptionExpiries(query: CnOptionsQuery): Promise<OptionExpiryCalendar> {
    const underlying = normalizeCnUnderlying(query.underlying)
    if (!isKnownUnderlying(underlying)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `options: unknown underlying ${underlying}`)
    }
    return {
      underlying,
      source: query.source ?? this.source,
      months: seasonalExpiryMonths().map((expiryMonth) => ({
        expiryMonth,
        expiryDate: expiryDateOf(expiryMonth),
      })),
    }
  }

  async getOptionChain(query: CnOptionsQuery): Promise<OptionChain> {
    const underlying = normalizeCnUnderlying(query.underlying)
    const source = query.source ?? this.source
    const expiryMonth = query.expiryMonth
    if (expiryMonth === undefined || expiryMonth.trim() === '') {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options: expiryMonth is required')
    }
    return await this.invoke<OptionChain>('chain', {
      source,
      underlying,
      expiryMonth: expiryMonth.trim(),
    })
  }

  async getImpliedVol(query: CnOptionsQuery & { readonly rate: number }): Promise<OptionImpliedVolResult> {
    const underlying = normalizeCnUnderlying(query.underlying)
    const expiryMonth = query.expiryMonth
    if (expiryMonth === undefined || expiryMonth.trim() === '') {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options: expiryMonth is required')
    }
    if (!Number.isFinite(query.rate)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options: rate is required for implied vol')
    }
    return await this.invoke<OptionImpliedVolResult>('implied_vol', {
      source: query.source ?? this.source,
      underlying,
      expiryMonth: expiryMonth.trim(),
      rate: query.rate,
      priceField: query.priceField ?? 'last',
    })
  }

  async getStrategy(request: OptionStrategyRequest): Promise<OptionStrategyResult> {
    const underlying = normalizeCnUnderlying(request.underlying)
    return await this.invoke<OptionStrategyResult>('strategy', {
      ...request,
      underlying,
      source: request.source ?? this.source,
    })
  }

  async getVolAnalytics(query: OptionVolAnalyticsQuery): Promise<KernelReport> {
    const underlying = normalizeCnUnderlying(query.underlying)
    return await this.invoke<KernelReport>('vol_analytics', {
      ...query,
      underlying,
      source: query.source ?? this.source,
    })
  }

  async getUnderlyingDaily(query: OptionUnderlyingDailyQuery): Promise<KernelReport> {
    // fetch_underlying_daily 的 underlying 缺省 = source 注册表全表，不做 normalize。
    return await this.invoke<KernelReport>('fetch_underlying_daily', { ...query })
  }

  async getPrice(query: OptionPriceQuery): Promise<KernelReport> {
    // price 是纯计算（spot/strike/vol 直填），无标的规范化。
    if (!Number.isFinite(query.spot) || !Number.isFinite(query.strike) || !Number.isFinite(query.vol)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options price: spot/strike/vol must be finite numbers')
    }
    return await this.invoke<KernelReport>('price', { ...query })
  }

  async getParityCheck(query: OptionParityQuery): Promise<KernelReport> {
    const underlying = normalizeCnUnderlying(query.underlying)
    const expiryMonth = query.expiryMonth
    if (expiryMonth === undefined || expiryMonth.trim() === '') {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options: expiryMonth is required')
    }
    return await this.invoke<KernelReport>('parity_check', {
      ...query,
      underlying,
      expiryMonth: expiryMonth.trim(),
      source: query.source ?? this.source,
    })
  }

  private async invoke<T>(command: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.gatewayUrl}/v1/${command}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `options gateway unreachable (${this.gatewayUrl}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    let wire: unknown
    try {
      wire = await res.json()
    } catch (err) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `options gateway returned non-JSON (HTTP ${res.status})`,
        err,
      )
    }
    if (!res.ok) {
      const errDoc = asKernelError(wire)
      if (errDoc) throw kernelError(errDoc.code, errDoc.message)
      throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `options gateway HTTP ${res.status}`)
    }
    if (wire !== null && typeof wire === 'object' && (wire as { ok?: unknown }).ok === false) {
      const errDoc = asKernelError(wire)
      if (errDoc) throw kernelError(errDoc.code, errDoc.message)
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'options gateway returned ok:false')
    }
    if (wire !== null && typeof wire === 'object' && 'result' in (wire as object)) {
      return (wire as { result: T }).result
    }
    return wire as T
  }
}

function asKernelError(wire: unknown): { code: string; message: string } | undefined {
  if (wire === null || typeof wire !== 'object') return undefined
  const error = (wire as { error?: { code?: unknown; message?: unknown } }).error
  if (error === undefined || typeof error.code !== 'string') return undefined
  return { code: error.code, message: typeof error.message === 'string' ? error.message : error.code }
}

function kernelError(code: string, message: string): TradingServiceError {
  return new TradingServiceError(KERNEL_TO_TRADING[code] ?? 'TRADING_EXCHANGE_ERROR', message)
}

