/**
 * 适配器：把后端 @dshtrading/api 的 OptionChain 转为套利模块的 ArbitrageChain。
 * 仅 type-only 引入 api（构建期擦除，不增加运行时依赖，保持纯库零依赖）。
 */
import type { OptionChain } from '@dshtrading/api'
import type { ArbitrageChain, ArbitrageQuoteRow } from './types.ts'

function mapRow(r: { code: string; strike: number; last?: number; prevSettle?: number }): ArbitrageQuoteRow {
  if (r.last !== undefined && r.prevSettle !== undefined) {
    return { code: r.code, strike: r.strike, last: r.last, prevSettle: r.prevSettle }
  }
  if (r.last !== undefined) return { code: r.code, strike: r.strike, last: r.last }
  if (r.prevSettle !== undefined) return { code: r.code, strike: r.strike, prevSettle: r.prevSettle }
  return { code: r.code, strike: r.strike }
}

export function fromOptionChain(chain: OptionChain): ArbitrageChain {
  const base = {
    underlying: chain.underlying,
    expiryMonth: chain.expiryMonth,
    calls: chain.calls.map(mapRow),
    puts: chain.puts.map(mapRow),
  }
  if (chain.expiryDate !== undefined && chain.spot !== undefined) {
    return { ...base, expiryDate: chain.expiryDate, spot: chain.spot }
  }
  if (chain.expiryDate !== undefined) return { ...base, expiryDate: chain.expiryDate }
  if (chain.spot !== undefined) return { ...base, spot: chain.spot }
  return base
}
