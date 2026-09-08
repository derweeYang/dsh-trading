import { describe, expect, it } from 'vitest'
import type { CnOptionsService, OptionChain } from '@dshtrading/api'
import { createGetOptionChainTool, createGetOptionExpiriesTool } from '../src/options-tools.ts'

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
  }
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
