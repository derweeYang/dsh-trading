/**
 * 时间 / 贴现 / 远期 纯函数工具（套利定价用）。
 */

/** 距到期年化（365.25 日基准）；缺到期日或时点返回 undefined。 */
export function yearsToExpiry(expiryDate: string | undefined, asOf: string | undefined): number | undefined {
  const exp = expiryDate === undefined ? Number.NaN : Date.parse(expiryDate)
  const now = asOf === undefined ? Date.now() : Date.parse(asOf)
  if (!Number.isFinite(exp) || !Number.isFinite(now)) return undefined
  const ms = exp - now
  if (ms <= 0) return 0
  return ms / (365.25 * 24 * 3600 * 1000)
}

/** 连续复利贴现因子 e^{-rT}。 */
export function discountFactor(rate: number, years: number): number {
  return Math.exp(-rate * years)
}

/** 连续复利下的远期价格 F = S·e^{(r-q)T}（含股息率 q）。 */
export function forwardPrice(spot: number, rate: number, dividendYield: number, years: number): number {
  return spot * Math.exp((rate - dividendYield) * years)
}
