/**
 * @dshtrading/connector-options
 * CN ETF 期权只读连接器：provide tradingCnOptions，不注册行情/交易注册表。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  CnOptionsQuery,
  CnOptionsService,
  OptionChain,
  OptionExpiryCalendar,
  OptionImpliedVolResult,
  OptionSource,
  OptionStrategyRequest,
  OptionStrategyResult,
  OptionUnderlying,
} from '@dshtrading/api'
import { OptionsRestClient, type OptionsRestOptions } from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-options'

export const TRADING_CN_OPTIONS_KEY = 'tradingCnOptions'

export interface Config {
  enabled: boolean
  gatewayUrl?: string
  source?: OptionSource
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 ETF 期权连接器'),
  gatewayUrl: Schema.string().default('http://127.0.0.1:8090').description('python/options HTTP 网关地址'),
  source: Schema.union(['akshare', 'synth'] as const).default('akshare').description('内核 source：akshare 实盘研究级，synth 离线确定性链'),
})

export class CnOptionsMarketService extends Service implements CnOptionsService {
  private readonly client: OptionsRestClient

  constructor(
    ctx: Context,
    options: OptionsRestOptions = {},
    serviceName: string = TRADING_CN_OPTIONS_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new OptionsRestClient(options)
  }

  listUnderlyings(source?: OptionSource): Promise<readonly OptionUnderlying[]> {
    return this.client.listUnderlyings(source)
  }

  getOptionExpiries(query: CnOptionsQuery): Promise<OptionExpiryCalendar> {
    return this.client.getOptionExpiries(query)
  }

  getOptionChain(query: CnOptionsQuery): Promise<OptionChain> {
    return this.client.getOptionChain(query)
  }

  getImpliedVol(query: CnOptionsQuery & { readonly rate: number }): Promise<OptionImpliedVolResult> {
    return this.client.getImpliedVol(query)
  }

  getStrategy(request: OptionStrategyRequest): Promise<OptionStrategyResult> {
    return this.client.getStrategy(request)
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new CnOptionsMarketService(ctx, optionsFromConfig(config))
}

export function optionsFromConfig(config: Config): OptionsRestOptions {
  return {
    ...(config.gatewayUrl !== undefined ? { gatewayUrl: config.gatewayUrl } : {}),
    ...(config.source !== undefined ? { source: config.source } : {}),
  }
}
