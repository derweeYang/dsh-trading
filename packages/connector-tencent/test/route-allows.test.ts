import { describe, expect, it } from 'vitest'
import { ROUTER_PROVIDER, routeAllows } from '../src/index.js'

function ctxWithRouter(active: string | undefined) {
  return {
    get: (key: string) =>
      key === 'tradingMarketRouter'
        ? { activeProvider: () => active }
        : undefined,
  } as never
}

describe('connector-tencent routeAllows', () => {
  it('无 router → true（回退候选全开语义）', () => {
    expect(routeAllows({ get: () => undefined } as never, 'cn')).toBe(true)
  })

  it('router 选中 tencent → true', () => {
    expect(routeAllows(ctxWithRouter(ROUTER_PROVIDER), 'cn')).toBe(true)
  })

  it('router 选中其它 provider → false', () => {
    expect(routeAllows(ctxWithRouter('iquant'), 'cn')).toBe(false)
  })
})
