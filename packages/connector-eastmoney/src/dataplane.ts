import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { EastmoneyMarketDataService, TRADING_CN_MARKET_DATA_KEY, type Config } from './index.js'

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

const ROUTER_PROVIDER = 'eastmoney'
const MARKET = 'cn'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    if (ctxGet(ctx, TRADING_CN_MARKET_DATA_KEY) !== undefined) return
    new EastmoneyMarketDataService(ctx)
    return
  }
  const inner = ctx.isolate(TRADING_CN_MARKET_DATA_KEY)
  const service = new EastmoneyMarketDataService(inner)
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
