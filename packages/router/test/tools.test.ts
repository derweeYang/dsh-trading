/**
 * routing_get / instruments_search 工具单测（离线）：provider 报告（含 selected-but-
 * missing 状态）、静态字典检索、动态全集并集与失败兜底、market 过滤与截断。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { SYMBOL_CATALOG } from '../src/catalog.ts'
import { createInstrumentsSearchTool, createRoutingGetTool, type RouterToolServices } from '../src/tools.ts'

function fakeService(symbols: Array<{ symbol: string; name?: string }>): MarketDataService {
  return {
    getTicker: async (symbol) => ({ symbol, price: 1, timestamp: 1 }),
    getKlines: async () => [],
    subscribeTicker: () => ({ dispose() {} }),
    listInstruments: async () => symbols,
  }
}

function makeServices(overrides: Partial<RouterToolServices> = {}): RouterToolServices {
  return {
    activeProvider: (market) => ({ cn: 'tencent' }[market]),
    registry: {
      active: (market) => {
        if (market === 'cn') return { provider: 'tencent', service: fakeService([{ symbol: '000001.SZ', name: '平安银行' }]) }
        return undefined
      },
    },
    ...overrides,
  }
}

describe('routing_get', () => {
  it('报告各市场 provider 与激活状态（serving / selected-but-missing / none）', async () => {
    const wire = JSON.parse(String(await createRoutingGetTool(makeServices()).execute({}))) as {
      markets: Array<{ market: string; provider: string; active: boolean; note: string }>
    }
    const cn = wire.markets.find(m => m.market === 'cn')!
    expect(cn).toMatchObject({ provider: 'tencent', active: true, note: 'serving' })
    // 路由选了 tencent 但注册表无激活项（连接器未装/未启用）→ selected-but-missing。
    const missing = JSON.parse(String(await createRoutingGetTool(makeServices({ registry: { active: () => undefined } })).execute({}))) as typeof wire
    const cnMissing = missing.markets.find(m => m.market === 'cn')!
    expect(cnMissing).toMatchObject({ provider: 'tencent', active: false })
    expect(cnMissing.note).toContain('selected but not registered')
  })
})

describe('instruments_search', () => {
  it('静态字典命中（中文名子串）+ 动态全集并集去重', async () => {
    const wire = JSON.parse(String(await createInstrumentsSearchTool(makeServices()).execute({ query: '平安', market: 'cn' }))) as {
      total: number
      results: Array<{ symbol: string; source: string }>
    }
    expect(wire.results.some(r => r.symbol === '000001.SZ' && r.source === 'dynamic')).toBe(true)
    expect(wire.results.some(r => r.symbol === '000001.SZ' && r.source === 'catalog')).toBe(false) // 去重：动态优先
    expect(wire.results.some(r => r.symbol === '601318.SH' && r.source === 'catalog')).toBe(true) // 中国平安（字典兜底）
  })

  it('动态全集抛错 → 静态字典兜底不中断', async () => {
    const services = makeServices({
      registry: { active: () => ({ provider: 'tencent', service: { ...fakeService([]), listInstruments: async () => { throw new Error('boom') } } }) },
    })
    const wire = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: '茅台', market: 'cn' }))) as { total: number }
    expect(wire.total).toBeGreaterThan(0)
  })

  it('market 过滤 + query 缺失报错', async () => {
    const wire = JSON.parse(String(await createInstrumentsSearchTool(makeServices()).execute({ query: '平安', market: 'cn' }))) as { results: Array<{ market: string }> }
    expect(wire.results.every(r => r.market === 'cn')).toBe(true)
    await expect(createInstrumentsSearchTool(makeServices()).execute({})).rejects.toThrow(/missing required property/)
  })

  it('静态字典数据完整（cn 市场 × 多行）', () => {
    expect(Object.keys(SYMBOL_CATALOG).sort()).toEqual(['cn'])
    expect(SYMBOL_CATALOG.cn!.length).toBeGreaterThan(3)
    expect(SYMBOL_CATALOG.cn!.some(e => e.symbol === '600519.SH')).toBe(true)
    expect(SYMBOL_CATALOG.cn!.some(e => e.symbol === '510050.SH')).toBe(true)
  })
})
