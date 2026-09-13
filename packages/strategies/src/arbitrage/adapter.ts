/**
 * 适配器：把后端 @dshtrading/api 的 OptionChain 转为套利模块的 ArbitrageChain。
 * 仅 type-only 引入 api（构建期擦除，不增加运行时依赖，保持纯库零依赖）。
 */
import type { OptionChain, OptionQuoteRow } from '@dshtrading/api'
import type { ArbitrageChain, ArbitrageQuoteRow } from './types.ts'

/**
 * 单行映射：bid/ask 随 2026-09-13 契约扩展透传（真实买卖盘 → execPrices executable=true）。
 * exactOptionalPropertyTypes 下可选键不得显式写 undefined，统一条件展开。
 */
function mapRow(r: OptionQuoteRow): ArbitrageQuoteRow {
  return {
    code: r.code,
    strike: r.strike,
    ...(r.last !== undefined ? { last: r.last } : {}),
    ...(r.prevSettle !== undefined ? { prevSettle: r.prevSettle } : {}),
    ...(r.bid !== undefined ? { bid: r.bid } : {}),
    ...(r.ask !== undefined ? { ask: r.ask } : {}),
  }
}

export function fromOptionChain(chain: OptionChain): ArbitrageChain {
  return {
    underlying: chain.underlying,
    expiryMonth: chain.expiryMonth,
    // 快照时点作为评估时点：贴现因子 T 按链拍摄时刻计，盘后扫描不因墙钟漂移。
    ...(chain.expiryDate !== undefined ? { expiryDate: chain.expiryDate } : {}),
    ...(chain.spot !== undefined ? { spot: chain.spot } : {}),
    ...(chain.snapshotAt !== undefined ? { asOf: chain.snapshotAt } : {}),
    calls: chain.calls.map(mapRow),
    puts: chain.puts.map(mapRow),
  }
}
