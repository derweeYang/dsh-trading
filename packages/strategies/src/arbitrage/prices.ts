/**
 * 报价解析工具：从一行报价取出可计算的中间价与可执行买卖价。
 * 优先用 bid/ask（可执行边界），缺失时回退 last / prevSettle（仅估算）。
 */
import type { ArbitrageQuoteRow } from './types.ts'

export function quotePrice(row: ArbitrageQuoteRow, field: 'last' | 'prevSettle'): number | undefined {
  const v = field === 'last' ? row.last : row.prevSettle
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const alt = field === 'last' ? row.prevSettle : row.last
  if (typeof alt === 'number' && Number.isFinite(alt)) return alt
  return undefined
}

/** 中间价：优先 (bid+ask)/2，否则回退 last/prevSettle。 */
export function midOrLast(row: ArbitrageQuoteRow): number | undefined {
  if (typeof row.bid === 'number' && typeof row.ask === 'number' && row.ask >= row.bid) {
    return (row.bid + row.ask) / 2
  }
  return quotePrice(row, 'last') ?? quotePrice(row, 'prevSettle')
}

export interface ExecPrices {
  readonly bid: number
  readonly ask: number
  readonly executable: boolean
}

/**
 * 可执行买卖价。有真实 bid/ask 时 executable=true；否则用中间价近似，executable=false。
 * 缺失全部价格时返回 NaN，executable=false（调用方应跳过该腿）。
 */
export function execPrices(row: ArbitrageQuoteRow): ExecPrices {
  if (
    typeof row.bid === 'number'
    && typeof row.ask === 'number'
    && Number.isFinite(row.bid)
    && Number.isFinite(row.ask)
    && row.ask >= row.bid
  ) {
    return { bid: row.bid, ask: row.ask, executable: true }
  }
  const m = midOrLast(row)
  if (m === undefined) return { bid: Number.NaN, ask: Number.NaN, executable: false }
  return { bid: m, ask: m, executable: false }
}
