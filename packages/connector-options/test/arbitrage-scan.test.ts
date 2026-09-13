import { describe, expect, it } from 'vitest'
import { multiplierOf, OptionsRestClient, TradingServiceError } from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const impl = (async (input: unknown) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return impl
}

/**
 * 510050 2609 链快照（spot=2.90，ATM 挂真实买卖盘，其余档只有 last）。
 * K=2.90 卖合成可执行边 ≈ (0.044−0.036) − cashForward(≈0.0016) ≈ 0.0064 元/股。
 */
function chainBody(withQuotes: boolean) {
  const q = (last: number, bid?: number, ask?: number) =>
    withQuotes && bid !== undefined && ask !== undefined
      ? { last, bid, ask }
      : { last }
  return {
    ok: true,
    result: {
      source: 'iquant',
      underlying: '510050',
      expiryMonth: '2609',
      expiryDate: '2026-09-23',
      snapshotAt: '2026-09-11T15:00:00+08:00',
      calls: [
        { code: '510050C2609M02850', strike: 2.85, ...q(0.065) },
        { code: '510050C2609M02900', strike: 2.9, ...q(0.045, 0.044, 0.046) },
        { code: '510050C2609M02950', strike: 2.95, ...q(0.025) },
      ],
      puts: [
        { code: '510050P2609M02850', strike: 2.85, ...q(0.02) },
        { code: '510050P2609M02900', strike: 2.9, ...q(0.035, 0.034, 0.036) },
        { code: '510050P2609M02950', strike: 2.95, ...q(0.055) },
      ],
    },
  }
}

describe('multiplierOf', () => {
  it('从名册行读乘数，未注册回退 10000', () => {
    expect(multiplierOf('iquant', '510050')).toBe(10000)
    expect(multiplierOf('akshare', '159915')).toBe(10000)
    expect(multiplierOf('synth', '910050')).toBe(10000)
    expect(multiplierOf('other', '510050')).toBe(10000)
  })
})

describe('OptionsRestClient.getArbitrageScan', () => {
  it('链 + spot → 平价机会（executable=true，混合口径，名册乘数）', async () => {
    const client = new OptionsRestClient({
      source: 'iquant',
      fetchImpl: stubFetch([{ match: '/v1/chain', body: chainBody(true) }]),
    })
    const scan = await client.getArbitrageScan({
      underlying: '510050.SH',
      expiryMonth: '2609',
      spot: 2.9,
      thresholdPerShare: 0.0001,
    })
    expect(scan.underlying).toBe('510050')
    expect(scan.multiplier).toBe(10000)
    expect(scan.spot).toBeCloseTo(2.9, 6)
    expect(scan.asOf).toBe('2026-09-11T15:00:00+08:00')
    expect(scan.assumptions.priceBasis).toBe('mixed')
    expect(scan.assumptions.rate).toBeCloseTo(0.02, 6)
    const parity = scan.opportunities.find((o) => o.kind === 'parity' && o.strike === 2.9)
    expect(parity).toBeDefined()
    expect(parity?.executable).toBe(true)
    expect(parity?.edgePerShare ?? 0).toBeGreaterThan(0.006)
    expect(parity?.legs).toHaveLength(2)
    expect(scan.disclaimer).toContain('不构成投资建议')
  })

  it('无买卖盘 → 近似口径 executable=false，不出现 spot 则平价退化为箱型', async () => {
    const client = new OptionsRestClient({
      source: 'iquant',
      fetchImpl: stubFetch([{ match: '/v1/chain', body: chainBody(false) }]),
    })
    const scan = await client.getArbitrageScan({ underlying: '510050', expiryMonth: '2609', thresholdPerShare: 0.0001 })
    expect(scan.assumptions.priceBasis).toBe('mid_last')
    expect(scan.opportunities.length).toBeGreaterThan(0)
    for (const op of scan.opportunities) expect(op.executable).toBe(false)
  })

  it('includeVerticals=true 附带垂直价差全集', async () => {
    const client = new OptionsRestClient({
      source: 'iquant',
      fetchImpl: stubFetch([{ match: '/v1/chain', body: chainBody(false) }]),
    })
    const bare = await client.getArbitrageScan({ underlying: '510050', expiryMonth: '2609' })
    expect(bare.verticals).toBeUndefined()
    const full = await client.getArbitrageScan({
      underlying: '510050',
      expiryMonth: '2609',
      includeVerticals: true,
    })
    // 3 strikes → 3 pairs × 4 方向 = 12
    expect(full.verticals).toHaveLength(12)
    expect(full.verticals?.[0]?.legs).toHaveLength(2)
  })

  it('缺 expiryMonth 拒绝（不打网关）', async () => {
    const client = new OptionsRestClient({
      fetchImpl: (async () => {
        throw new Error('should not fetch')
      }) as typeof fetch,
    })
    await expect(client.getArbitrageScan({ underlying: '510050' }))
      .rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    await expect(client.getArbitrageScan({ underlying: '510050', expiryMonth: '  ' }))
      .rejects.toBeInstanceOf(TradingServiceError)
  })
})
