/**
 * Client-half shared types. Wire shapes mirror the node-half bridge
 * (src/bridge.ts) and @dshtrading/api's data contracts — type-only imports,
 * erased at bundle time (the client half must not require non-seed modules).
 */
import type { AccountBalance, Kline, Order, Orderbook, Position, StockFundamentals, Ticker, TradeFill, TradeTick } from '@dshtrading/api'

/**
 * Markets served by the bridge. 曾为四市场 'crypto' | 'us' | 'cn' | 'hk'；
 * 市场收敛后（阶段 1/2）只剩 cn——保留类型别名与签名，避免日后复辟时
 * 全链路改签名。
 */
export type MarketId = 'cn'

/** One watchable instrument (a watchlist row / the quote stage's subject). */
export interface Instrument {
  market: MarketId
  symbol: string
  /** Display label (seed names, or the raw symbol for user-added rows). */
  name?: string
}

export interface MarketInfo {
  id: MarketId
  provider?: string
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

export type { Kline, Ticker, StockFundamentals, Orderbook, TradeTick, Position, Order, AccountBalance, TradeFill }

/** Per-instrument cached reference series: closes for the sparkline + prev daily close for change%. */
export interface ReferenceSeries {
  closes: number[]
  prevClose: number | undefined
  fetchedAt: number
}
