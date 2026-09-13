import { describe, expect, it } from 'vitest'
import {
  OptionsRestClient,
  TradingServiceError,
  expiryDateOf,
  isKnownUnderlying,
  listStaticUnderlyings,
  normalizeCnUnderlying,
  seasonalExpiryMonths,
} from '../src/rest.js'

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

describe('normalizeCnUnderlying', () => {
  it('接受现货规范形、裸码与期权长代码', () => {
    expect(normalizeCnUnderlying('510050.SH')).toBe('510050')
    expect(normalizeCnUnderlying('510050')).toBe('510050')
    expect(normalizeCnUnderlying('510050C2609M02850')).toBe('510050')
    expect(normalizeCnUnderlying('159915.SZ')).toBe('159915')
  })

  it('拒绝无法识别的符号', () => {
    expect(() => normalizeCnUnderlying('AAPL')).toThrow(TradingServiceError)
    expect(() => normalizeCnUnderlying('')).toThrow(/required/)
  })

  it('静态名册覆盖沪深注册标的', () => {
    expect(isKnownUnderlying('510050')).toBe(true)
    expect(isKnownUnderlying('588080')).toBe(true)
    expect(isKnownUnderlying('159915')).toBe(true)
    expect(isKnownUnderlying('910050')).toBe(true)
    // 2026-09-13 起 510300/510500 移出标的名册
    expect(isKnownUnderlying('510300')).toBe(false)
    expect(isKnownUnderlying('510500')).toBe(false)
    expect(isKnownUnderlying('600519')).toBe(false)
  })

  it('listUnderlyings 不打网关', async () => {
    const client = new OptionsRestClient({
      source: 'akshare',
      fetchImpl: (async () => {
        throw new Error('listUnderlyings must not hit the gateway')
      }) as typeof fetch,
    })
    const rows = await client.listUnderlyings()
    expect(rows.map((row) => row.underlying)).toContain('510050')
    expect(rows.find((row) => row.underlying === '159915')?.quotesSource).toBe('szse_static_only')
    expect(listStaticUnderlyings('synth')[0]?.underlying).toBe('910050')
  })

  it('第四个周三与标准四季月', () => {
    expect(expiryDateOf('2609', new Date('2026-09-08T00:00:00Z'))).toBe('2026-09-23')
    expect(seasonalExpiryMonths(new Date('2026-09-08T00:00:00Z'))).toEqual(['2609', '2610', '2612', '2703'])
  })

  it('getOptionExpiries 不打网关', async () => {
    const client = new OptionsRestClient({
      fetchImpl: (async () => {
        throw new Error('expiries must not hit the gateway')
      }) as typeof fetch,
    })
    const calendar = await client.getOptionExpiries({ underlying: '510050.SH' })
    expect(calendar.underlying).toBe('510050')
    expect(calendar.months).toHaveLength(4)
    expect(calendar.months[0]?.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('OptionsRestClient', () => {
  it('getOptionChain 规范化标的并透传内核 result', async () => {
    const client = new OptionsRestClient({
      source: 'synth',
      fetchImpl: stubFetch([
        {
          match: '/v1/chain',
          body: {
            ok: true,
            result: {
              source: 'synth',
              underlying: '910050',
              expiryMonth: '2612',
              calls: [{ code: '910050C2612M02850', strike: 2.85, last: 0.12 }],
              puts: [{ code: '910050P2612M02850', strike: 2.85, last: 0.08 }],
            },
          },
        },
      ]),
    })
    const chain = await client.getOptionChain({ underlying: '910050.SH', expiryMonth: '2612' })
    expect(chain.underlying).toBe('910050')
    expect(chain.calls).toHaveLength(1)
    expect(chain.puts[0]?.code).toBe('910050P2612M02850')
  })

  it('内核 NO_DATA → TRADING_NO_DATA', async () => {
    const client = new OptionsRestClient({
      fetchImpl: stubFetch([
        {
          match: '/v1/chain',
          body: { ok: false, error: { code: 'NO_DATA', message: '159915 is szse_static_only' } },
          status: 200,
        },
      ]),
    })
    await expect(client.getOptionChain({ underlying: '159915', expiryMonth: '2609' }))
      .rejects.toMatchObject({ code: 'TRADING_NO_DATA' })
  })

  it('网关不可达 → TRADING_NETWORK', async () => {
    const client = new OptionsRestClient({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(client.getOptionChain({ underlying: '510050', expiryMonth: '2609' }))
      .rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })

  it('缺 expiryMonth 拒绝', async () => {
    const client = new OptionsRestClient({
      fetchImpl: (async () => {
        throw new Error('should not fetch')
      }) as typeof fetch,
    })
    await expect(client.getOptionChain({ underlying: '510050' }))
      .rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})
