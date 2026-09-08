/**
 * iQuant 数据面：注册表模式注册 (cn, iquant)；无注册表回退 provide；
 * 根键已被占用时不二次 provide（多家 CN dataplane 并行 apply 时不炸 Include）。
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

describe('connector-iquant dataplane', () => {
  it('无注册表 → provide tradingCnMarketData', () => {
    const { ctx, provided } = makeCtx()
    apply(ctx, { market: 'cn', enabled: true })
    expect(provided.tradingCnMarketData).toBeDefined()
  })

  it('enabled=false → 不 provide', () => {
    const { ctx, provided } = makeCtx()
    apply(ctx, { market: 'cn', enabled: false })
    expect(provided.tradingCnMarketData).toBeUndefined()
  })
})

describe('connector-iquant dataplane（注册表模式）', () => {
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

  it('注册 (cn, iquant)；根键不占', () => {
    const env = makeRegistryCtx()
    apply(env.ctx, { market: 'cn', enabled: true })
    expect(env.registrations).toHaveLength(1)
    expect(env.registrations[0]?.market).toBe('cn')
    expect(env.registrations[0]?.provider).toBe('iquant')
    expect(env.provided.tradingCnMarketData).toBeUndefined()
  })
})

describe('connector-iquant dataplane（无注册表时不二次 provide）', () => {
  it('市场键已被占用 → 跳过，不覆盖', () => {
    const existing = { keep: true }
    const provided: Record<string, unknown> = { tradingCnMarketData: existing }
    const ctx = {
      get: (key: string) => (key === 'tradingCnMarketData' ? existing : undefined),
      reflect: {
        provide: (name: string, value: unknown) => { provided[name] = value },
      },
    } as unknown as Context
    apply(ctx, { market: 'cn', enabled: true })
    expect(provided.tradingCnMarketData).toBe(existing)
  })
})
