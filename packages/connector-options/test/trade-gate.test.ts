/**
 * 期权交易缝闸门（阶段 3 · 铁律 #3）：绕过工具层直调 CnOptionsTradeService 的
 * 三态矩阵（离线）。与 connector-qmt trade-gate.test.ts 同构——服务级 fail-closed：
 * liveTrading !== true 时拒绝实盘或模拟；=== true 且 config.dryRun=false 才放行
 * QMT 网关期权通道。撤单与真实下单同门槛（防绕过）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CnOptionsTradeService, type Config } from '../src/index.js'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    dryRun: true,
    liveTrading: false,
    ...overrides,
  }
}

function stubFetch(routes: Array<{ match: string; body: unknown }> = []) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find(r => url.includes(r.match))
    if (!route) throw new Error('unexpected request: ' + url)
    return new Response(JSON.stringify(route.body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, urls }
}

function makeService(config: Config, routes: Array<{ match: string; body: unknown }> = []) {
  const { impl, urls } = stubFetch(routes)
  // Service 基类需要活的 cordis context（connector-qmt trade-gate.test.ts 同款构造）。
  const trade = new CnOptionsTradeService(new CordisContext() as never, {
    accountId: 'ACC1',
    qmtGatewayUrl: 'http://127.0.0.1:5800',
    fetchImpl: impl,
    config,
  })
  return { trade, urls }
}

const LIVE_REQ = {
  symbol: '510050C2609M02850',
  side: 'buy' as const,
  offset: 'open' as const,
  orderType: 'limit' as const,
  quantity: 1,
  price: 0.0856,
  dryRun: false,
}

const QMT_PLACE_ROUTE = {
  match: '/api/v1/trade/option/order',
  body: { code: 0, data: { order_id: 'opt-live-1', status: 'new' } },
}

const QMT_POSITIONS_ROUTE = {
  match: '/api/v1/trade/option/positions',
  body: {
    code: 0,
    data: [{
      option_code: '510050C2609M02850',
      underlying: '510050',
      option_type: 'C',
      strike: 2.85,
      expiry_month: '2609',
      volume: 2,
      avg_price: 0.0856,
      margin: 0,
    }],
  },
}

describe('CnOptionsTradeService 服务缝闸门（三态矩阵，离线）', () => {
  it('① dryRun=false + liveTrading=false（缺省）→ TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.placeOptionOrder(LIVE_REQ)).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(urls).toHaveLength(0)
  })

  it('② dryRun 缺省直调 → 本地模拟回执（dryRun=true，含 premiumAmount 权利金换算），不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    const order = await trade.placeOptionOrder({
      symbol: '510050C2609M02850',
      side: 'buy',
      offset: 'open',
      orderType: 'limit',
      quantity: 2,
      price: 0.0856,
    })
    expect(order.dryRun).toBe(true)
    expect(order.status).toBe('filled')
    // premiumAmount = 0.0856 × 2 × 10000 = 1712 元
    expect(order.premiumAmount).toBe(1712)
    expect(order.multiplier).toBe(10000)
    expect(urls).toHaveLength(0)
  })

  it('② config.dryRun=true 强制模拟：liveTrading=true + dryRun=false 请求也回模拟回执，不触网', async () => {
    const { trade, urls } = makeService(baseConfig({ dryRun: true, liveTrading: true }))
    const order = await trade.placeOptionOrder(LIVE_REQ)
    expect(order.dryRun).toBe(true)
    expect(urls).toHaveLength(0)
  })

  it('③ live（liveTrading=true + config.dryRun=false + 请求 dryRun=false）→ 打 QMT 网关期权通道', async () => {
    const { trade, urls } = makeService(baseConfig({ dryRun: false, liveTrading: true }), [QMT_PLACE_ROUTE])
    const order = await trade.placeOptionOrder(LIVE_REQ)
    expect(order.dryRun).toBe(false)
    expect(order.id).toBe('opt-live-1')
    expect(order.status).toBe('new')
    expect(order.premiumAmount).toBe(856)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/v1/trade/option/order')
  })

  it('撤单与真实下单同门槛：缺省配置 → TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.cancelOptionOrder('opt-1')).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(urls).toHaveLength(0)
  })

  it('撤单 live 门槛放行 → 打 QMT 网关 /api/v1/trade/option/cancel', async () => {
    const { trade, urls } = makeService(
      baseConfig({ dryRun: false, liveTrading: true }),
      [{ match: '/api/v1/trade/option/cancel', body: { code: 0 } }],
    )
    await expect(trade.cancelOptionOrder('opt-1')).resolves.toBeUndefined()
    expect(urls).toHaveLength(1)
  })

  it('持仓只读面不走闸门 → 透传 QMT 网关并映射 OptionPosition', async () => {
    const { trade } = makeService(baseConfig(), [QMT_POSITIONS_ROUTE])
    const positions = await trade.listOptionPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({
      symbol: '510050C2609M02850',
      underlying: '510050',
      optionType: 'C',
      strike: 2.85,
      quantity: 2,
      avgPrice: 0.0856,
    })
  })
})

describe('CnOptionsTradeService 入参规范化（dry-run/live 共用校验）', () => {
  it('symbol 必须是期权长代码：现货符号/乱码 → TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.placeOptionOrder({ ...LIVE_REQ, symbol: '510050.SH' })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    await expect(trade.placeOptionOrder({ ...LIVE_REQ, symbol: 'AAPL' })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(0)
  })

  it('未知标的（名册外长代码）→ TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { trade } = makeService(baseConfig())
    await expect(trade.placeOptionOrder({ ...LIVE_REQ, symbol: '999999C2609M02850' })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('quantity 必须为正整数；limit 单必须带正价', async () => {
    const { trade } = makeService(baseConfig())
    await expect(trade.placeOptionOrder({ ...LIVE_REQ, quantity: 0 })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    await expect(trade.placeOptionOrder({ ...LIVE_REQ, quantity: 1.5 })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    const { price: _price, ...noPrice } = LIVE_REQ
    await expect(trade.placeOptionOrder(noPrice)).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})
