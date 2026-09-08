import { describe, expect, it } from 'vitest'
import type { CnOptionsService, OptionChain } from '@dshtrading/api'
import {
  createGetOptionChainTool,
  createGetOptionExpiriesTool,
  createGetOptionPriceTool,
  createGetOptionStrategyTool,
  createGetOptionUnderlyingDailyTool,
  createGetOptionVolAnalyticsTool,
  createOptionParityCheckTool,
} from '../src/options-tools.ts'

function fakeService(chain: OptionChain): CnOptionsService {
  return {
    listUnderlyings: async () => [],
    getOptionExpiries: async () => ({
      underlying: '510050',
      source: 'synth',
      months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }],
    }),
    getOptionChain: async () => chain,
    getImpliedVol: async () => {
      throw new Error('not used')
    },
    getStrategy: async () => {
      throw new Error('not used')
    },
    getVolAnalytics: async () => {
      throw new Error('not used')
    },
    getUnderlyingDaily: async () => {
      throw new Error('not used')
    },
    getPrice: async () => {
      throw new Error('not used')
    },
    getParityCheck: async () => {
      throw new Error('not used')
    },
  }
}

function emptyChain(): OptionChain {
  return { underlying: '510050', expiryMonth: '2609', source: 'synth', calls: [], puts: [] }
}

describe('cn_get_option_chain', () => {
  it('serializes the T-quote chain from tradingCnOptions', async () => {
    const tool = createGetOptionChainTool({
      service: fakeService({
        underlying: '510050',
        expiryMonth: '2609',
        source: 'synth',
        calls: [{ code: '510050C2609M02850', strike: 2.85, last: 0.1 }],
        puts: [],
      }),
    })
    expect(tool.name).toBe('cn_get_option_chain')
    const text = await tool.execute({ underlying: '510050.SH', expiryMonth: '2609', source: 'synth' })
    expect(String(text)).toContain('510050C2609M02850')
  })

  it('cn_get_option_expiries serializes the seasonal calendar', async () => {
    const tool = createGetOptionExpiriesTool({ service: fakeService({
      underlying: '510050', expiryMonth: '2609', source: 'synth', calls: [], puts: [],
    }) })
    expect(tool.name).toBe('cn_get_option_expiries')
    const text = await tool.execute({ underlying: '510050.SH' })
    expect(String(text)).toContain('2609')
    expect(String(text)).toContain('2026-09-23')
  })

  it('cn_get_option_strategy 透传 holdingQty（阶段 4 备兑现货腿预填）；缺席整键省略', async () => {
    const requests: unknown[] = []
    const tool = createGetOptionStrategyTool({
      service: {
        ...fakeService(emptyChain()),
        getStrategy: async (request) => {
          requests.push(request)
          return {
            underlying: '510050', source: 'synth', multiplier: 10000, spot: 2.9,
            legs: [], entry: { debitCredit: 0, note: '' }, payoff: [],
            greeks: { status: 'insufficient', net: {}, legs: [] },
            margin: { perLeg: [], totalInitial: 0, totalMaintenance: 0, note: '' },
          }
        },
      },
    })
    await tool.execute({ underlying: '510050.SH', template: 'covered_call', holdingQty: 25000 })
    expect(requests[0]).toMatchObject({ underlying: '510050.SH', template: 'covered_call', holdingQty: 25000 })

    await tool.execute({ underlying: '510050.SH' })
    expect('holdingQty' in (requests[1] as Record<string, unknown>)).toBe(false)
  })

  it('cn-risk-checklist mentions ETF option obligation margin', async () => {
    const { readFile } = await import('node:fs/promises')
    const body = await readFile(new URL('../assets/skills/cn-risk-checklist.md', import.meta.url), 'utf8')
    expect(body).toContain('义务仓')
    expect(body).toContain('510050C2609M02850')
  })

  it('fails closed when the options service is not mounted', async () => {
    const tool = createGetOptionChainTool()
    await expect(tool.execute({ underlying: '510050', expiryMonth: '2609' }))
      .rejects.toThrow(/tradingCnOptions is not mounted/)
  })
})

describe('阶段 3 内核上桥：vol_analytics / underlying_daily / price / parity_check', () => {
  it('cn_get_option_vol_analytics 解析逗号分隔 expiryMonths 并透传 source=iquant', async () => {
    const queries: unknown[] = []
    const tool = createGetOptionVolAnalyticsTool({
      service: {
        ...fakeService(emptyChain()),
        getVolAnalytics: async (query) => {
          queries.push(query)
          return { termStructure: [{ expiryMonth: '2609', atmIv: 0.18 }] }
        },
      },
    })
    expect(tool.name).toBe('cn_get_option_vol_analytics')
    const text = await tool.execute({
      underlying: '510050.SH', expiryMonths: '2609, 2610', asOf: '2026-09-08', rate: 0.015, source: 'iquant',
    })
    expect(String(text)).toContain('termStructure')
    expect(queries[0]).toMatchObject({
      underlying: '510050.SH', expiryMonths: ['2609', '2610'], asOf: '2026-09-08', rate: 0.015, source: 'iquant',
    })
  })

  it('cn_get_option_vol_analytics：expiryMonths 全空白 → 整键省略；未知 source → 整键省略', async () => {
    const queries: unknown[] = []
    const tool = createGetOptionVolAnalyticsTool({
      service: {
        ...fakeService(emptyChain()),
        getVolAnalytics: async (query) => {
          queries.push(query)
          return {}
        },
      },
    })
    await tool.execute({ underlying: '510050.SH', expiryMonths: ' , ', source: 'binance' })
    expect(queries[0]).toEqual({ underlying: '510050.SH' })
    expect('expiryMonths' in (queries[0] as Record<string, unknown>)).toBe(false)
    expect('source' in (queries[0] as Record<string, unknown>)).toBe(false)
  })

  it('cn_get_option_underlying_daily：source 必填（iquant/akshare 二值），adjust=qfq 透传、adjust 空/非法省略', async () => {
    const queries: unknown[] = []
    const tool = createGetOptionUnderlyingDailyTool({
      service: {
        ...fakeService(emptyChain()),
        getUnderlyingDaily: async (query) => {
          queries.push(query)
          return { rows: 3 }
        },
      },
    })
    expect(tool.name).toBe('cn_get_option_underlying_daily')
    const text = await tool.execute({ source: 'iquant', underlying: '510050', start: '2026-01-01', adjust: 'qfq' })
    expect(String(text)).toContain('rows')
    expect(queries[0]).toEqual({
      source: 'iquant', underlying: '510050', start: '2026-01-01', adjust: 'qfq',
    })

    // source 非法值回退 akshare；adjust 缺省（原始价）与非法值 → 整键省略
    await tool.execute({ source: 'not-a-source', adjust: 'xx' })
    expect(queries[1]).toEqual({ source: 'akshare' })
  })

  it('cn_get_option_price：纯计算参数透传，optionType 二值归一（P 保留，其余归 C）', async () => {
    const queries: unknown[] = []
    const tool = createGetOptionPriceTool({
      service: {
        ...fakeService(emptyChain()),
        getPrice: async (query) => {
          queries.push(query)
          return { price: 0.0856, delta: -0.31 }
        },
      },
    })
    expect(tool.name).toBe('cn_get_option_price')
    const text = await tool.execute({
      spot: 2.912, strike: 2.85, optionType: 'P', vol: 0.18, years: 0.5, rate: 0.015, dividendYield: 0.01,
    })
    expect(String(text)).toContain('0.0856')
    expect(queries[0]).toEqual({
      spot: 2.912, strike: 2.85, vol: 0.18, optionType: 'P',
      years: 0.5, rate: 0.015, dividendYield: 0.01,
    })

    // optionType 非法字符串 → 归一 'C'（缺省在 dsh-tools 层即被 required 校验拦截）；expiryDate+asOf 路径透传
    await tool.execute({ spot: 2.912, strike: 2.85, optionType: 'call', vol: 0.18, expiryDate: '2026-09-23', asOf: '2026-09-08' })
    expect(queries[1]).toEqual({
      spot: 2.912, strike: 2.85, vol: 0.18, optionType: 'C',
      expiryDate: '2026-09-23', asOf: '2026-09-08',
    })
  })

  it('cn_option_parity_check：underlying+expiryMonth 透传，threshold/rate 可选透传', async () => {
    const queries: unknown[] = []
    const tool = createOptionParityCheckTool({
      service: {
        ...fakeService(emptyChain()),
        getParityCheck: async (query) => {
          queries.push(query)
          return { pairs: [], threshold: query.threshold ?? 0 }
        },
      },
    })
    expect(tool.name).toBe('cn_option_parity_check')
    const text = await tool.execute({
      underlying: '510050.SH', expiryMonth: '2609', rate: 0.015, threshold: 0.002, source: 'iquant',
    })
    expect(String(text)).toContain('pairs')
    expect(queries[0]).toEqual({
      underlying: '510050.SH', expiryMonth: '2609', rate: 0.015, threshold: 0.002, source: 'iquant',
    })

    // 可选项缺席 → 整键省略
    await tool.execute({ underlying: '510050.SH', expiryMonth: '2609' })
    expect(queries[1]).toEqual({ underlying: '510050.SH', expiryMonth: '2609' })
  })

  it('四个新工具在服务未挂载时同样 fails closed', async () => {
    await expect(createGetOptionVolAnalyticsTool().execute({ underlying: '510050.SH' }))
      .rejects.toThrow(/tradingCnOptions is not mounted/)
    await expect(createGetOptionUnderlyingDailyTool().execute({ source: 'akshare' }))
      .rejects.toThrow(/tradingCnOptions is not mounted/)
    await expect(createGetOptionPriceTool().execute({ spot: 1, strike: 1, vol: 0.1, optionType: 'C' }))
      .rejects.toThrow(/tradingCnOptions is not mounted/)
    await expect(createOptionParityCheckTool().execute({ underlying: '510050.SH', expiryMonth: '2609' }))
      .rejects.toThrow(/tradingCnOptions is not mounted/)
  })
})
