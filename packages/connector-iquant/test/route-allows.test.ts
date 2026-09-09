import { describe, expect, it } from 'vitest'
import { ROUTER_PROVIDER, routeAllows, type Config } from '../src/index.js'

const base: Config = { enabled: true, market: 'cn', gatewayUrl: 'http://127.0.0.1:5810' }

function ctxWithRouter(active: string | undefined) {
  return {
    get: (key: string) =>
      key === 'tradingMarketRouter'
        ? { activeProvider: () => active }
        : undefined,
  } as never
}

describe('connector-iquant routeAllows', () => {
  it('enabled=false → false', () => {
    expect(routeAllows(ctxWithRouter('iquant'), { ...base, enabled: false })).toBe(false)
  })

  it('无 router → true（回退 enabled 语义）', () => {
    expect(routeAllows({ get: () => undefined } as never, base)).toBe(true)
  })

  it('router 选中 iquant → true', () => {
    expect(routeAllows(ctxWithRouter(ROUTER_PROVIDER), base)).toBe(true)
  })

  it('router 选中其它 provider → false', () => {
    expect(routeAllows(ctxWithRouter('tencent'), base)).toBe(false)
  })
})
