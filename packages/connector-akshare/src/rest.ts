/**
 * @dshtrading/connector-akshare/rest
 * AkShare A 股宏观与量化另类数据 REST 客户端。
 */

import type {
  CbQuoteRow,
  Interval,
  Kline,
  Ticker,
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

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'] as const

/** datacenter 行数值：'-'（无报价）/ null / 非有限数 → undefined。 */
function covNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

export function toEastmoneySecid(symbol: string): { secid: string; canonical: string } {
  const clean = symbol.trim().toUpperCase()
  let code = clean
  let market = 'SH'
  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0]
    market = parts[1]
  } else if (code.startsWith('0') || code.startsWith('3')) {
    market = 'SZ'
  }
  const prefix = market === 'SH' ? '1' : '0'
  return { secid: `${prefix}.${code}`, canonical: `${code}.${market}` }
}

export interface AkshareRestOptions {
  apiUrl?: string
  fetchImpl?: typeof fetch
}

export class AkshareRestClient {
  readonly apiUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: AkshareRestOptions = {}) {
    this.apiUrl = options.apiUrl ?? (process.env.AKSHARE_API_URL || 'http://127.0.0.1:8080')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(url: string): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Akshare HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Akshare network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { secid, canonical } = toEastmoneySecid(symbol)
    // f60=昨收 f170=涨跌幅（×100 分精度整数；官方昨收锚点，UI 头部/侧栏直接消费）。
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f47,f60,f86,f170`
    const res = await this.requestJson<{ data?: { f43?: number; f47?: number; f60?: number; f86?: number; f170?: number } }>(url)
    if (!res.data) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `AkShare/Eastmoney quote not found: ${symbol}`)
    }
    const rawPrice = typeof res.data.f43 === 'number' ? res.data.f43 / 100 : 0
    const prevClose = typeof res.data.f60 === 'number' && res.data.f60 > 0 ? res.data.f60 / 100 : undefined
    const changePercent = typeof res.data.f170 === 'number' && Number.isFinite(res.data.f170) ? res.data.f170 / 100 : undefined
    return {
      symbol: canonical,
      price: rawPrice > 0 ? rawPrice : 0,
      volume: res.data.f47 ?? 0,
      timestamp: res.data.f86 ? res.data.f86 * 1000 : Date.now(),
      ...(prevClose !== undefined ? { prevClose } : {}),
      ...(changePercent !== undefined ? { changePercent } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { secid } = toEastmoneySecid(symbol)
    const klt = interval === '5m' ? '5' : interval === '15m' ? '15' : interval === '30m' ? '30' : interval === '1h' ? '60' : '101'
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&fields2=f51,f52,f53,f54,f55,f56`
    const res = await this.requestJson<{ data?: { klines?: string[] } }>(url)
    if (!res.data?.klines) return []

    return res.data.klines.map((line) => {
      const parts = line.split(',')
      const openTime = new Date(parts[0].replace(/-/g, '/')).getTime()
      return {
        openTime,
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]),
        closeTime: openTime + 86400000 - 1,
      }
    })
  }

  async getSectorFundFlow(): Promise<Array<{ name: string; changePercent: number; mainNetInflow: number }>> {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fields=f12,f14,f3,f62&fs=m:90+t:2'
    const res = await this.requestJson<{ data?: { diff?: Array<{ f14: string; f3: number; f62: number }> } }>(url)
    const list = res.data?.diff ?? []
    return list.map((item) => ({
      name: item.f14,
      changePercent: typeof item.f3 === 'number' ? item.f3 / 100 : 0,
      mainNetInflow: item.f62,
    }))
  }

  /**
   * 可转债全市场快照（复刻 akshare bond_zh_cov 的东财 datacenter 端点，
   * 2026-09-17 spike 取证：spikes/impl-akshare-cov/）。分页拉全量后仅保留
   * 存续（DELIST_DATE 空）且 债现价/正股价/转股价 三要素齐全的行；
   * '-'（无报价）与 null 一律视为缺省。
   */
  async getCovSnapshot(): Promise<CbQuoteRow[]> {
    const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
    const quoteColumns = [
      'f2~01~CONVERT_STOCK_CODE~CONVERT_STOCK_PRICE',
      'f235~10~SECURITY_CODE~TRANSFER_PRICE',
      'f236~10~SECURITY_CODE~TRANSFER_VALUE',
      'f2~10~SECURITY_CODE~CURRENT_BOND_PRICE',
      'f237~10~SECURITY_CODE~TRANSFER_PREMIUM_RATIO',
    ].join(',')
    const rows: Array<Record<string, unknown>> = []
    const maxPages = 5
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        sortColumns: 'PUBLIC_START_DATE',
        sortTypes: '-1',
        pageSize: '500',
        pageNumber: String(page),
        reportName: 'RPT_BOND_CB_LIST',
        columns: 'ALL',
        quoteColumns,
        source: 'WEB',
        client: 'WEB',
      })
      const res = await this.requestJson<{ result?: { pages?: number; data?: Array<Record<string, unknown>> } }>(
        `${base}?${params}`,
      )
      const data = res.result?.data ?? []
      rows.push(...data)
      const pages = res.result?.pages ?? 1
      if (page >= pages || data.length === 0) break
    }

    const out: CbQuoteRow[] = []
    for (const row of rows) {
      if (row.DELIST_DATE != null) continue // 退市（强赎/到期摘牌）行无实时语义
      const price = covNumber(row.CURRENT_BOND_PRICE)
      const stockPrice = covNumber(row.CONVERT_STOCK_PRICE)
      const conversionPrice = covNumber(row.TRANSFER_PRICE)
      const bondCode = typeof row.SECURITY_CODE === 'string' ? row.SECURITY_CODE : undefined
      const bondName = typeof row.SECURITY_NAME_ABBR === 'string' ? row.SECURITY_NAME_ABBR : undefined
      const stockCode = typeof row.CONVERT_STOCK_CODE === 'string' ? row.CONVERT_STOCK_CODE : undefined
      if (price === undefined || stockPrice === undefined || conversionPrice === undefined
        || bondCode === undefined || bondName === undefined || stockCode === undefined) continue
      const conversionValue = covNumber(row.TRANSFER_VALUE)
      const premiumPct = covNumber(row.TRANSFER_PREMIUM_RATIO)
      out.push({
        bondCode,
        bondName,
        exchange: row.TRADE_MARKET === 'CNSESH' ? 'SH' : 'SZ',
        price,
        stockCode,
        stockPrice,
        conversionPrice,
        ...(conversionValue === undefined ? {} : { conversionValue }),
        ...(premiumPct === undefined ? {} : { premiumPct }),
      })
    }
    return out
  }
}

export type { Interval, Kline, Ticker }
