/**
 * @dshtrading/connector-options
 * CN ETF 期权连接器：只读面 provide tradingCnOptions（python/options 网关），
 * 交易面 provide tradingCnOptionsTrade：dry-run 预览回执；live 已随 MiniQMT 删除。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  CnOptionsQuery,
  CnOptionsService,
  CnOptionsTradeService as CnOptionsTradeContract,
  KernelReport,
  OptionChain,
  OptionExpiryCalendar,
  OptionImpliedVolResult,
  OptionOrder,
  OptionOrderRequest,
  OptionParityQuery,
  OptionPosition,
  OptionPriceQuery,
  OptionSource,
  OptionStrategyRequest,
  OptionStrategyResult,
  OptionUnderlying,
  OptionUnderlyingDailyQuery,
  OptionVolAnalyticsQuery,
} from '@dshtrading/api'
import {
  OptionsRestClient,
  TradingServiceError,
  isKnownUnderlying,
  normalizeCnUnderlying,
  type OptionsRestOptions,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-options'

export const TRADING_CN_OPTIONS_KEY = 'tradingCnOptions'
export const TRADING_CN_OPTIONS_TRADE_KEY = 'tradingCnOptionsTrade'

export interface Config {
  enabled: boolean
  gatewayUrl?: string
  source?: OptionSource
  /** 铁律 #3：缺省 true，placeOptionOrder 一律本地构造模拟回执。 */
  dryRun: boolean
  /** 铁律 #3：缺省 false。live 路径已删除，true 时仍拒单。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 ETF 期权连接器'),
  gatewayUrl: Schema.string().default('http://127.0.0.1:8090').description('python/options 行情网关地址'),
  source: Schema.union(['akshare', 'iquant', 'synth'] as const).default('iquant').description('行情内核 source：默认 iquant（合约 SHO/SZO）；akshare 上交所研究级；synth 离线链'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单（不触券商）'),
  liveTrading: Schema.boolean().default(false).description('实盘总闸；live 路径已删除'),
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

  listUnderlyings(source: OptionSource = 'iquant'): Promise<readonly OptionUnderlying[]> {
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

  getVolAnalytics(query: OptionVolAnalyticsQuery): Promise<KernelReport> {
    return this.client.getVolAnalytics(query)
  }

  getUnderlyingDaily(query: OptionUnderlyingDailyQuery): Promise<KernelReport> {
    return this.client.getUnderlyingDaily(query)
  }

  getPrice(query: OptionPriceQuery): Promise<KernelReport> {
    return this.client.getPrice(query)
  }

  getParityCheck(query: OptionParityQuery): Promise<KernelReport> {
    return this.client.getParityCheck(query)
  }
}

/** 长代码 → 行权价/乘数解析（回执 premiumAmount 换算用）。 */
const LONG_CODE_PARTS = /^(\d{6})([CP])(\d{4})M(\d{5})$/i

function premiumAmountOf(price: number, quantity: number, multiplier: number): number {
  // price 已是「元/张」权利金口径：金额 = price × quantity × multiplier。
  return Number((price * quantity * multiplier).toFixed(2))
}

export class CnOptionsTradeService extends Service implements CnOptionsTradeContract {
  private readonly config: Config

  constructor(
    ctx: Context,
    options: { config: Config },
    serviceName: string = TRADING_CN_OPTIONS_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.config = options.config
  }

  async placeOptionOrder(request: OptionOrderRequest): Promise<OptionOrder> {
    // 入参规范化：长代码格式 + 数量 + 限价必带价格（dry-run/live 共用校验）。
    const symbol = request.symbol.trim().toUpperCase()
    if (!LONG_CODE_PARTS.test(symbol)) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `options order: symbol must be an option long code like 510050C2609M02850 (got ${request.symbol})`,
      )
    }
    const underlying = normalizeCnUnderlying(symbol)
    if (!isKnownUnderlying(underlying)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `options order: unknown underlying ${underlying}`)
    }
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `options order: quantity must be a positive integer of contracts (got ${request.quantity})`)
    }
    if (request.orderType === 'limit' && (request.price === undefined || !Number.isFinite(request.price) || request.price <= 0)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'options order: limit orders require a positive price')
    }
    const multiplier = 10000

    // 服务缝闸门（铁律 #3，与 QmtTradeService.placeOrder 同构三态）：
    const requestedDryRun = request.dryRun ?? true
    if (!requestedDryRun && !this.config.liveTrading) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `CnOptionsTradeService.placeOptionOrder rejected: the request asks for real execution (dryRun=${String(request.dryRun)}) `
          + 'but liveTrading=false — enable liveTrading explicitly or keep dryRun=true for a simulated receipt.',
      )
    }
    if (requestedDryRun || this.config.dryRun) {
      // 闸门 ②：本地模拟回执（含权利金金额换算，与 live 回执同形）。
      return {
        id: `dry-opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        side: request.side,
        offset: request.offset,
        orderType: request.orderType,
        status: 'filled',
        quantity: request.quantity,
        ...(request.price !== undefined ? { price: request.price } : {}),
        ...(request.price !== undefined ? { premiumAmount: premiumAmountOf(request.price, request.quantity, multiplier) } : {}),
        multiplier,
        dryRun: true,
        timestamp: Date.now(),
      }
    }
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'option live trading was removed with MiniQMT; keep dryRun=true for a preview receipt',
    )
  }

  async cancelOptionOrder(_orderId: string, _symbol?: string): Promise<void> {
    // 服务缝闸门（P0）：撤单是改变券商真实状态的实盘动作，与真实下单同门槛，
    // 防「经撤单接口绕过下单闸门」。
    if (!this.config.liveTrading || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'CnOptionsTradeService.cancelOptionOrder rejected at the service seam: cancel is a live action and requires liveTrading=true with dryRun=false.',
      )
    }
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'option cancel was removed with MiniQMT',
    )
  }

  async listOptionPositions(): Promise<readonly OptionPosition[]> {
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'option positions were removed with MiniQMT',
    )
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new CnOptionsMarketService(ctx, optionsFromConfig(config))
  new CnOptionsTradeService(ctx, { config })
}

export function optionsFromConfig(config: Config): OptionsRestOptions {
  return {
    ...(config.gatewayUrl !== undefined ? { gatewayUrl: config.gatewayUrl } : {}),
    ...(config.source !== undefined ? { source: config.source } : {}),
  }
}
