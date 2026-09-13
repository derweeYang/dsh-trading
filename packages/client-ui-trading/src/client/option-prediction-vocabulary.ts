/**
 * T+1 预测模块枚举 → 词典键（2026-09-12）。
 *
 * 盘势预期（6 类）/ 波动预期（2 类）/ 因子倾向（3 类）是闭集，看板、编辑器、
 * 跟踪回溯三处都要渲染。集中一处避免各写一份映射——漂移时只会「一处漏翻」，
 * 而这类漏翻在 UI 上就是直接露出英文枚举值。
 *
 * 值全部是 `@dshtrading/api` 的联合字面量，用 `satisfies` 让缺项在编译期就红。
 */
import type { MarketLocaleKey } from './contract.ts'
import type { MarketExpectation, PredictionBias, VolExpectation } from '@dshtrading/api'

/** 盘势预期（六分类）。 */
export const MARKET_EXPECTATION_KEY = {
  big_up: 'options.prediction.market.big_up',
  small_up: 'options.prediction.market.small_up',
  big_down: 'options.prediction.market.big_down',
  small_down: 'options.prediction.market.small_down',
  breakout: 'options.prediction.market.breakout',
  consolidation: 'options.prediction.market.consolidation',
} as const satisfies Record<MarketExpectation, MarketLocaleKey>

/** 波动预期（二分类）。 */
export const VOL_EXPECTATION_KEY = {
  up: 'options.prediction.vol.up',
  down: 'options.prediction.vol.down',
} as const satisfies Record<VolExpectation, MarketLocaleKey>

/** 单因子倾向（三分类）。 */
export const PREDICTION_BIAS_KEY = {
  bull: 'options.prediction.bias.bull',
  bear: 'options.prediction.bias.bear',
  neutral: 'options.prediction.bias.neutral',
} as const satisfies Record<PredictionBias, MarketLocaleKey>

/** 盘势预期顺序（看板/编辑器固定排列，breakout/consolidation 居中）。 */
export const MARKET_EXPECTATION_ORDER: readonly MarketExpectation[] = [
  'big_up', 'small_up', 'breakout', 'consolidation', 'small_down', 'big_down',
]

/** 盘势预期配色语义（data-kind，CSS 据此分色：涨红 / 跌绿 / 突破金 / 盘整灰）。 */
export const MARKET_EXPECTATION_KIND: Record<MarketExpectation, string> = {
  big_up: 'big_up',
  small_up: 'small_up',
  breakout: 'breakout',
  consolidation: 'consolidation',
  small_down: 'small_down',
  big_down: 'big_down',
}
