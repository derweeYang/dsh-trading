import { describe, expect, it } from 'vitest'
import { IquantRestClient, parseIquantSymbol, TradingServiceError } from '../src/rest.js'

function stubFetch(handler: (url: string) => unknown) {
  return (async (input: unknown) => {
    const url = String(input)
    const body = handler(url)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

describe('parseIquantSymbol', () => {
  it('maps cash and option books', () => {
    expect(parseIquantSymbol('510050.SH')).toMatchObject({ market: 'SH', code: '510050' })
    expect(parseIquantSymbol('10011255')).toMatchObject({ market: 'SHO', symbol: '10011255.SHO' })
    expect(parseIquantSymbol('90007051.SZO')).toMatchObject({ market: 'SZO' })
  })

  it('rejects long option codes and foreign symbols', () => {
    expect(() => parseIquantSymbol('510050C2609M02850')).toThrow(TradingServiceError)
    expect(() => parseIquantSymbol('AAPL')).toThrow(TradingServiceError)
  })
})

describe('IquantRestClient', () => {
  it('reads ticker from fake gateway', async () => {
    const client = new IquantRestClient({
      gatewayUrl: 'http://127.0.0.1:5810',
      fetchImpl: stubFetch(() => ({ ok: true, result: { symbol: '510050.SH', last: 3.017, volume: 10 } })),
    })
    const ticker = await client.getTicker('510050')
    expect(ticker.price).toBe(3.017)
    expect(ticker.symbol).toBe('510050.SH')
  })

  it('maps unreachable gateway to TRADING_NETWORK', async () => {
    const client = new IquantRestClient({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as typeof fetch,
    })
    await expect(client.getTicker('510050.SH')).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })
})
