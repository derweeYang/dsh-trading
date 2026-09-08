import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { IquantMarketDataService, ROUTER_PROVIDER, TRADING_CN_MARKET_DATA_KEY, type Config } from './index.ts'

export const inject = ['tradingMarketDataRegistry']

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function ctxGet(ctx: Context, key: string): unknown {
  return (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get?.(key, false)
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = ctxGet(ctx, 'tradingMarketDataRegistry')
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const market = config.market ?? 'cn'
  const key = TRADING_CN_MARKET_DATA_KEY
  const registry = resolveMarketDataRegistry(ctx)
  const options = config.gatewayUrl !== undefined ? { gatewayUrl: config.gatewayUrl } : {}
  if (registry === undefined) {
    if (ctxGet(ctx, key) !== undefined) return
    new IquantMarketDataService(ctx, options, key)
    return
  }
  const inner = ctx.isolate(key)
  const service = new IquantMarketDataService(inner, options, key)
  ctx.effect(() => registry.register(market, ROUTER_PROVIDER, service))
}
