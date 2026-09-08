import type { Context } from '@deepseek-ai/cordis'
import { CnOptionsMarketService, optionsFromConfig, type Config } from './index.js'

export const inject: string[] = []

/**
 * Host 面数据行：在宿主 ctx 上 provide tradingCnOptions。
 * 不进 tradingMarketDataRegistry——CN 行情 provider（腾讯）没有期权链。
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new CnOptionsMarketService(ctx, optionsFromConfig(config))
}
