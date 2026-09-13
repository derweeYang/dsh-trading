/**
 * ETF 期权套利策略模块统一出口。
 * 纯函数、零运行时依赖、可浏览器打包；消费 ArbitrageChain（adapter.fromOptionChain 对接后端 OptionChain）。
 */

export * from './types.ts'
export * from './time.ts'
export * from './prices.ts'
export * from './parity.ts'
export * from './box.ts'
export * from './vertical.ts'
export * from './adapter.ts'

import type { ArbitrageChain, ArbitrageOpportunity } from './types.ts'
import { scanParityArbitrage } from './parity.ts'
import { scanBoxArbitrage } from './box.ts'
import type { ParityOptions } from './parity.ts'
import type { BoxOptions } from './box.ts'

export type ArbitrageScanOptions = ParityOptions & BoxOptions

/**
 * 扫描一个期权链的全部无风险套利机会（平价 + 箱型），按 edgePerContract 降序。
 * 垂直价差为方向性策略，不在此合并，请用 scanVerticalSpreads 单独获取。
 */
export function scanArbitrage(chain: ArbitrageChain, options: ArbitrageScanOptions = {}): ArbitrageOpportunity[] {
  const parity = scanParityArbitrage(chain, options)
  const box = scanBoxArbitrage(chain, options)
  return [...parity, ...box].sort((a, b) => b.edgePerContract - a.edgePerContract)
}
