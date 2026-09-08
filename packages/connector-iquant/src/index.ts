/**
 * @dshtrading/connector-iquant
 * 国信 iQuant 只行情。无 TradeService。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dshtrading/api'
import { IquantRestClient, type IquantRestOptions } from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-iquant'
export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'
export const ROUTER_PROVIDER = 'iquant'

export interface Config {
  enabled: boolean
  market: 'cn'
  gatewayUrl?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活国信 iQuant 行情'),
  market: Schema.union(['cn']).default('cn'),
  gatewayUrl: Schema.string().default('http://127.0.0.1:5810').description('iquant-quote 网关'),
})

export class IquantMarketDataService extends Service implements MarketDataService {
  private readonly client: IquantRestClient

  constructor(
    ctx: Context,
    options: IquantRestOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new IquantRestClient(options)
  }

  getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? 5_000, 1_000)
    const tick = (): void => {
      void this.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const id = setInterval(tick, ms)
    return () => clearInterval(id)
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new IquantMarketDataService(ctx, { gatewayUrl: config.gatewayUrl })
}
