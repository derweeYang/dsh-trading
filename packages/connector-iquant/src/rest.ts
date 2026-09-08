/**
 * 国信 iQuant 行情 HTTP 客户端（本地 :5810）。
 */
import type { Interval, Kline, Ticker, TradingErrorCode } from '@dshtrading/api'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '1d'] as const

const KERNEL_TO_TRADING: Record<string, TradingErrorCode> = {
  BAD_REQUEST: 'TRADING_UNSUPPORTED_SYMBOL',
  NO_DATA: 'TRADING_NO_DATA',
  NETWORK: 'TRADING_NETWORK',
  INTERNAL: 'TRADING_EXCHANGE_ERROR',
}

export interface IquantRestOptions {
  gatewayUrl?: string
  fetchImpl?: typeof fetch
}

export function parseIquantSymbol(symbol: string): { market: string; code: string; symbol: string } {
  const text = symbol.trim().toUpperCase()
  if (!text) {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'symbol is required')
  }
  if (/^\d{6}[CP]\d{4}M\d{5}$/i.test(text)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `long option code ${symbol} is not a quote primary key; use 100xxxxx.SHO / 900xxxxx.SZO`,
    )
  }
  const dotted = /^(\d{6,8})\.(SH|SZ|BJ|HK|SHO|SZO)$/.exec(text)
  if (dotted) return { code: dotted[1]!, market: dotted[2]!, symbol: `${dotted[1]}.${dotted[2]}` }
  if (/^\d{8}$/.test(text) && text.startsWith('100')) return { code: text, market: 'SHO', symbol: `${text}.SHO` }
  if (/^\d{8}$/.test(text) && text.startsWith('900')) return { code: text, market: 'SZO', symbol: `${text}.SZO` }
  if (/^\d{6}$/.test(text)) {
    const market = text.startsWith('6') || text.startsWith('5') || text.startsWith('9')
      ? 'SH'
      : text.startsWith('4') || text.startsWith('8')
        ? 'BJ'
        : 'SZ'
    return { code: text, market, symbol: `${text}.${market}` }
  }
  if (/^(AAPL|MSFT|BTC)/.test(text)) {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `unsupported symbol ${symbol}`)
  }
  throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `unsupported symbol ${symbol}`)
}

export class IquantRestClient {
  readonly gatewayUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: IquantRestOptions = {}) {
    this.gatewayUrl = (options.gatewayUrl ?? process.env.IQUANT_QUOTE_GATEWAY_URL ?? 'http://127.0.0.1:5810').replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string): Promise<T> {
    const url = `${this.gatewayUrl}${path}`
    let res: Response
    try {
      res = await this.fetchImpl(url)
    } catch (err) {
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `iquant quote gateway unreachable (${this.gatewayUrl}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    let wire: unknown
    try {
      wire = await res.json()
    } catch (err) {
      throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `iquant gateway returned non-JSON (HTTP ${res.status})`, err)
    }
    const body = wire as { ok?: boolean; result?: T; error?: { code?: string; message?: string } }
    if (body.ok === false) {
      const code = KERNEL_TO_TRADING[body.error?.code ?? ''] ?? 'TRADING_EXCHANGE_ERROR'
      throw new TradingServiceError(code, body.error?.message ?? 'iquant gateway error')
    }
    if (!res.ok || body.result === undefined) {
      throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `iquant gateway HTTP ${res.status}`)
    }
    return body.result
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const parsed = parseIquantSymbol(symbol)
    const row = await this.requestJson<{ symbol: string; last: number; volume?: number; timestamp?: number }>(
      `/v1/ticker?symbol=${encodeURIComponent(parsed.symbol)}`,
    )
    return {
      symbol: row.symbol ?? parsed.symbol,
      price: row.last,
      ...(row.volume !== undefined ? { volume: row.volume } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const parsed = parseIquantSymbol(symbol)
    const row = await this.requestJson<{ bars: Kline[] }>(
      `/v1/klines?symbol=${encodeURIComponent(parsed.symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    )
    return row.bars
  }
}
