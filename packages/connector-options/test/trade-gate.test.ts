/**
 * 期权交易缝闸门：dry-run 预览保留；live 随 MiniQMT 删除。
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

function makeService(config: Config) {
  const trade = new CnOptionsTradeService(new CordisContext() as never, { config })
  return { trade }
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

describe('CnOptionsTradeService 服务缝闸门', () => {
  it('dryRun=false + liveTrading=false → TRADING_LIVE_TRADING_DISABLED', async () => {
    const { trade } = makeService(baseConfig())
    await expect(trade.placeOptionOrder(LIVE_REQ)).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
  })

  it('dry-run 预览回执含 premiumAmount', async () => {
    const { trade } = makeService(baseConfig())
    const order = await trade.placeOptionOrder({
      symbol: '510050C2609M02850',
      side: 'buy',
      offset: 'open',
      orderType: 'limit',
      quantity: 2,
      price: 0.0856,
    })
    expect(order.dryRun).toBe(true)
    expect(order.premiumAmount).toBe(1712)
  })

  it('live 路径 → TRADING_NOT_IMPLEMENTED（MiniQMT 已删）', async () => {
    const { trade } = makeService(baseConfig({ dryRun: false, liveTrading: true }))
    await expect(trade.placeOptionOrder(LIVE_REQ)).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.cancelOptionOrder('opt-1')).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.listOptionPositions()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })
})

describe('CnOptionsTradeService 入参规范化', () => {
  it('symbol 必须是期权长代码', async () => {
    const { trade } = makeService(baseConfig())
    await expect(trade.placeOptionOrder({ ...LIVE_REQ, symbol: '510050.SH' })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})
