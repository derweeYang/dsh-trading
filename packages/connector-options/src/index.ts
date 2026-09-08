/**
 * @dshtrading/connector-options
 * CN ETF 期权连接器：只读面 provide tradingCnOptions（python/options 网关），
 * 交易面 provide tradingCnOptionsTrade（QMT 网关期权通道，双闸照 connector-qmt 范式）。
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
  QmtOptionTradeRestClient,
  TradingServiceError,
  isKnownUnderlying,
  normalizeCnUnderlying,
  type OptionsRestOptions,
  type QmtOptionTradeOptions,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-options'

export const TRADING_CN_OPTIONS_KEY = 'tradingCnOptions'
export const TRADING_CN_OPTIONS_TRADE_KEY = 'tradingCnOptionsTrade'

export interface Config {
  enabled: boolean
  gatewayUrl?: string
  source?: OptionSource
  /** QMT 网关（live 期权下单/撤单/持仓），与 connector-qmt 共用同一网关进程。 */
  qmtGatewayUrl?: string
  /** QMT 资金账号（期权通道必填；dry-run 不需要）。 */
  accountId?: string
  /** 铁律 #3：缺省 true，placeOptionOrder 一律本地构造模拟回执。 */
  dryRun: boolean
  /** 铁律 #3：缺省 false，true 时才允许 dryRun=false 的实盘报单。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 ETF 期权连接器'),
  gatewayUrl: Schema.string().default('http://127.0.0.1:8090').description('python/options 行情网关地址'),
  source: Schema.union(['akshare', 'iquant', 'synth'] as const).default('akshare').description('行情内核 source：akshare 上交所研究级（深市 NO_DATA）、iquant 迅投研（沪深皆可达）、synth 离线确定性链'),
  qmtGatewayUrl: Schema.string().default('http://127.0.0.1:5800').description('QMT 网关地址（期权交易 live 路径）'),
  accountId: Schema.string().description('QMT 资金账号（期权通道必填）'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单（不触 QMT 网关）'),
  liveTrading: Schema.boolean().default(false).description('是否允许期权实盘交易'),
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

  listUnderlyings(source: OptionSource = 'akshare'): Promise<readonly OptionUnderlying[]> {
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
  private readonly client: QmtOptionTradeRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 总闸门，照 connector-qmt）。 */
  private readonly config: Config

  constructor(
    ctx: Context,
    options: QmtOptionTradeOptions & { config: Config },
    serviceName: string = TRADING_CN_OPTIONS_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new QmtOptionTradeRestClient(options)
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
    // 闸门 ③：live（dryRun=false 且 liveTrading=true）→ QMT 网关期权通道。
    const placed = await this.client.placeOptionOrder({
      symbol,
      side: request.side,
      offset: request.offset,
      orderType: request.orderType,
      ...(request.price !== undefined ? { price: request.price } : {}),
      quantity: request.quantity,
    })
    return {
      id: placed.id,
      symbol,
      side: request.side,
      offset: request.offset,
      orderType: request.orderType,
      status: placed.status === undefined ? 'new' : (placed.status as OptionOrder['status']),
      quantity: request.quantity,
      ...(request.price !== undefined ? { price: request.price } : {}),
      ...(request.price !== undefined ? { premiumAmount: premiumAmountOf(request.price, request.quantity, multiplier) } : {}),
      multiplier,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOptionOrder(orderId: string, _symbol?: string): Promise<void> {
    // 服务缝闸门（P0）：撤单是改变券商真实状态的实盘动作，与真实下单同门槛，
    // 防「经撤单接口绕过下单闸门」（connector-qmt 同款裁决）。
    if (!this.config.liveTrading || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'CnOptionsTradeService.cancelOptionOrder rejected at the service seam: cancel is a live action and requires liveTrading=true with dryRun=false.',
      )
    }
    return await this.client.cancelOptionOrder(orderId)
  }

  async listOptionPositions(): Promise<readonly OptionPosition[]> {
    // 只读面不走闸门（与 TradeService.getPositions 同语义）。
    const rows = await this.client.listOptionPositions()
    return rows.map((row) => ({
      symbol: row.option_code,
      underlying: row.underlying ?? normalizeCnUnderlying(row.option_code),
      optionType: row.option_type === 'P' ? 'P' : 'C',
      strike: row.strike ?? Number.NaN,
      expiryMonth: row.expiry_month ?? '',
      quantity: row.volume ?? 0,
      ...(row.avg_price !== undefined ? { avgPrice: row.avg_price } : {}),
      ...(row.margin !== undefined ? { marginOccupied: row.margin } : {}),
    }))
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new CnOptionsMarketService(ctx, optionsFromConfig(config))
  new CnOptionsTradeService(ctx, {
    ...(config.qmtGatewayUrl !== undefined ? { qmtGatewayUrl: config.qmtGatewayUrl } : {}),
    ...(config.accountId !== undefined ? { accountId: config.accountId } : {}),
    config,
  })
}

export function optionsFromConfig(config: Config): OptionsRestOptions {
  return {
    ...(config.gatewayUrl !== undefined ? { gatewayUrl: config.gatewayUrl } : {}),
    ...(config.source !== undefined ? { source: config.source } : {}),
  }
}
