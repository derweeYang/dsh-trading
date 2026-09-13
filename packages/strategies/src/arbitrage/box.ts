/**
 * 箱型套利（Box Spread）。
 *
 * 箱型 = 牛市看涨价差(买C₁卖C₂) + 熊市看跌价差(买P₂卖P₁)，同 K₁<K₂。
 * 到期恒付 K₂−K₁，与标的价格无关；公平现值 = (K₂−K₁)·e^{-rT}。
 *   - 多箱成本 = (C₁_ask − C₂_bid) + (P₂_ask − P₁_bid)；成本 < 公平值 → long_box 便宜
 *   - 空箱收入 = (C₁_bid − C₂_ask) + (P₂_bid − P₁_ask)；收入 > 公平值 → short_box 偏贵
 * 本质是无风险借贷：多箱≈以锁定利率贷出 K₂−K₁，空箱≈借入。
 */
import type { ArbitrageChain, ArbitrageLeg, ArbitrageOpportunity, ArbitrageQuoteRow } from './types.ts'
import { yearsToExpiry, discountFactor } from './time.ts'
import { execPrices } from './prices.ts'

export interface BoxOptions {
  /** 连续无风险利率（年化），默认 0.02 */
  rate?: number
  /** 偏差阈值（元/股），默认 0.005 */
  threshold?: number
  /** 单边交易费（元/张），默认 0 */
  feePerContract?: number
  /** 合约乘数，默认 10000 */
  multiplier?: number
  /** 评估时点 YYYY-MM-DD，默认 chain.asOf 或 now */
  asOf?: string
}

export function scanBoxArbitrage(chain: ArbitrageChain, options: BoxOptions = {}): ArbitrageOpportunity[] {
  const rate = options.rate ?? 0.02
  const threshold = options.threshold ?? 0.005
  const multiplier = options.multiplier ?? 10000
  const fee = options.feePerContract ?? 0
  const asOf = options.asOf ?? chain.asOf
  const T = yearsToExpiry(chain.expiryDate, asOf)
  if (T === undefined) return []

  const calls = new Map<number, ArbitrageQuoteRow>()
  for (const c of chain.calls) calls.set(c.strike, c)
  const puts = new Map<number, ArbitrageQuoteRow>()
  for (const p of chain.puts) puts.set(p.strike, p)

  const strikes = [...new Set([...calls.keys(), ...puts.keys()])].sort((a, b) => a - b)
  const out: ArbitrageOpportunity[] = []

  for (let i = 0; i < strikes.length; i++) {
    for (let j = i + 1; j < strikes.length; j++) {
      const k1 = strikes[i] as number
      const k2 = strikes[j] as number
      const c1 = calls.get(k1)
      const c2 = calls.get(k2)
      const p1 = puts.get(k1)
      const p2 = puts.get(k2)
      if (c1 === undefined || c2 === undefined || p1 === undefined || p2 === undefined) continue

      const c1e = execPrices(c1)
      const c2e = execPrices(c2)
      const p1e = execPrices(p1)
      const p2e = execPrices(p2)
      const executable = c1e.executable && c2e.executable && p1e.executable && p2e.executable

      const costLong = (c1e.ask - c2e.bid) + (p2e.ask - p1e.bid)
      const proceedsShort = (c1e.bid - c2e.ask) + (p2e.bid - p1e.ask)
      const fair = (k2 - k1) * discountFactor(rate, T)

      const edgeShort = proceedsShort - fair
      const edgeLong = fair - costLong

      let direction: ArbitrageOpportunity['direction'] | undefined
      let edge = 0
      if (edgeShort > edgeLong && edgeShort > 0) {
        direction = 'short_box'
        edge = edgeShort
      } else if (edgeLong > 0) {
        direction = 'long_box'
        edge = edgeLong
      }
      if (direction === undefined) continue

      const netEdge = edge * multiplier - 4 * fee // 四腿各一费
      if (netEdge <= threshold * multiplier) continue

      const legs: ArbitrageLeg[] =
        direction === 'long_box'
          ? [
              { code: c1.code, right: 'C', action: 'buy', strike: k1 },
              { code: c2.code, right: 'C', action: 'sell', strike: k2 },
              { code: p2.code, right: 'P', action: 'buy', strike: k2 },
              { code: p1.code, right: 'P', action: 'sell', strike: k1 },
            ]
          : [
              { code: c1.code, right: 'C', action: 'sell', strike: k1 },
              { code: c2.code, right: 'C', action: 'buy', strike: k2 },
              { code: p2.code, right: 'P', action: 'sell', strike: k2 },
              { code: p1.code, right: 'P', action: 'buy', strike: k1 },
            ]

      out.push({
        kind: 'box',
        underlying: chain.underlying,
        expiryMonth: chain.expiryMonth,
        lowStrike: k1,
        highStrike: k2,
        edgePerShare: edge,
        edgePerContract: edge * multiplier,
        direction,
        legs,
        note: `箱型 K₁=${k1} K₂=${k2} 公平值 ${fair.toFixed(4)} 元/股`,
        executable,
      })
    }
  }
  out.sort((a, b) => b.edgePerContract - a.edgePerContract)
  return out
}
