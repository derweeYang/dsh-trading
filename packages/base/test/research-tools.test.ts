import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, createResearchTools } from '../src/research-tools.js'
import * as cn from '../../kit-cn/src/index.js'

it('routed research tools execute ticker/klines, react to route changes, and never offer execution', async () => {
  const service = { getTicker: vi.fn(async () => ({ symbol: '600519.SH', last: 10 })), getKlines: vi.fn(async () => []) }
  let provider = 'tencent'
  const tools = createResearchTools('cn', () => ({ active: () => ({ provider, service: service as never }) }))
  expect(tools.map(t => t.name)).toEqual(['cn_get_ticker', 'cn_get_klines'])
  const result = await tools[0].execute({ symbol: '600519.SH' } as never)
  expect(JSON.parse(result as string).provider).toBe('tencent')
  provider = 'eastmoney'
  expect(JSON.parse(await tools[1].execute({ symbol: '600519.SH', interval: '1d', limit: 20 } as never) as string).provider).toBe('eastmoney')
  expect(service.getKlines).toHaveBeenCalledWith('600519.SH', '1d', 20)
  await expect(tools[1].execute({ symbol: '600519.SH', limit: 1001 } as never)).rejects.toThrow('limit')
  await expect(createResearchTools('cn', () => undefined)[0].execute({ symbol: '600519.SH' } as never)).rejects.toThrow('unavailable')
})
it('agent-plane registration deduplicates market config and does not publish services', () => {
  const register = vi.fn()
  apply({ tools: { register } } as unknown as Context, { markets: ['cn', 'cn'] })
  expect(register.mock.calls.map(([tool]) => tool.name)).toEqual(['cn_get_ticker', 'cn_get_klines'])
})
describe.each([['cn', cn]] as const)('%s research kit', (market, kit) => {
  it('actually registers news/fundamentals but zero order tools or services', () => {
    const names: string[] = []
    const ctx = {
      skills: { registerProvider: vi.fn() },
      tools: { get: () => undefined, register: (tool: { name: string }) => names.push(tool.name) },
      get: () => undefined,
      inject: vi.fn(),
      logger: () => ({ info: vi.fn() }),
    } as unknown as Context
    kit.apply(ctx, { dryRun: true, liveTrading: false })
    expect(names).toContain(`${market}_get_news`)
    expect(names).toContain(`${market}_get_fundamentals`)
    expect(names.some(name => /(?:place|cancel)_order/.test(name))).toBe(false)
  })
})
