/**
 * Host 面「数据面」行（2026-08-30 注册表模式定稿，架构评审整改 #1）：cn 单市场。
 * 注册表模式下实例注册 (cn, 'tencent')，激活裁决推迟到消费方按路由当前值惰性解析
 * （GUI 热切换）；无注册表的老部署回退直接 provide 市场键（tradingCnMarketData）。
 * 只提供行情服务、不注册任何工具——工具面留在 preset 平面（会话隔离铁律）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { ROUTER_PROVIDER, TRADING_CN_MARKET_DATA_KEY, TencentMarketDataService, type Config } from './index.ts'
export const inject = ['tradingMarketDataRegistry']

/** 注册表服务的最小消费面（鸭式，不定死接口——连接器对 router 包保持零依赖，与 router consult 同纪律）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function ctxGet(ctx: Context, key: string): unknown {
  return (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get?.(key, false)
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退旧的直接 provide 路径。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = ctxGet(ctx, 'tradingMarketDataRegistry')
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

export function apply(ctx: Context, config: Config): void {
  const market = config.market
  const key = TRADING_CN_MARKET_DATA_KEY
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    if (ctxGet(ctx, key) !== undefined) return
    new TencentMarketDataService(ctx, {}, key)
    return
  }
  const inner = ctx.isolate(key)
  const service = new TencentMarketDataService(inner, {}, key)
  ctx.effect(() => registry.register(market, ROUTER_PROVIDER, service))
}
