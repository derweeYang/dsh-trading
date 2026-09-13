/**
 * 行情桥单测：市场清单、批量报价（逐 symbol 独立成败 + 封顶）、K线透传与
 * 参数校验、请求分发路由与协议错误。宿主面全部用假件（不触网）。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService, NewsAggregator } from '@dshtrading/api'
import { OPTIONS_DATA_ENV, resolvePredictionAutoAsOf, shanghaiCalendarDate } from '@dshtrading/kit-cn'
import { createMemoryHoldingsStore } from '@dshtrading/holdings'
import { createMemoryCustomStrategyStore } from '@dshtrading/strategies'
import {
  BridgeProtocolError,
  MARKET_SERVICE_KEYS,
  MAX_SYMBOLS,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  errorPayload,
  type BridgeHost,
} from '../src/bridge.ts'

// 基本面 pkg 下钻（kit-cn）在单测里绝不触网：全局 fetch 桩，
// kit 层 fetchJsonUpstream 拿到 rejection 后按契约静默降级（snapshot 兜底）。
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('bridge.test must not hit network')
}))

function fakeService(overrides: Partial<MarketDataService> = {}): MarketDataService {
  return {
    getTicker: async (symbol) => ({
      symbol, price: 100, timestamp: 1234,
    }),
    getKlines: async () => [{
      openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: 2,
    }],
    subscribeTicker: () => ({ dispose() {} }),
    ...overrides,
  }
}

function fakeHost(services: Partial<Record<string, MarketDataService>>, providers: Record<string, string> = {}): BridgeHost {
  return {
    // 键 = 服务键（真实宿主按 MARKET_SERVICE_KEYS 映射），与 index.ts 行为一致。
    getMarketService: market => services[MARKET_SERVICE_KEYS[market]],
    activeProvider: market => providers[market],
  }
}

describe('TradingBridge.markets', () => {
  it('只列已安装市场并带 provider slug', () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }, { cn: 'tencent' }))
    expect(bridge.markets()).toEqual({ markets: [{ id: 'cn', provider: 'tencent' }] })
  })

  it('零市场安装 → 空清单（headless/无市场包）', () => {
    expect(new TradingBridge(fakeHost({})).markets()).toEqual({ markets: [] })
  })
})

describe('TradingBridge.tickers', () => {
  it('批量报价：逐 symbol 独立成功/失败', async () => {
    const service = fakeService({
      getTicker: async (symbol) => {
        if (symbol === 'BAD') throw Object.assign(new Error('unknown symbol'), { code: 'TRADING_UNSUPPORTED_SYMBOL' })
        return { symbol, price: 7, timestamp: 9 }
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const wire = await bridge.tickers('cn', ['600519.SH', 'BAD', '600519.SH'])
    expect(Object.keys(wire.tickers).sort()).toEqual(['600519.SH', 'BAD'])
    expect(wire.tickers['600519.SH']).toEqual({ ok: true, ticker: { symbol: '600519.SH', price: 7, timestamp: 9 } })
    expect(wire.tickers.BAD).toEqual({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL', message: 'unknown symbol' })
  })

  it('未安装市场 → 400 协议错误；超封顶 → 400；空 symbols → 400', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    await expect(bridge.tickers('cn', ['600519'])).rejects.toThrowError(BridgeProtocolError)
    await expect(bridge.tickers('cn', Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => `S${i}`)))
      .rejects.toThrowError(/too many symbols/)
    await expect(bridge.tickers('cn', [''])).rejects.toThrowError(/symbols is required/)
  })
})

describe('TradingBridge.klines', () => {
  it('透传 interval 与 limit，返回服务结果', async () => {
    const service = fakeService()
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const wire = await bridge.klines('cn', '600519.SH', '1w', '40')
    expect(wire.klines).toHaveLength(1)
  })

  it('非法 limit → 400；未安装市场 → 400', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    await expect(bridge.klines('cn', '600519.SH', '1w', '0')).rejects.toThrowError(/limit/)
    await expect(bridge.klines('cn', '600519.SH', '1d')).rejects.toThrowError(/not installed/)
  })
})

describe('TradingBridge.symbols', () => {
  it('服务实现 listInstruments 时返回标的名册并缓存', async () => {
    let callCount = 0
    const service = fakeService({
      listInstruments: async () => {
        callCount++
        return [{ symbol: '600519.SH', name: '贵州茅台' }, { symbol: '000001.SZ' }]
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const res1 = await bridge.symbols('cn')
    expect(res1.symbols).toEqual([
      { symbol: '600519.SH', name: '贵州茅台' },
      { symbol: '000001.SZ' },
    ])
    expect(callCount).toBe(1)

    // 第二次调用命中进程内 TTL 缓存
    const res2 = await bridge.symbols('cn')
    expect(res2.symbols).toHaveLength(2)
    expect(callCount).toBe(1)
  })

  it('服务未实现 listInstruments 时静默返回空数组', async () => {
    const service = fakeService()
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const res = await bridge.symbols('cn')
    expect(res.symbols).toEqual([])
  })

  it('未安装市场 → 400', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    await expect(bridge.symbols('cn')).rejects.toThrowError(BridgeProtocolError)
  })
})

describe('TradingBridge.fundamentals（2026-09-02 基本面页签，整改后语义）', () => {
  // 整改（2026-09-02）：pkg 下钻不要求连接器实现 getFundamentals（kit-cn 直接可达）；
  // 快照与 pkg 并行、各自失败只降级自己；双失败才 TRADING_NOT_IMPLEMENTED；
  // 5min TTL + in-flight 去重。kit 下钻在本测试环境走真实网络语义（无网则 catch 降级），
  // 快照路径断言不依赖 pkg 成败。
  it('快照可用（连接器实现 getFundamentals）→ 直接返回快照', async () => {
    const service = fakeService({
      getFundamentals: async (symbol: string) => ({
        symbol, name: '贵州茅台', marketCap: 1_621_856_000_000, peTtm: 19.7,
        fiftyTwoWeekHigh: 1539.98, fiftyTwoWeekLow: 1151.01, timestamp: 1234,
      }),
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const search = new URLSearchParams({ market: 'cn', symbol: '600519.SH' })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search)
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, fundamentals: { symbol: '600519.SH', peTtm: 19.7 } })
  })

  it('连接器未实现 getFundamentals 且 pkg 下钻不可用 → TRADING_NOT_IMPLEMENTED（诚实空态）', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))
    const search = new URLSearchParams({ market: 'cn', symbol: '600519.SH' })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('未知市场 400；缺 symbol 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fundamentals', new URLSearchParams({ market: 'jp', symbol: 'X' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fundamentals', new URLSearchParams({ market: 'cn' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })

  it('TTL 缓存 + in-flight 去重：同键并发/连续调用只打一轮快照上游', async () => {
    let calls = 0
    const service = fakeService({
      getFundamentals: async (symbol: string) => {
        calls++
        return { symbol, peTtm: 20, timestamp: 1 }
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const search = new URLSearchParams({ market: 'cn', symbol: '600519.SH' })
    const [a, b] = await Promise.all([
      dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search),
      dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search),
    ])
    await dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search)
    expect(a.payload).toMatchObject({ ok: true })
    expect(b.payload).toMatchObject({ ok: true })
    expect(calls).toBe(1)
  })
})

describe('TradingBridge.orderbook + trades（issue #39 盘口竖栏）', () => {
  it('/orderbook 透传；/trades 透传 limit', async () => {
    const service = fakeService({
      getOrderbook: async (symbol: string) => ({
        symbol, timestamp: 1234,
        bids: [{ price: 99, amount: 5 }, { price: 98, amount: 10 }],
        asks: [{ price: 100, amount: 8 }, { price: 101, amount: 2 }],
      }),
      getRecentTrades: async (symbol: string, limit?: number) => ([
        { id: '1', symbol, price: 99, amount: 1, side: 'sell' as const, timestamp: 100 },
        { id: '2', symbol, price: 100, amount: 2, side: 'buy' as const, timestamp: 1234, ...(limit !== undefined ? {} : {}) },
      ]),
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const { payload: book } = await dispatchBridgeRequest(bridge, 'GET', '/orderbook', new URLSearchParams({ market: 'cn', symbol: '600519.SH' }))
    expect(book).toMatchObject({ ok: true, orderbook: { symbol: '600519.SH', bids: [{ price: 99, amount: 5 }, { price: 98, amount: 10 }] } })
    const { payload: trades } = await dispatchBridgeRequest(bridge, 'GET', '/trades', new URLSearchParams({ market: 'cn', symbol: '600519.SH', limit: '50' }))
    expect(trades).toMatchObject({ ok: true, trades: [{ id: '1' }, { id: '2' }] })
  })

  it('未实现 getOrderbook → TRADING_NOT_IMPLEMENTED；缺 symbol 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/orderbook', new URLSearchParams({ market: 'cn', symbol: '600519.SH' })))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/trades', new URLSearchParams({ market: 'cn', symbol: '' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })

  it('/trades 非法 limit → 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/trades', new URLSearchParams({ market: 'cn', symbol: '600519.SH', limit: '0' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })
})

describe('TradingBridge.trade/*（issue #40 交易台：只读 + 强制 dry-run）', () => {
  function tradeService(overrides: Partial<import('@dshtrading/api').TradeService> = {}): import('@dshtrading/api').TradeService {
    return {
      placeOrder: async (req) => ({
        id: 'dry-1', symbol: req.symbol, side: req.side, type: req.type,
        status: 'filled', quantity: req.quantity, dryRun: true, timestamp: 1,
      }),
      cancelOrder: async () => {},
      getOrder: async (_symbol, id) => ({
        id, symbol: _symbol, side: 'buy', type: 'limit', status: 'new', quantity: 1, dryRun: false, timestamp: 1,
      }),
      getPositions: async () => [{ symbol: '510050.SH', side: 'long', size: 2, entryPrice: 2.85, unrealizedPnl: 0.01, timestamp: 1 }],
      ...overrides,
    }
  }

  function tradeHost(service: import('@dshtrading/api').TradeService | undefined): BridgeHost {
    return {
      getMarketService: market => market === 'cn' ? fakeService() : undefined,
      activeProvider: () => 'iquant',
      getTradeService: market => market === 'cn' ? service : undefined,
    }
  }

  it('/trade/positions、/trade/orders、/trade/fills、/trade/balances 只读透传', async () => {
    const service = tradeService({
      getBalances: async () => [{ asset: 'CNY', free: 100000, locked: 0 }],
      listOpenOrders: async () => [],
      listTradeFills: async () => [{ id: 'f1', symbol: '510050.SH', side: 'buy', price: 2.85, amount: 2, timestamp: 1 }],
    })
    const bridge = new TradingBridge(tradeHost(service))
    const { payload: positionWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/positions', new URLSearchParams({ market: 'cn' }))
    expect(positionWire).toMatchObject({ ok: true, positions: [{ symbol: '510050.SH', side: 'long' }] })
    const { payload: balanceWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/balances', new URLSearchParams({ market: 'cn' }))
    expect(balanceWire).toMatchObject({ ok: true, balances: [{ asset: 'CNY', free: 100000 }] })
    const { payload: orderWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/orders', new URLSearchParams({ market: 'cn' }))
    expect(orderWire).toMatchObject({ ok: true, orders: [] })
    const { payload: fillWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/fills', new URLSearchParams({ market: 'cn' }))
    expect(fillWire).toMatchObject({ ok: true, fills: [{ id: 'f1' }] })
  })

  it('POST /trade/order：默认发起实盘报单（dryRun: false）；可显式指定', async () => {
    const placeOrder = vi.fn(async (req: { dryRun?: boolean }) => ({
      id: 'ord-live-1', symbol: req.symbol, side: req.side, type: req.type,
      status: 'filled' as const, quantity: req.quantity, dryRun: req.dryRun ?? false, timestamp: 1,
    }))
    const bridge = new TradingBridge(tradeHost(tradeService({ placeOrder: placeOrder as never })))
    const { payload } = await dispatchBridgeRequest(
      bridge, 'POST', '/trade/order',
      new URLSearchParams({ market: 'cn' }),
      { symbol: '510050.SH', side: 'buy', type: 'limit', quantity: 2, price: 2.85 },
    )
    expect(payload).toMatchObject({ ok: true, order: { dryRun: false, symbol: '510050.SH' } })
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: '510050.SH', dryRun: false, price: 2.85 }))
  })

  it('limit 单缺价格 → 400；数量非法 → 400；交易服务未注册 → 400', async () => {
    const bridge = new TradingBridge(tradeHost(tradeService()))
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/trade/order', new URLSearchParams({ market: 'cn' }),
      { symbol: '510050.SH', side: 'buy', type: 'limit', quantity: 2 },
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/trade/order', new URLSearchParams({ market: 'cn' }),
      { symbol: '510050.SH', side: 'buy', type: 'market', quantity: -1 },
    )).rejects.toMatchObject({ status: 400 })
    // 交易服务未注册（合法市场、无 TradeService）→ 400
    const noTrade = new TradingBridge(tradeHost(undefined))
    await expect(dispatchBridgeRequest(
      noTrade, 'GET', '/trade/positions', new URLSearchParams({ market: 'cn' }),
    )).rejects.toMatchObject({ status: 400 })
  })

  it('交易服务未注册 → 400 + code TRADING_NO_TRADE_SERVICE（2026-09-04：前端区分服务未挂与凭证缺失）', async () => {
    const bridge = new TradingBridge(tradeHost(undefined))
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/trade/positions', new URLSearchParams({ market: 'cn' }),
    )).rejects.toMatchObject({ status: 400, code: 'TRADING_NO_TRADE_SERVICE' })
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/trade/balances', new URLSearchParams({ market: 'cn' }),
    )).rejects.toMatchObject({ status: 400, code: 'TRADING_NO_TRADE_SERVICE' })
  })

  it('DELETE /trade/order：调用 cancelOrder 成功返回 { ok: true, canceled: true }', async () => {
    const cancelOrder = vi.fn(async (_id: string, _sym?: string) => {})
    const bridge = new TradingBridge(tradeHost(tradeService({ cancelOrder })))
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order',
      new URLSearchParams({ market: 'cn', id: 'ord-123', symbol: '510050.SH' }),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, canceled: true })
    expect(cancelOrder).toHaveBeenCalledWith('ord-123', '510050.SH')
  })

  it('DELETE /trade/order：缺 market 或缺 id → 400', async () => {
    const bridge = new TradingBridge(tradeHost(tradeService()))
    await expect(dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order', new URLSearchParams({ market: 'cn' }),
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order', new URLSearchParams({ id: 'ord-1' }),
    )).rejects.toMatchObject({ status: 400 })
  })
})

describe('dispatchBridgeRequest', () => {
  const bridge = new TradingBridge(fakeHost({
    tradingCnMarketData: fakeService({
      listInstruments: async () => [{ symbol: '600519.SH' }],
    }),
  }))

  it('GET /markets → 200', async () => {
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/markets', new URLSearchParams())
    expect(status).toBe(200)
    expect(payload).toEqual({ markets: [{ id: 'cn' }] })
  })

  it('GET /tickers → 200 批量', async () => {
    const search = new URLSearchParams({ market: 'cn', symbols: '600519.SH' })
    const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/tickers', search)
    expect(payload).toMatchObject({ tickers: { '600519.SH': { ok: true } } })
  })

  it('GET /symbols → 200', async () => {
    const search = new URLSearchParams({ market: 'cn' })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/symbols', search)
    expect(status).toBe(200)
    expect(payload).toEqual({ symbols: [{ symbol: '600519.SH' }] })
  })

  it('未知端点 404；未支持的 HTTP 方法 405（issue #32 起支持 GET/PUT/POST/DELETE）', async () => {
    await expect(dispatchBridgeRequest(bridge, 'GET', '/nope', new URLSearchParams()))
      .rejects.toThrowError(/no such endpoint/)
    await expect(dispatchBridgeRequest(bridge, 'POST', '/markets', new URLSearchParams()))
      .rejects.toThrowError(/no such endpoint/)
    await expect(dispatchBridgeRequest(bridge, 'PATCH', '/markets', new URLSearchParams()))
      .rejects.toThrowError(/only GET\/PUT\/POST\/DELETE/)
  })

  it('GET /indicators/custom & DELETE /indicators/custom', async () => {
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/indicators/custom', new URLSearchParams())
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, indicators: [] })

    const delRes = await dispatchBridgeRequest(bridge, 'DELETE', '/indicators/custom', new URLSearchParams({ id: 'test' }))
    expect(delRes.status).toBe(200)
    expect(delRes.payload).toEqual({ ok: true, removed: false })
  })
})


describe('createBridgeHost（registry-first，2026-08-30 整改 #1）', () => {
  it('注册表有激活项 → 用注册表服务；路由切换后即刻解析到新服务（热切换）', async () => {
    const tencent = fakeService({ getTicker: async (symbol) => ({ symbol, price: 1, timestamp: 1 }) })
    const eastmoney = fakeService({ getTicker: async (symbol) => ({ symbol, price: 2, timestamp: 2 }) })
    let routed: string | undefined = 'tencent'
    const registry = {
      active: (market: string) => {
        if (market !== 'cn' || routed === undefined) return undefined
        return { provider: routed, service: routed === 'eastmoney' ? eastmoney : tencent }
      },
    }
    const host = createBridgeHost({ registry, legacy: () => undefined })
    const bridge = new TradingBridge(host)
    expect(host.activeProvider('cn')).toBe('tencent')
    let wire = await bridge.tickers('cn', ['600519.SH'])
    expect(wire.tickers['600519.SH']).toMatchObject({ ok: true, ticker: { price: 1 } })
    routed = 'eastmoney' // 模拟 settings 变更（无需重启、无需 watch）
    wire = await bridge.tickers('cn', ['600519.SH'])
    expect(wire.tickers['600519.SH']).toMatchObject({ ok: true, ticker: { price: 2 } })
    expect(host.activeProvider('cn')).toBe('eastmoney')
  })

  it('注册表选中但未注册（包未装）→ 400 未安装，不静默降级；activeProvider 回退 router 值', () => {
    const host = createBridgeHost({
      registry: { active: () => undefined },
      router: { activeProvider: () => 'eastmoney' },
      legacy: () => undefined,
    })
    expect(host.getMarketService('cn')).toBeUndefined()
    expect(host.activeProvider('cn')).toBe('eastmoney') // 用户能看到设置目标
  })

  it('注册表缺席（老部署）→ 回退 legacy 市场键直读', async () => {
    const legacy = fakeService()
    const host = createBridgeHost({ legacy: () => legacy })
    const wire = await new TradingBridge(host).tickers('cn', ['600519.SH'])
    expect(wire.tickers['600519.SH']).toMatchObject({ ok: true })
    expect(host.activeProvider('cn')).toBeUndefined()
  })
})

describe('TradingBridge.knowledgeCards', () => {
  it('GET /knowledge/cards 端点返回知识卡片列表', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    const res = await dispatchBridgeRequest(bridge, 'GET', '/knowledge/cards', new URLSearchParams())
    expect(res.status).toBe(200)
    expect(res.payload).toMatchObject({ ok: true, cards: [] })
  })
})

describe('TradingBridge.customStrategies（issue #31 / P2）', () => {
  const RECORD = {
    id: 'demo-fs',
    title: '演示策略',
    horizon: 'swing',
    summary: '演示用',
    paramsJson: '[]',
    computeSource: '(bars) => []',
    createdAt: 1700000000000,
  }

  it('GET /strategies/custom 返回自定义策略名册', async () => {
    const host = createBridgeHost({ legacy: () => undefined, strategyStore: createMemoryCustomStrategyStore([RECORD]) })
    const res = await dispatchBridgeRequest(new TradingBridge(host), 'GET', '/strategies/custom', new URLSearchParams())
    expect(res.status).toBe(200)
    expect(res.payload).toMatchObject({ ok: true, strategies: [RECORD] })
  })

  it('DELETE /strategies/custom?id= 删除并回执 removed；缺 id → 400', async () => {
    const host = createBridgeHost({ legacy: () => undefined, strategyStore: createMemoryCustomStrategyStore([RECORD]) })
    const bridge = new TradingBridge(host)
    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', new URLSearchParams({ id: 'demo-fs' }))
    expect(del.payload).toMatchObject({ ok: true, removed: true })
    const after = await dispatchBridgeRequest(bridge, 'GET', '/strategies/custom', new URLSearchParams())
    expect((after.payload as { strategies: unknown[] }).strategies).toHaveLength(0)
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', new URLSearchParams()))
      .rejects.toThrowError(/id is required/)
  })

  it('strategyStore 缺席 → 空名册 + removed:false（老部署降级）', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    const list = await dispatchBridgeRequest(bridge, 'GET', '/strategies/custom', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, strategies: [] })
    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', new URLSearchParams({ id: 'x' }))
    expect(del.payload).toMatchObject({ ok: true, removed: false })
  })
})

describe('watchlist + selection endpoints（issue #32 / P3）', () => {
  function makeWatchlistHost() {
    const host = createBridgeHost({ legacy: () => undefined })
    return { host, bridge: new TradingBridge(host) }
  }

  it('POST /watchlists 追加行（幂等 added）→ GET 可见 → DELETE 移除', async () => {
    const { bridge } = makeWatchlistHost()
    const add = await dispatchBridgeRequest(bridge, 'POST', '/watchlists', new URLSearchParams(), { market: 'cn', symbol: '600036', name: '招商银行' })
    expect(add.payload).toMatchObject({ ok: true, added: true, instrument: { market: 'cn', symbol: '600036' } })
    const dup = await dispatchBridgeRequest(bridge, 'POST', '/watchlists', new URLSearchParams(), { market: 'cn', symbol: '600036' })
    expect((dup.payload as { added: boolean }).added).toBe(false)

    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(list.payload).toMatchObject({
      ok: true,
      watchlists: {
        cn: [
          { market: 'cn', symbol: '600519', name: '贵州茅台' },
          { market: 'cn', symbol: '000001', name: '平安银行' },
          { market: 'cn', symbol: '601318', name: '中国平安' },
          { market: 'cn', symbol: '510050', name: '上证50ETF' },
          { market: 'cn', symbol: '600036', name: '招商银行' },
        ],
      },
    })

    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/watchlists', new URLSearchParams({ market: 'cn', symbol: '600036' }))
    expect(del.payload).toMatchObject({ ok: true, removed: true })
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/watchlists', new URLSearchParams({ market: 'cn' })))
      .rejects.toThrowError(/market and symbol are required/)
  })

  it('PUT /watchlists 全量替换 + 形状校验 400', async () => {
    const { bridge } = makeWatchlistHost()
    const put = await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { cn: [{ market: 'cn', symbol: '510050', name: '上证50ETF' }] },
    })
    expect(put.payload).toMatchObject({ ok: true, watchlists: { cn: [{ symbol: '510050' }] } })
    await expect(dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { cn: [{ symbol: '' }] },
    })).rejects.toThrowError(/string symbol/)
  })

  it('POST /watchlists/import：host 为空导入成功；非空拒绝（幂等）', async () => {
    const { bridge } = makeWatchlistHost()
    const first = await dispatchBridgeRequest(bridge, 'POST', '/watchlists/import', new URLSearchParams(), {
      watchlists: { cn: [{ market: 'cn', symbol: '510050', name: '上证50ETF' }] },
    })
    expect(first.payload).toMatchObject({ ok: true, imported: true })
    const second = await dispatchBridgeRequest(bridge, 'POST', '/watchlists/import', new URLSearchParams(), {
      watchlists: { cn: [{ market: 'cn', symbol: '600519' }] },
    })
    expect(second.payload).toMatchObject({ ok: false, imported: false })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    // 第二次导入被幂等拒绝：cn 键仍是首次导入的内容
    expect((list.payload as { watchlists: { cn?: Array<{ symbol: string }> } }).watchlists.cn)
      .toEqual([{ market: 'cn', symbol: '510050', name: '上证50ETF' }])
  })

  it('PUT/GET /selection：设置与读取；非字符串字段容错', async () => {
    const { bridge } = makeWatchlistHost()
    await dispatchBridgeRequest(bridge, 'PUT', '/selection', new URLSearchParams(), {
      instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' },
    })
    const got = await dispatchBridgeRequest(bridge, 'GET', '/selection', new URLSearchParams())
    expect(got.payload).toMatchObject({ ok: true, instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' } })
    const nulled = await dispatchBridgeRequest(bridge, 'PUT', '/selection', new URLSearchParams(), { instrument: null })
    expect(nulled.payload).toMatchObject({ ok: true, instrument: null })
  })

  it('store 缺席（老部署）→ 全部端点空降级', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, watchlists: {} })
    const sel = await dispatchBridgeRequest(bridge, 'GET', '/selection', new URLSearchParams())
    expect(sel.payload).toMatchObject({ ok: true, instrument: null })
  })
})

describe('TradingBridge.news（issue #37 新闻聚合；2026-09-02 评审 M3/M6 整改）', () => {
  function newsHost(aggregator: NewsAggregator): BridgeHost {
    return {
      getMarketService: () => undefined,
      activeProvider: () => undefined,
      newsRegistry: { register: () => () => {}, get: (market) => market === 'cn' ? aggregator : undefined },
    }
  }

  const item = (source: string, title: string, publishedAt: string) => ({ source, title, url: `https://x/${title}`, publishedAt })

  it('非法 limit → 400（非整数/越界/未知市场）', async () => {
    const bridge = new TradingBridge(newsHost(async () => ({ items: [], unavailable: [] })))
    await expect(bridge.news('cn', '600519.SH', '0')).rejects.toThrowError(/limit/)
    await expect(bridge.news('cn', '600519.SH', 'abc')).rejects.toThrowError(/limit/)
    await expect(bridge.news('cn', '600519.SH', String(51))).rejects.toThrowError(/limit/)
    await expect(bridge.news('jp', '600519.SH', null)).rejects.toThrowError(/unknown market/)
  })

  it('有媒体快讯 → registry 聚合器结果透传', async () => {
    let calls = 0
    const aggregator: NewsAggregator = async () => {
      calls++
      return { items: [item('eastmoney', '茅台快讯', '2026-09-02T10:00:00Z')], unavailable: [] }
    }
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('cn', '600519.SH', '10')
    expect(calls).toBe(1)
    expect(wire.ok).toBe(true)
    expect(wire.items).toHaveLength(1)
    expect(wire.items[0]?.source).toBe('eastmoney')
  })

  it('仅剩公告（东财公告）→ 原样保留公告，不回退大盘要闻（2026-09-03 owner 裁决）', async () => {
    let calls = 0
    const aggregator: NewsAggregator = async (options) => {
      calls++
      if (options?.symbol !== undefined) {
        return { items: [item('eastmoney-announcement', '关于回购公司股份的公告', '2026-09-01T09:00:00Z')], unavailable: [] }
      }
      return {
        items: [
          item('eastmoney', 'macro newest', '2026-09-02T12:00:00Z'),
          item('eastmoney', 'macro mid', '2026-09-02T08:00:00Z'),
        ],
        unavailable: [],
      }
    }
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('cn', '600519.SH', '2')
    expect(calls).toBe(1)
    expect(wire.items.map(it => it.title)).toEqual(['关于回购公司股份的公告'])
  })

  it('无任何相关内容 → 空列表透传（前端展示空态，不兜底市场要闻）', async () => {
    let calls = 0
    const aggregator: NewsAggregator = async () => {
      calls++
      return { items: [], unavailable: [] }
    }
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('cn', '600519.SH', '10')
    expect(calls).toBe(1)
    expect(wire.items).toEqual([])
    expect(wire.unavailable).toEqual([])
  })

  it('公告源挂掉 → unavailable 注明，不与「暂无公告」混淆', async () => {
    const aggregator: NewsAggregator = async () => ({ items: [], unavailable: ['eastmoney-announcement: HTTP 503'] })
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('cn', '600519.SH', null)
    expect(wire.unavailable).toEqual(['eastmoney-announcement: HTTP 503'])
    expect(wire.items).toEqual([])
  })
})

describe('errorPayload', () => {
  it('带 code 的 Error 提取词汇，普通 Error 落 TRADING_UNKNOWN，非 Error 字符串化', () => {
    expect(errorPayload(Object.assign(new Error('x'), { code: 'TRADING_NETWORK' })))
      .toEqual({ code: 'TRADING_NETWORK', message: 'x' })
    expect(errorPayload(new Error('y')).code).toBe('TRADING_UNKNOWN')
    expect(errorPayload('boom')).toEqual({ code: 'TRADING_UNKNOWN', message: 'boom' })
  })
})

describe('TradingBridge option paper account', () => {
  it('GET account, GET fills, and POST reset use the configured data root', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-paper-bridge-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const date = shanghaiCalendarDate(Date.now())
    await mkdir(path.join(dir, 'paper', 'fills'), { recursive: true })
    await writeFile(path.join(dir, 'paper', 'fills', `${date}.jsonl`), [
      JSON.stringify({ id: 'old', bucketStart: 'a', asOf: 'a', offset: 'open', qty: 0, legs: [], premiumCny: 0, marginCny: 0, cashAfter: 100000, reason: 'skipped', skip: 'no_quote' }),
      JSON.stringify({ id: 'new', bucketStart: 'b', asOf: 'b', offset: 'open', qty: 0, legs: [], premiumCny: 0, marginCny: 0, cashAfter: 100000, reason: 'skipped', skip: 'no_quote' }),
    ].join('\n') + '\n', 'utf8')
    const bridge = new TradingBridge(fakeHost({}))
    try {
      const account = await dispatchBridgeRequest(
        bridge, 'GET', '/options/paper/account', new URLSearchParams(),
      )
      expect(account.payload).toMatchObject({
        ok: true,
        account: { initialCash: 100000, cash: 100000 },
        equity: 100000,
        positions: [],
      })

      const fills = await dispatchBridgeRequest(
        bridge, 'GET', '/options/paper/fills', new URLSearchParams({ limit: '1' }),
      )
      expect(fills.payload).toMatchObject({ ok: true, fills: [{ id: 'new' }] })
      await expect(dispatchBridgeRequest(
        bridge, 'GET', '/options/paper/fills', new URLSearchParams({ limit: '0' }),
      )).rejects.toMatchObject({ status: 400 })

      const reset = await dispatchBridgeRequest(
        bridge, 'POST', '/options/paper/reset', new URLSearchParams(),
      )
      expect(reset.payload).toMatchObject({
        ok: true,
        account: { initialCash: 100000, cash: 100000 },
        equity: 100000,
        positions: [],
      })
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('多账本：/options/paper/accounts 双账本一次返回；book 参数路由；非法 book 400', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-paper-books-bridge-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const bridge = new TradingBridge(fakeHost({}))
    try {
      const accounts = await dispatchBridgeRequest(
        bridge, 'GET', '/options/paper/accounts', new URLSearchParams(),
      )
      expect(accounts.payload).toMatchObject({
        ok: true,
        books: [
          { book: 'arbitrage', account: { initialCash: 100000, cash: 100000 }, equity: 100000, positions: [] },
          { book: 'strategy', account: { initialCash: 100000, cash: 100000 }, equity: 100000, positions: [] },
        ],
      })

      const arbFills = await dispatchBridgeRequest(
        bridge, 'GET', '/options/paper/fills', new URLSearchParams({ book: 'arbitrage' }),
      )
      expect(arbFills.payload).toMatchObject({ ok: true, fills: [] })

      await expect(dispatchBridgeRequest(
        bridge, 'GET', '/options/paper/account', new URLSearchParams({ book: 'nope' }),
      )).rejects.toMatchObject({ status: 400 })
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('keeps equity at initial cash when opening marks are unchanged', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-paper-equity-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const asOf = new Date().toISOString()
    await mkdir(path.join(dir, 'paper'), { recursive: true })
    await writeFile(path.join(dir, 'paper', 'account.json'), `${JSON.stringify({
      currency: 'CNY',
      initialCash: 100000,
      cash: 99936,
      realizedPnl: 0,
      updatedAt: asOf,
    })}\n`, 'utf8')
    await writeFile(path.join(dir, 'paper', 'positions.json'), `${JSON.stringify([{
      id: '588000:bucket',
      underlying: '588000',
      template: 'vertical',
      openedBucketStart: asOf,
      invalidIf: 'x',
      qty: 1,
      marginCny: 282,
      legs: [
        { code: '588000C2609M01700', side: 'sell', qty: 1, fillPrice: 0.0566 },
        { code: '588000C2609M01750', side: 'buy', qty: 1, fillPrice: 0.0348 },
      ],
    }])}\n`, 'utf8')
    const bridge = new TradingBridge({
      ...fakeHost({}),
      getCnOptions: () => ({
        getOptionChain: async () => ({
          underlying: '588000',
          expiryMonth: '2609',
          source: 'iquant',
          calls: [
            { code: '588000C2609M01700', strike: 1.7, last: 0.0566 },
            { code: '588000C2609M01750', strike: 1.75, last: 0.0348 },
          ],
          puts: [],
        }),
      }),
    } as BridgeHost)
    try {
      const account = await bridge.optionPaperAccount()
      expect(account.equity).toBe(100000)
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })
})


describe('TradingBridge CN ETF options', () => {
  it('未挂 tradingCnOptions → TRADING_NOT_IMPLEMENTED', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/options/chain', new URLSearchParams({
      underlying: '510050.SH',
      expiryMonth: '2609',
    }))).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('缺 underlying / expiryMonth → 400', async () => {
    const bridge = new TradingBridge({
      ...fakeHost({}),
      getCnOptions: () => ({
        listUnderlyings: async () => [],
        getOptionExpiries: async () => {
          throw new Error('should not run')
        },
        getOptionChain: async () => {
          throw new Error('should not run')
        },
        getImpliedVol: async () => {
          throw new Error('should not run')
        },
        getStrategy: async () => {
          throw new Error('should not run')
        },
      }),
    })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/options/chain', new URLSearchParams({ expiryMonth: '2609' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(bridge, 'GET', '/options/chain', new URLSearchParams({ underlying: '510050' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })

  it('GET /options/underlyings 透传名册', async () => {
    const bridge = new TradingBridge({
      ...fakeHost({}),
      getCnOptions: () => ({
        listUnderlyings: async () => [{
          underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF',
          multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board',
        }],
        getOptionExpiries: async () => {
          throw new Error('unused')
        },
        getOptionChain: async () => {
          throw new Error('unused')
        },
        getImpliedVol: async () => {
          throw new Error('unused')
        },
        getStrategy: async () => {
          throw new Error('unused')
        },
      }),
    })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/options/underlyings', new URLSearchParams())
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, underlyings: [{ underlying: '510050' }] })
  })

  it('GET /options/chain 透传服务结果', async () => {
    const bridge = new TradingBridge({
      ...fakeHost({}),
      getCnOptions: () => ({
        listUnderlyings: async () => [],
        getOptionExpiries: async (query) => ({
          underlying: '510050',
          source: query.source ?? 'synth',
          months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }],
        }),
        getOptionChain: async (query) => ({
          underlying: '510050',
          expiryMonth: query.expiryMonth ?? '',
          source: 'synth',
          calls: [{ code: '510050C2609M02850', strike: 2.85 }],
          puts: [],
        }),
        getImpliedVol: async () => {
          throw new Error('unused')
        },
        getStrategy: async () => {
          throw new Error('unused')
        },
      }),
    })
    const { status, payload } = await dispatchBridgeRequest(
      bridge,
      'GET',
      '/options/chain',
      new URLSearchParams({ underlying: '510050.SH', expiryMonth: '2609', source: 'synth' }),
    )
    expect(status).toBe(200)
    expect(payload).toMatchObject({
      ok: true,
      chain: { underlying: '510050', calls: [{ code: '510050C2609M02850' }] },
    })
  })

  it('GET /options/arbitrage：现价拼接 spot + 桥层默认模拟盘费率', async () => {
    let seenQuery: Record<string, unknown> = {}
    const bridge = new TradingBridge({
      ...fakeHost({
        tradingCnMarketData: fakeService({
          getTicker: async (symbol) => ({ symbol, price: 2.9, timestamp: 1 }),
        }),
      }),
      getCnOptions: () => ({
        listUnderlyings: async () => [{
          underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF',
          multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board',
        }],
        getOptionExpiries: async () => {
          throw new Error('unused')
        },
        getOptionChain: async () => {
          throw new Error('unused')
        },
        getImpliedVol: async () => {
          throw new Error('unused')
        },
        getStrategy: async () => {
          throw new Error('unused')
        },
        getArbitrageScan: async (query: Record<string, unknown>) => {
          seenQuery = query
          return {
            underlying: '510050',
            expiryMonth: '2609',
            source: 'iquant',
            multiplier: 10000,
            asOf: '2026-09-11T15:00:00+08:00',
            assumptions: {
              rate: 0.02,
              thresholdPerShare: 0.005,
              feePerContract: query.feePerContract ?? 0,
              priceBasis: 'mid_last',
            },
            opportunities: [],
            disclaimer: '量化信号非投资建议',
          }
        },
      }),
    })
    const { status, payload } = await dispatchBridgeRequest(
      bridge,
      'GET',
      '/options/arbitrage',
      new URLSearchParams({ underlying: '510050.SH', expiryMonth: '2609' }),
    )
    expect(status).toBe(200)
    // 现价来自 CN 行情 ticker（510050.SH → 2.9）；费率缺省注入模拟盘 1.7 元/张
    expect(seenQuery.spot).toBeCloseTo(2.9, 6)
    expect(seenQuery.feePerContract).toBeCloseTo(1.7, 6)
    expect(payload).toMatchObject({ ok: true, scan: { underlying: '510050' } })
  })

  it('GET /options/arbitrage：fee=0 显式关费 / threshold 非数字 400 / 缺参 400', async () => {
    const mkBridge = () => new TradingBridge({
      ...fakeHost({}),
      getCnOptions: () => ({
        listUnderlyings: async () => [],
        getOptionExpiries: async () => {
          throw new Error('unused')
        },
        getOptionChain: async () => {
          throw new Error('unused')
        },
        getImpliedVol: async () => {
          throw new Error('unused')
        },
        getStrategy: async () => {
          throw new Error('unused')
        },
        getArbitrageScan: async (query: Record<string, unknown>) => ({
          underlying: '510050',
          expiryMonth: query.expiryMonth as string,
          source: 'iquant',
          multiplier: 10000,
          asOf: '2026-09-11T15:00:00+08:00',
          assumptions: { rate: 0.02, thresholdPerShare: 0.005, feePerContract: query.feePerContract ?? 0, priceBasis: 'mid_last' },
          opportunities: [],
          disclaimer: 'x',
        }),
      }),
    })
    const { status, payload } = await dispatchBridgeRequest(
      mkBridge(),
      'GET',
      '/options/arbitrage',
      new URLSearchParams({ underlying: '510050', expiryMonth: '2609', fee: '0' }),
    )
    expect(status).toBe(200)
    const scan = (payload as { scan: { assumptions: { feePerContract: number } } }).scan
    expect(scan.assumptions.feePerContract).toBe(0)
    await expect(dispatchBridgeRequest(
      mkBridge(),
      'GET',
      '/options/arbitrage',
      new URLSearchParams({ underlying: '510050', expiryMonth: '2609', threshold: 'abc' }),
    )).rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(
      mkBridge(),
      'GET',
      '/options/arbitrage',
      new URLSearchParams({ underlying: '510050' }),
    )).rejects.toBeInstanceOf(BridgeProtocolError)
  })

  it('GET /options/expiries 透传四季月', async () => {
    const bridge = new TradingBridge({
      ...fakeHost({}),
      getCnOptions: () => ({
        listUnderlyings: async () => [],
        getOptionExpiries: async (query) => ({
          underlying: '510050',
          source: query.source ?? 'akshare',
          months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }],
        }),
        getOptionChain: async () => {
          throw new Error('unused')
        },
        getImpliedVol: async () => {
          throw new Error('unused')
        },
        getStrategy: async () => {
          throw new Error('unused')
        },
      }),
    })
    const { status, payload } = await dispatchBridgeRequest(
      bridge,
      'GET',
      '/options/expiries',
      new URLSearchParams({ underlying: '510050.SH' }),
    )
    expect(status).toBe(200)
    expect(payload).toMatchObject({
      ok: true,
      expiries: { underlying: '510050', months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }] },
    })
  })
})

describe('TradingBridge CN ETF options 交易端点（阶段 3）', () => {
  function optionsTradeHost(trade: import('@dshtrading/api').CnOptionsTradeService | undefined): BridgeHost {
    return {
      ...fakeHost({}),
      getCnOptionsTrade: () => trade,
    }
  }

  it('未挂 tradingCnOptionsTrade → TRADING_NOT_IMPLEMENTED', async () => {
    const bridge = new TradingBridge(optionsTradeHost(undefined))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/options/positions', new URLSearchParams()))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('POST /options/order 透传（默认请求实盘，闸门语义在服务缝）；校验失败 400', async () => {
    const placeOptionOrder = vi.fn(async (req: import('@dshtrading/api').OptionOrderRequest) => ({
      id: 'dry-opt-1', symbol: req.symbol, side: req.side, offset: req.offset, orderType: req.orderType,
      status: 'filled' as const, quantity: req.quantity,
      ...(req.price !== undefined ? { price: req.price, premiumAmount: req.price * req.quantity * 10000 } : {}),
      multiplier: 10000, dryRun: req.dryRun ?? true, timestamp: 1,
    }))
    const bridge = new TradingBridge(optionsTradeHost({
      placeOptionOrder: placeOptionOrder as never,
      cancelOptionOrder: async () => {},
      listOptionPositions: async () => [],
    }))
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'POST', '/options/order', new URLSearchParams(),
      { symbol: '510050C2609M02850', side: 'buy', offset: 'open', orderType: 'limit', quantity: 1, price: 0.0856 },
    )
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, order: { symbol: '510050C2609M02850', dryRun: false, premiumAmount: 856 } })
    expect(placeOptionOrder).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, offset: 'open' }))

    // 校验失败：limit 缺价格 / quantity 非正整数 / offset 非法 → 400
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/options/order', new URLSearchParams(),
      { symbol: '510050C2609M02850', side: 'buy', offset: 'open', orderType: 'limit', quantity: 1 },
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/options/order', new URLSearchParams(),
      { symbol: '510050C2609M02850', side: 'buy', offset: 'open', orderType: 'limit', quantity: 0, price: 0.0856 },
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/options/order', new URLSearchParams(),
      { symbol: '510050C2609M02850', side: 'buy', offset: 'flip', orderType: 'limit', quantity: 1, price: 0.0856 },
    )).rejects.toMatchObject({ status: 400 })
  })

  it('DELETE /options/order 撤单；缺 id → 400', async () => {
    const cancelOptionOrder = vi.fn(async (id: string, sym?: string) => {
      if (id === 'missing') throw new Error('nope')
      if (sym !== undefined) throw new Error('unexpected symbol')
    })
    const bridge = new TradingBridge(optionsTradeHost({
      placeOptionOrder: async () => {
        throw new Error('unused')
      },
      cancelOptionOrder,
      listOptionPositions: async () => [],
    }))
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'DELETE', '/options/order', new URLSearchParams({ id: 'opt-123' }),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, canceled: true })
    expect(cancelOptionOrder).toHaveBeenCalledWith('opt-123', undefined)
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/options/order', new URLSearchParams()))
      .rejects.toMatchObject({ status: 400 })
  })

  it('GET /options positions 只读透传', async () => {
    const bridge = new TradingBridge(optionsTradeHost({
      placeOptionOrder: async () => {
        throw new Error('unused')
      },
      cancelOptionOrder: async () => {},
      listOptionPositions: async () => [{
        symbol: '510050C2609M02850', underlying: '510050', optionType: 'C' as const,
        strike: 2.85, expiryMonth: '2609', quantity: 2,
      }],
    }))
    const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/options/positions', new URLSearchParams())
    expect(payload).toMatchObject({
      ok: true,
      positions: [{ symbol: '510050C2609M02850', optionType: 'C', quantity: 2 }],
    })
  })
})

describe('TradingBridge CN ETF options 互联（阶段 4：spot 回填 / resolve / 持仓关联）', () => {
  const ROSTER = [
    { underlying: '510050', exchange: 'SSE' as const, name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' as const },
    { underlying: '159915', exchange: 'SZSE' as const, name: '创业板ETF易方达', multiplier: 10000, tickSize: 0.0001, quotesSource: 'iquant_board' as const },
  ]

  function linkedHost(opts: {
    chain?: { underlying: string; spot?: number }
    tickerPrice?: number
    holdings?: Array<{ symbol: string; size: number }>
  } = {}): BridgeHost {
    const chain = opts.chain ?? { underlying: '510050' }
    const cnOptions: import('@dshtrading/api').CnOptionsService = {
      listUnderlyings: async () => ROSTER,
      getOptionExpiries: async () => ({
        underlying: chain.underlying,
        source: 'iquant',
        months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }],
      }),
      getOptionChain: async () => ({
        underlying: chain.underlying, expiryMonth: '2609', source: 'synth',
        ...(chain.spot !== undefined ? { spot: chain.spot } : {}),
        calls: [{ code: '510050C2609M02850', strike: 2.85 }], puts: [],
      }),
      getImpliedVol: async () => ({
        underlying: chain.underlying,
        expiryMonth: '2609',
        source: 'iquant',
        rate: 0.02,
        priceField: 'last',
        rows: [
          { code: '510050C2609M02900', strike: 2.9, impliedVol: 0.21, converged: true },
          { code: '510050P2609M02900', strike: 2.9, impliedVol: 0.19, converged: true },
        ],
      }),
      getStrategy: async () => {
        throw new Error('unused')
      },
      getVolAnalytics: async () => {
        throw new Error('unused')
      },
      getUnderlyingDaily: async () => {
        throw new Error('unused')
      },
      getPrice: async () => {
        throw new Error('unused')
      },
      getParityCheck: async () => {
        throw new Error('unused')
      },
    }
    return {
      ...fakeHost({ tradingCnMarketData: fakeService({
        getTicker: async (symbol: string) => ({ symbol, price: opts.tickerPrice ?? 2.912, timestamp: 1 }),
      }) }),
      getCnOptions: () => cnOptions,
      ...(opts.holdings === undefined ? {} : {
        holdingsStore: createMemoryHoldingsStore({
          holdings: opts.holdings.map((h, i) => ({
            id: `h-${i}`, market: 'cn' as const, symbol: h.symbol, side: 'long' as const,
            size: h.size, account: '默认账户', kind: 'real' as const,
          })),
        }),
      }),
    }
  }

  it('GET /options/resolve：长代码 → underlying + contract 要素 + link（strike 5 位编码 ÷1000）', async () => {
    const bridge = new TradingBridge(linkedHost())
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/resolve', new URLSearchParams({ symbol: '510050c2609m02850' }),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({
      ok: true,
      input: '510050C2609M02850',
      underlying: '510050',
      link: { underlying: '510050', spotSymbol: '510050.SH', exchange: 'SSE', callPrefix: '510050C', putPrefix: '510050P' },
      contract: { code: '510050C2609M02850', optionType: 'C', strike: 2.85, expiryMonth: '2609' },
    })
  })

  it('GET /options/resolve：现货符号 → link，无 contract 键；名册外 6 位码 → link 缺席；非 CN 格式 → 400', async () => {
    const bridge = new TradingBridge(linkedHost())
    const { payload: spot } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/resolve', new URLSearchParams({ symbol: '510050.sh' }),
    )
    expect(spot).toEqual({
      ok: true,
      input: '510050.SH',
      underlying: '510050',
      link: { underlying: '510050', spotSymbol: '510050.SH', exchange: 'SSE', callPrefix: '510050C', putPrefix: '510050P' },
    })

    const { payload: unknown6 } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/resolve', new URLSearchParams({ symbol: '600519.SH' }),
    )
    expect(unknown6).toMatchObject({ ok: true, underlying: '600519' })
    expect('link' in (unknown6 as Record<string, unknown>)).toBe(false)

    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/options/resolve', new URLSearchParams({ symbol: 'AAPL' }),
    )).rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/options/resolve', new URLSearchParams(),
    )).rejects.toBeInstanceOf(BridgeProtocolError)
  })

  it('GET /options/chain：CN 行情可用 → spot 回填为现货最新价（ATM 高亮）', async () => {
    const bridge = new TradingBridge(linkedHost({ tickerPrice: 2.95 }))
    const { payload } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/chain', new URLSearchParams({ underlying: '510050.SH', expiryMonth: '2609' }),
    )
    expect(payload).toMatchObject({ ok: true, chain: { underlying: '510050', spot: 2.95 } })
  })

  it('GET /options/chain：行情服务缺席 / SYNTH 标的 → 保留链自带 spot，不阻塞 T 板', async () => {
    // 行情未挂（getMarketService 全空）→ python 链自带 spot 2.9 原样保留
    const host = linkedHost({ chain: { underlying: '510050', spot: 2.9 } })
    const noMarket: BridgeHost = { ...host, getMarketService: () => undefined }
    const { payload } = await dispatchBridgeRequest(
      new TradingBridge(noMarket), 'GET', '/options/chain', new URLSearchParams({ underlying: '510050', expiryMonth: '2609' }),
    )
    expect(payload).toMatchObject({ chain: { spot: 2.9 } })

    // ticker 抛错 → 同样保留
    const broken: BridgeHost = {
      ...host,
      getMarketService: () => fakeService({
        getTicker: async () => {
          throw new Error('market closed')
        },
      }),
    }
    const { payload: kept } = await dispatchBridgeRequest(
      new TradingBridge(broken), 'GET', '/options/chain', new URLSearchParams({ underlying: '510050', expiryMonth: '2609' }),
    )
    expect(kept).toMatchObject({ chain: { spot: 2.9 } })
  })

  it('GET /options/underlyings：heldQty 从台账聚合同标的份额（多账户/裸码求和）；无持仓 → 键缺席', async () => {
    const bridge = new TradingBridge(linkedHost({
      holdings: [
        { symbol: '510050.SH', size: 20000 },
        { symbol: '510050', size: 5000 },
        { symbol: '600519.SH', size: 100 }, // 非期权标的：不影响名册
      ],
    }))
    const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/options/underlyings', new URLSearchParams())
    expect(payload).toMatchObject({
      ok: true,
      underlyings: [
        { underlying: '510050', heldQty: 25000 },
        { underlying: '159915' },
      ],
    })
    const rows = (payload as { underlyings: Array<Record<string, unknown>> }).underlyings
    expect('heldQty' in rows[1]!).toBe(false)
  })

  it('POST /options/strategy：holdingQty 正数透传（备兑现货腿预填）；非正数 → 400', async () => {
    const getStrategy = vi.fn(async (req: import('@dshtrading/api').OptionStrategyRequest) => ({
      underlying: req.underlying, source: 'synth', multiplier: 10000, spot: 2.9,
      legs: [], entry: { debitCredit: 0, note: '' }, payoff: [], greeks: { status: 'insufficient', net: {}, legs: [] },
      margin: { perLeg: [], totalInitial: 0, totalMaintenance: 0, note: '' },
    }))
    const bridge = new TradingBridge({
      ...linkedHost(),
      getCnOptions: () => ({
        ...linkedHost().getCnOptions!(),
        getStrategy: getStrategy as never,
      }),
    })
    await dispatchBridgeRequest(
      bridge, 'POST', '/options/strategy', new URLSearchParams(),
      { underlying: '510050.SH', template: 'covered_call', holdingQty: 25000 },
    )
    expect(getStrategy).toHaveBeenCalledWith(expect.objectContaining({ holdingQty: 25000 }))

    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/options/strategy', new URLSearchParams(),
      { underlying: '510050.SH', template: 'covered_call', holdingQty: -1 },
    )).rejects.toMatchObject({ status: 400 })
  })

  it('GET /options/vol-analytics：参数规范化透传（months 拆分 / 数值转换 / source 枚举），报告原样返回', async () => {
    const report = { underlying: '510050', iv_percentile: { w252: 0.62 }, term_structure: [] }
    const getVolAnalytics = vi.fn(async (query: import('@dshtrading/api').OptionVolAnalyticsQuery) => {
      // query 是 readonly 对象，回显前键集由调用方断言
      return { ...report, _echoMonths: query.expiryMonths }
    })
    const bridge = new TradingBridge({
      ...linkedHost(),
      getCnOptions: () => ({
        ...linkedHost().getCnOptions!(),
        getVolAnalytics: getVolAnalytics as never,
      }),
    })
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/vol-analytics', new URLSearchParams({
        underlying: '510050.SH',
        expiryMonths: '2609, 2612 ,',
        asOf: '2026-09-08',
        rate: '0.02',
        dividendYield: '0.01',
        source: 'synth',
      }),
    )
    expect(status).toBe(200)
    expect(getVolAnalytics).toHaveBeenCalledWith({
      underlying: '510050.SH',
      expiryMonths: ['2609', '2612'],
      asOf: '2026-09-08',
      rate: 0.02,
      dividendYield: 0.01,
      source: 'synth',
    })
    expect(payload).toMatchObject({ ok: true, volAnalytics: { iv_percentile: { w252: 0.62 } } })

    // 最小调用：可选键缺席 → 整键省略（exactOptionalPropertyTypes 纪律）
    await dispatchBridgeRequest(bridge, 'GET', '/options/vol-analytics', new URLSearchParams({ underlying: '510050' }))
    expect(getVolAnalytics).toHaveBeenLastCalledWith({ underlying: '510050' })

    // 非法 source 静默丢弃（透传缝 python 默认）；显式 rate 非数值 → 400 不静默换默认
    await dispatchBridgeRequest(bridge, 'GET', '/options/vol-analytics', new URLSearchParams({ underlying: '510050', source: 'bogus' }))
    expect(getVolAnalytics).toHaveBeenLastCalledWith({ underlying: '510050' })
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/options/vol-analytics', new URLSearchParams({ underlying: '510050', rate: 'abc' }),
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/options/vol-analytics', new URLSearchParams(),
    )).rejects.toMatchObject({ status: 400 })
  })

  it('GET /options/overview：只读 overview.json + 底仓/持仓，不打行情/IV 网关；SYNTH 不进表', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-ov-file-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const getTicker = vi.fn(async (symbol: string) => ({ symbol, price: 9, timestamp: 1 }))
    const getImpliedVol = vi.fn(async () => {
      throw new Error('overview must not hit implied_vol')
    })
    const getVolAnalytics = vi.fn(async () => ({ iv_percentile: { w252: 0.8 } }))
    await writeFile(path.join(dir, 'overview.json'), `${JSON.stringify({
      asOf: '2026-09-12T03:00:00.000Z',
      rows: [{
        underlying: '510050',
        name: '华夏上证50ETF',
        exchange: 'SSE',
        last: 2.91,
        atmIv: 0.2,
        ivPercentile: 0.8,
        days: [
          { date: '2026-09-08', changePct: 0.1, volumeSurge: false },
          { date: '2026-09-09', changePct: 0.2, volumeSurge: false },
          { date: '2026-09-10', changePct: 0.3, volumeSurge: false },
          { date: '2026-09-11', changePct: 0.4, volumeSurge: false },
          { date: '2026-09-12', changePct: 0.5, volumeSurge: true },
        ],
      }],
    })}\n`, 'utf8')
    const base = linkedHost({ holdings: [{ symbol: '510050.SH', size: 20000 }] })
    const bridge = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({ getTicker }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => [
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
          { underlying: '159915', exchange: 'SZSE', name: '创业板ETF易方达', multiplier: 10000, tickSize: 0.0001, quotesSource: 'szse_static_only' },
          { underlying: '910050', exchange: 'SYNTH', name: 'synth50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'synth' },
        ],
        getImpliedVol,
        getVolAnalytics,
      }),
      getCnOptionsTrade: () => ({
        placeOptionOrder: async () => { throw new Error('unused') },
        cancelOptionOrder: async () => { throw new Error('unused') },
        listOptionPositions: async () => ([
          { symbol: '510050C2609M02850', underlying: '510050', optionType: 'C' as const, strike: 2.85, expiryMonth: '2609', quantity: 2 },
        ]),
      }),
    })
    try {
      const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/options/overview', new URLSearchParams())
      const overview = (payload as { overview: { rows: Array<Record<string, unknown>>; sort: string; scanAllPrompt: string; asOf: string } }).overview
      expect(overview.sort).toBe('strength')
      expect(overview.asOf).toBe('2026-09-12T03:00:00.000Z')
      expect(overview.rows.map((row) => row.underlying)).toEqual(['510050', '159915'])
      expect(overview.rows[0]).toMatchObject({
        last: 2.91,
        heldQty: 20000,
        optionQty: 2,
        spotSymbol: '510050.SH',
        atmIv: 0.2,
        ivPercentile: 0.8,
        ivRegime: 'rich',
      })
      expect(overview.rows[0]?.days).toHaveLength(5)
      expect(overview.rows[1]).toMatchObject({ underlying: '159915', days: [] })
      expect(overview.rows[0]?.scanPrompt).toContain('not investment advice')
      expect(overview.scanAllPrompt).toContain('510050')
      expect(getTicker).not.toHaveBeenCalled()
      expect(getImpliedVol).not.toHaveBeenCalled()
      expect(getVolAnalytics).not.toHaveBeenCalled()

      const withIv = await dispatchBridgeRequest(
        bridge, 'GET', '/options/overview', new URLSearchParams({ includeIv: '1', sort: 'iv' }),
      )
      const ivOverview = (withIv.payload as { overview: { sort: string; rows: Array<{ ivPercentile?: number; ivRegime?: string }> } }).overview
      expect(ivOverview.sort).toBe('iv')
      expect(ivOverview.rows[0]?.ivPercentile).toBe(0.8)
      expect(getVolAnalytics).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('snapshotBarFacts：活牌采集后覆写 overview.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-ov-facts-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const klines = Array.from({ length: 20 }, (_, i) => ({
      openTime: 1 + i,
      open: 2 + i * 0.01,
      high: 2.1 + i * 0.01,
      low: 1.9,
      close: 2 + i * 0.02,
      volume: i < 15 ? 100 : 40,
      closeTime: Date.UTC(2026, 8, i + 1, 7),
    }))
    const base = linkedHost({})
    const bridge = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({
        getTicker: async (symbol) => ({ symbol, price: 2.91, changePercent: 0.4, timestamp: 1 }),
        getKlines: async () => klines,
      }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => [
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
        ],
      }),
    })
    try {
      const facts = await bridge.snapshotBarFacts(['510050'])
      expect(facts[0]?.underlying).toBe('510050')
      const raw = JSON.parse(await readFile(path.join(dir, 'overview.json'), 'utf8')) as {
        rows: Array<{ underlying: string; last?: number }>
      }
      expect(raw.rows[0]).toMatchObject({ underlying: '510050', last: 2.91 })
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('GET /options/overview：挂当天最新推荐到 strategy；无账本不写该键', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-ov-bridge-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const date = shanghaiCalendarDate(Date.now())
    await mkdir(path.join(dir, 'recommendations'), { recursive: true })
    await writeFile(path.join(dir, 'recommendations', `${date}.jsonl`), `${JSON.stringify({
      bucketStart: '2026-09-09T05:50:00.000Z',
      asOf: 't',
      session: 'regular',
      opportunity: 'theta_rent',
      edge: 'range_hold 收时间价值',
      logic: 'x',
      playbook: 'x',
      invalidIf: '1-minute close outside box',
      picks: [{ underlying: '510050', regime: 'range_hold', template: 'butterfly', cycleId: '510050:1' }],
      noTrade: false,
    })}\n`, 'utf8')
    const base = linkedHost({})
    const bridge = new TradingBridge({
      ...base,
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => [
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
          { underlying: '159915', exchange: 'SZSE', name: '创业板ETF易方达', multiplier: 10000, tickSize: 0.0001, quotesSource: 'szse_static_only' },
        ],
      }),
    })
    try {
      const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/options/overview', new URLSearchParams())
      const rows = (payload as { overview: { rows: Array<{ underlying: string; strategy?: Record<string, unknown> }> } }).overview.rows
      expect(rows.find((row) => row.underlying === '510050')?.strategy).toMatchObject({
        opportunity: 'theta_rent',
        template: 'butterfly',
        noTrade: false,
      })
      expect(rows.find((row) => row.underlying === '159915')?.strategy).toMatchObject({
        opportunity: 'no_edge',
        noTrade: true,
      })
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('GET /options/overview：未挂期权服务 → NOT_IMPLEMENTED；行情失败不整页失败', async () => {
    const empty = new TradingBridge(fakeHost({}))
    await expect(dispatchBridgeRequest(empty, 'GET', '/options/overview', new URLSearchParams()))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })

    const broken = new TradingBridge({
      ...fakeHost({
        tradingCnMarketData: fakeService({
          getTicker: async () => { throw new Error('quote down') },
          getKlines: async () => { throw new Error('kline down') },
        }),
      }),
      getCnOptions: () => ({
        listUnderlyings: async () => ([
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
        ]),
        getOptionExpiries: async () => { throw new Error('unused') },
        getOptionChain: async () => { throw new Error('unused') },
        getImpliedVol: async () => { throw new Error('unused') },
        getStrategy: async () => { throw new Error('unused') },
        getVolAnalytics: async () => { throw new Error('unused') },
        getUnderlyingDaily: async () => { throw new Error('unused') },
        getPrice: async () => { throw new Error('unused') },
        getParityCheck: async () => { throw new Error('unused') },
      }),
    })
    const { payload } = await dispatchBridgeRequest(broken, 'GET', '/options/overview', new URLSearchParams())
    expect(payload).toMatchObject({
      ok: true,
      overview: { rows: [{ underlying: '510050', days: [] }] },
    })
  })

  it('GET /options/intraday-box：1m 箱体；horizon 非法 400；未知名 UNSUPPORTED；行情失败不整页失败', async () => {
    const asOf = '2026-09-08T02:30:00.000Z'
    const klines = Array.from({ length: 60 }, (_, i) => ({
      openTime: Date.parse(asOf) - (60 - i) * 60_000,
      open: 3,
      high: 3.002,
      low: 2.998,
      close: 3,
      volume: 100,
      closeTime: Date.parse(asOf) - (59 - i) * 60_000,
    }))
    const base = linkedHost()
    const bridge = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({
        getTicker: async (symbol) => ({ symbol, price: 3, timestamp: 1 }),
        getKlines: async (_symbol, interval) => {
          expect(interval).toBe('1m')
          return klines
        },
      }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => [
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
          { underlying: '910050', exchange: 'SYNTH', name: 'synth50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'synth' },
        ],
      }),
    })
    const { payload } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/intraday-box', new URLSearchParams({ underlying: '510050.SH', asOf }),
    )
    const box = (payload as { box: { horizonMin: number; rows: Array<Record<string, unknown>> } }).box
    expect(box.horizonMin).toBe(5)
    expect(box.rows).toHaveLength(1)
    expect(box.rows[0]).toMatchObject({ underlying: '510050', spotSymbol: '510050.SH', regime: 'range_hold' })
    expect(box.rows[0]?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ template: 'butterfly' }),
    ]))

    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/options/intraday-box', new URLSearchParams({ horizon: '15' }),
    )).rejects.toMatchObject({ status: 400 })

    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/options/intraday-box', new URLSearchParams({ underlying: '600519.SH' }),
    )).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })

    const broken = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({
        getKlines: async () => { throw new Error('1m down') },
        getTicker: async () => { throw new Error('quote down') },
      }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => ([
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
        ]),
      }),
    })
    const failed = await dispatchBridgeRequest(
      broken, 'GET', '/options/intraday-box', new URLSearchParams({ asOf }),
    )
    expect(failed.payload).toMatchObject({
      ok: true,
      box: { rows: [{ underlying: '510050', regime: 'no_trade', noTradeReason: 'insufficient' }] },
    })
  })

  it('POST /options/cycles/tick：同桶幂等；下一桶给上一箱补分', async () => {
    const t0 = '2026-09-08T02:30:00.000Z'
    const t1 = '2026-09-08T02:35:00.000Z'
    const t1Ms = Date.parse(t1)
    // 箱体要 ≥31 根 1m；打分窗口是 (t0, t1]。末 5 根收在 3 附近 → range_hold hit。
    const klines = Array.from({ length: 60 }, (_, i) => {
      const closeTime = t1Ms - (59 - i) * 60_000
      return {
        openTime: closeTime - 60_000, open: 3, high: 3.002, low: 2.998,
        close: 3, volume: 80, closeTime,
      }
    })
    const base = linkedHost()
    const bridge = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({
        getTicker: async (symbol) => ({ symbol, price: 3, timestamp: 1 }),
        getKlines: async () => klines,
      }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => [
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
        ],
      }),
    })
    const first = await dispatchBridgeRequest(
      bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf: t0 },
    )
    expect((first.payload as { ticked: boolean }).ticked).toBe(true)
    const firstForecast = (first.payload as {
      loop: { rows: Array<{ latest?: { forecast: { regime: string } } }> }
    }).loop.rows[0]?.latest?.forecast
    expect(firstForecast?.regime).toBe('range_hold')
    const again = await dispatchBridgeRequest(
      bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf: t0 },
    )
    expect((again.payload as { ticked: boolean }).ticked).toBe(false)

    await dispatchBridgeRequest(
      bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf: t1 },
    )
    const { payload } = await dispatchBridgeRequest(
      bridge, 'GET', '/options/cycles', new URLSearchParams({ underlying: '510050', limit: '8' }),
    )
    const cycles = (payload as { cycles: Array<{ score?: { verdict: string }; bucketStart: string }> }).cycles
    expect(cycles.length).toBeGreaterThanOrEqual(2)
    const scored = cycles.find((row) => row.score !== undefined)
    expect(scored?.score?.verdict).toBe('hit')

    const loop = await dispatchBridgeRequest(bridge, 'GET', '/options/cycles/loop', new URLSearchParams())
    expect((loop.payload as { loop: { rows: Array<{ underlying: string }> } }).loop.rows[0]?.underlying).toBe('510050')
  })

  it('POST /options/cycles/tick：invalidIf 用 1m K 线 close，不用 ticker last', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-paper-invalidif-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const asOf = '2026-09-08T02:30:00.000Z'
    const asOfMs = Date.parse(asOf)
    await mkdir(path.join(dir, 'paper'), { recursive: true })
    await writeFile(path.join(dir, 'paper', 'account.json'), `${JSON.stringify({
      currency: 'CNY', initialCash: 100000, cash: 99000, realizedPnl: 0, updatedAt: asOf,
    })}\n`, 'utf8')
    const plantedPosition = {
      id: '510050:bucket',
      underlying: '510050',
      template: 'vertical',
      openedBucketStart: asOf,
      invalidIf: '1-minute close outside box',
      boxLow: 2.95,
      boxHigh: 3.05,
      qty: 1,
      marginCny: 1000,
      legs: [{ code: '510050C2609M02850', side: 'sell', qty: 1, fillPrice: 0.08 }],
    }
    await writeFile(path.join(dir, 'paper', 'positions.json'), `${JSON.stringify([plantedPosition])}\n`, 'utf8')
    const klinesForBox = Array.from({ length: 60 }, (_, i) => {
      const closeTime = asOfMs - (59 - i) * 60_000
      return {
        openTime: closeTime - 60_000, open: 3, high: 3.002, low: 2.998,
        close: 3, volume: 100, closeTime,
      }
    })
    const getKlines = vi.fn(async (_symbol: string, interval: string, limit?: number) => {
      expect(interval).toBe('1m')
      const count = limit ?? 60
      const bars = klinesForBox.slice(-count)
      if (count <= 5) {
        return bars.map((bar, i) => (
          i === bars.length - 1 ? { ...bar, close: 3 } : bar
        ))
      }
      return bars
    })
    const base = linkedHost()
    const bridge = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({
        getTicker: async (symbol) => ({ symbol, price: 3.2, timestamp: 1 }),
        getKlines,
      }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        getOptionChain: async () => ({
          underlying: '510050', expiryMonth: '2609', source: 'synth',
          calls: [{ code: '510050C2609M02850', strike: 2.85, last: 0.08 }],
          puts: [],
        }),
      }),
    })
    try {
      await dispatchBridgeRequest(
        bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf },
      )
      // tryPaperManage 异步推进（tick 内 fire-and-forget）：轮询直到 getLastClose
      // （1m×5）真的被调用再核对持仓——「未变化」断言立即成立，直接断言 spy 会竞态。
      await vi.waitFor(async () => {
        expect(getKlines).toHaveBeenCalledWith('510050.SH', '1m', 5)
        // 旧布局 fixture 经惰性迁移落到 paper/strategy/，管理断言读新位置。
        const positions = JSON.parse(await readFile(path.join(dir, 'paper', 'strategy', 'positions.json'), 'utf8'))
        expect(positions).toEqual([plantedPosition])
      })
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('POST /options/cycles/tick：close5 管理纸账户但不走下单服务', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-paper-tick-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const asOf = '2026-09-08T06:56:00.000Z'
    const date = shanghaiCalendarDate(Date.parse(asOf))
    await mkdir(path.join(dir, 'paper'), { recursive: true })
    await writeFile(path.join(dir, 'paper', 'account.json'), `${JSON.stringify({
      currency: 'CNY', initialCash: 100000, cash: 99000, realizedPnl: 0, updatedAt: asOf,
    })}\n`, 'utf8')
    await writeFile(path.join(dir, 'paper', 'positions.json'), `${JSON.stringify([{
      id: '510050:bucket',
      underlying: '510050',
      template: 'vertical',
      openedBucketStart: '2026-09-08T06:50:00.000Z',
      invalidIf: '1-minute close outside box',
      qty: 1,
      marginCny: 1000,
      legs: [{ code: '510050C2609M02850', side: 'sell', qty: 1, fillPrice: 0.08 }],
    }])}\n`, 'utf8')
    const placeOptionOrder = vi.fn(async () => {
      throw new Error('paper manage must never place orders')
    })
    const base = linkedHost()
    const bridge = new TradingBridge({
      ...base,
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        getOptionChain: async () => ({
          underlying: '510050', expiryMonth: '2609', source: 'synth',
          calls: [{ code: '510050C2609M02850', strike: 2.85, last: 0.07 }],
          puts: [],
        }),
      }),
      getCnOptionsTrade: () => ({
        placeOptionOrder,
        cancelOptionOrder: async () => {},
        listOptionPositions: async () => [],
      }),
    })
    try {
      await dispatchBridgeRequest(
        bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf },
      )
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(path.join(dir, 'paper', 'strategy', 'positions.json'), 'utf8'))).toEqual([])
      })
      expect(placeOptionOrder).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })

  it('POST /options/cycles/tick：套利账本 regular 对手价开仓 → close5 边收敛平仓（60s 链缓存越过）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-arb-tick-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    // 2026-09-08 周二：03:00Z = BJT 11:00 regular；06:56Z = BJT 14:56 close5（只平不开，
    // 收敛后的 0.00996 边仍过 0.005 扫描阈值，regular 会立即再开仓）。
    const asOfOpen = '2026-09-08T03:00:00.000Z'
    const asOfClose = '2026-09-08T06:56:00.000Z'
    // C3 引擎测试同款链：C285 bid .048/ask .05、P285 bid .0184/ask .0204、spot 2.9
    // → buy_synthetic_sell_spot 可执行边 ≈ 0.02072（2026-09-08 距到期 15 天，贴现略厚于
    // C3 的 09-13 口径）；收敛链 C ask 提到 0.062 → 边 ≈ 0.00872 < openEdge/2 ≈ 0.01036。
    const openedChain = {
      underlying: '510050', expiryMonth: '2609', expiryDate: '2026-09-23', source: 'iquant',
      snapshotAt: '2026-09-08T02:59:50.000Z', spot: 2.9,
      calls: [{ code: '510050C2609M02850', strike: 2.85, last: 0.049, bid: 0.048, ask: 0.05 }],
      puts: [{ code: '510050P2609M02850', strike: 2.85, last: 0.0194, bid: 0.0184, ask: 0.0204 }],
    }
    const convergedChain = {
      ...openedChain,
      snapshotAt: '2026-09-08T06:55:50.000Z',
      calls: [{ code: '510050C2609M02850', strike: 2.85, last: 0.0615, bid: 0.061, ask: 0.062 }],
    }
    let chain = openedChain
    const base = linkedHost()
    const bridge = new TradingBridge({
      ...base,
      getMarketService: () => fakeService({
        getTicker: async (symbol: string) => ({ symbol, price: 2.9, timestamp: 1 }),
        getKlines: async () => [],
      }),
      getCnOptions: () => ({
        ...base.getCnOptions!(),
        listUnderlyings: async () => [
          { underlying: '510050', exchange: 'SSE', name: '华夏上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' },
        ],
        getOptionChain: async () => chain,
        // 期权腿组合保证金 500 元/张（引擎再加卖空现货 50% 融券近似 14500）。
        getStrategy: async () => ({
          underlying: '510050', source: 'stub', spot: 2.9, multiplier: 10000,
          legs: [], entry: { debitCredit: 0, note: 'stub' }, payoff: [],
          greeks: { status: 'ok' as const, net: { delta: 0, gamma: 0, theta: 0, vega: 0 }, legs: [] },
          margin: { perLeg: [], totalInitial: 500, totalMaintenance: 500, note: 'stub' },
        }),
      }),
    })
    // 链缓存 TTL 与 in-flight 闸都吃墙钟：只 fake Date，Promise/定时器保持真实。
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse(asOfOpen))
      await dispatchBridgeRequest(
        bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf: asOfOpen },
      )
      await vi.waitFor(async () => {
        const positions = JSON.parse(await readFile(path.join(dir, 'paper', 'arbitrage', 'positions.json'), 'utf8'))
        expect(positions).toHaveLength(1)
        expect(positions[0]).toMatchObject({
          id: 'arb:parity:510050:2609:2850',
          book: 'arbitrage',
          qty: 2,
          direction: 'buy_synthetic_sell_spot',
          strikes: [2.85],
          expiryDate: '2026-09-23',
        })
        // 现货腿按份记账：2 张 × 10000 份，带全符号。
        expect(positions[0].legs[2]).toMatchObject({
          code: '510050', side: 'sell', qty: 20_000, asset: 'spot', spotSymbol: '510050.SH',
        })
      })
      // cash = 100000 + 28684×2 − 15000×2 − 12.6（C3 引擎手算同款）。
      const openedAccount = JSON.parse(await readFile(path.join(dir, 'paper', 'arbitrage', 'account.json'), 'utf8'))
      expect(openedAccount.cash).toBeCloseTo(100_000 + 28_684 * 2 - 15_000 * 2 - 12.6, 8)
      const openedFills = await readFile(path.join(dir, 'paper', 'arbitrage', 'fills', '2026-09-08.jsonl'), 'utf8')
      expect(openedFills).toContain('"reason":"arb_open"')
      // 等 fire-and-forget 周期收尾释放 in-flight 闸。
      await new Promise((resolve) => setTimeout(resolve, 50))

      // 拨过 60s 链缓存 TTL；close5 只平不开。
      vi.setSystemTime(Date.parse(asOfClose))
      chain = convergedChain
      await dispatchBridgeRequest(
        bridge, 'POST', '/options/cycles/tick', new URLSearchParams(), { asOf: asOfClose },
      )
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(path.join(dir, 'paper', 'arbitrage', 'positions.json'), 'utf8'))).toEqual([])
      })
      const closedAccount = JSON.parse(await readFile(path.join(dir, 'paper', 'arbitrage', 'account.json'), 'utf8'))
      // realizedPnl = 57368 + (0.061−0.0204)×2×10000 − 2.9×20000 − 双边费 25.2 = 154.8。
      expect(closedAccount.realizedPnl).toBeCloseTo(154.8, 8)
      const closedFills = await readFile(path.join(dir, 'paper', 'arbitrage', 'fills', '2026-09-08.jsonl'), 'utf8')
      expect(closedFills).toContain('"reason":"arb_converge"')

      // 策略账本同 tick 驱动但完全隔离：仍是 10 万初始。
      const strategyAccount = JSON.parse(await readFile(path.join(dir, 'paper', 'strategy', 'account.json'), 'utf8'))
      expect(strategyAccount.cash).toBe(100_000)
    } finally {
      vi.useRealTimers()
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })
})

describe('TradingBridge 预测 T-1 自动回填', () => {
  it('GET /options/predictions/track 先按 T-1 回填；手工 outcome 不覆盖', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-pred-bridge-'))
    const prev = process.env[OPTIONS_DATA_ENV]
    process.env[OPTIONS_DATA_ENV] = dir
    const today = shanghaiCalendarDate(Date.now())
    const tMinus1 = resolvePredictionAutoAsOf(today)
    const tMinus2 = resolvePredictionAutoAsOf(tMinus1)
    await writeFile(path.join(dir, 'predictions.jsonl'), `${JSON.stringify({
      id: `510050-${tMinus1}`,
      underlying: '510050',
      asOfDate: tMinus2,
      targetDate: tMinus1,
      marketExpectation: 'small_up',
      volExpectation: 'up',
      confidence: 0.5,
      factors: [],
      thesis: '待回填',
      evaluationMethod: '默认',
      createdAt: `${tMinus2}T08:00:00.000Z`,
    })}\n${JSON.stringify({
      id: `510300-${tMinus1}`,
      underlying: '510300',
      asOfDate: tMinus2,
      targetDate: tMinus1,
      marketExpectation: 'consolidation',
      volExpectation: 'down',
      confidence: 0.5,
      factors: [],
      thesis: '手工',
      evaluationMethod: '默认',
      createdAt: `${tMinus2}T08:00:00.000Z`,
      outcome: {
        realizedMarket: 'consolidation',
        realizedVol: 'down',
        marketReturnPct: 0.1,
        volChange: -0.01,
        hitMarket: true,
        hitVol: true,
        score: 1,
        retrospect: '手工改动',
        knowledgeNotes: '',
        settledAt: `${tMinus1}T08:00:00.000Z`,
      },
    })}\n`, 'utf8')
    const prevClose = Date.parse(`${tMinus2}T15:00:00+08:00`)
    const dayClose = Date.parse(`${tMinus1}T15:00:00+08:00`)
    const bridge = new TradingBridge(fakeHost({
      tradingCnMarketData: fakeService({
        getKlines: async () => [
          { openTime: prevClose - 1, open: 3, high: 3, low: 3, close: 3, volume: 100, closeTime: prevClose },
          { openTime: dayClose - 1, open: 3, high: 3.03, low: 3, close: 3.024, volume: 110, closeTime: dayClose },
        ],
      }),
    }))
    try {
      const { payload } = await dispatchBridgeRequest(
        bridge, 'GET', '/options/predictions/track', new URLSearchParams(),
      )
      const track = (payload as { track: { predictions: Array<{ id: string; outcome?: { realizedMarket: string; retrospect?: string } }> } }).track
      expect(track.predictions.find((row) => row.id === `510050-${tMinus1}`)?.outcome?.realizedMarket).toBe('small_up')
      expect(track.predictions.find((row) => row.id === `510300-${tMinus1}`)?.outcome?.retrospect).toBe('手工改动')
    } finally {
      if (prev === undefined) delete process.env[OPTIONS_DATA_ENV]
      else process.env[OPTIONS_DATA_ENV] = prev
    }
  })
})
