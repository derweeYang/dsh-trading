/**
 * 数据面行单测：cn 单市场——provide tradingCnMarketData；注册表模式下注册 (cn, tencent)。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'

function makeCtx(): { ctx: Context; provided: Record<string, unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: {
      provide: (name: string, value: unknown) => { provided[name] = value },
    },
  } as unknown as Context
  return { ctx, provided }
}

describe('connector-tencent dataplane', () => {
  it('market=cn → provide tradingCnMarketData', () => {
    const { ctx, provided } = makeCtx()
    apply(ctx, { market: 'cn', dryRun: true, liveTrading: false })
    expect(provided.tradingCnMarketData).toBeDefined()
  })
})

describe('connector-tencent dataplane（注册表模式，2026-08-30 整改 #1）', () => {
  function makeRegistryCtx() {
    const provided: Record<string, unknown> = {}
    const registrations: Array<{ market: string; provider: string; service: unknown }> = []
    const registry = {
      register: (market: string, provider: string, service: unknown) => {
        registrations.push({ market, provider, service })
        return () => {}
      },
    }
    const ctx = {
      get: (key: string) => (key === 'tradingMarketDataRegistry' ? registry : undefined),
      isolate: () => ({ reflect: { provide: () => {} } }),
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    } as unknown as Context
    return { ctx, provided, registrations }
  }

  it('market=cn → 注册 (cn, tencent)；根键不占', () => {
    const cn = makeRegistryCtx()
    apply(cn.ctx, { market: 'cn', dryRun: true, liveTrading: false })
    expect(cn.registrations).toHaveLength(1)
    expect(cn.registrations[0]?.market).toBe('cn')
    expect(cn.registrations[0]?.provider).toBe('tencent')
    expect(cn.provided.tradingCnMarketData).toBeUndefined()
  })
})
