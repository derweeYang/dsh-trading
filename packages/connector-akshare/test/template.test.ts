import { describe, expect, it } from 'vitest'
import {
  AkshareRestClient,
  INTERVAL_VOCABULARY,
  toEastmoneySecid,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

describe('AkshareRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toEastmoneySecid('600519')).toEqual({ secid: '1.600519', canonical: '600519.SH' })
    expect(toEastmoneySecid('000001')).toEqual({ secid: '0.000001', canonical: '000001.SZ' })
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('AkshareRestClient.getTicker', () => {
  it('拉取并解析 A 股 Ticker（分精度价格除以 100，含官方昨收/涨跌幅）', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: {
          data: {
            f43: 175050,
            f47: 25000,
            f60: 174800,
            f86: 1725000000,
            f170: 15,
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')

    expect(ticker).toEqual({
      symbol: '600519.SH',
      price: 1750.5,
      volume: 25000,
      timestamp: 1725000000000,
      prevClose: 1748,
      changePercent: 0.15,
    })
  })
})

describe('AkshareRestClient.getSectorFundFlow', () => {
  it('拉取板块资金流（f3 涨跌幅除以 100）', async () => {
    const { impl } = stubFetch([
      {
        match: 'clist/get',
        body: {
          data: {
            diff: [
              { f14: '半导体', f3: 345, f62: 1250000000 },
              { f14: '航空机场', f3: -120, f62: -50000000 },
            ],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const list = await client.getSectorFundFlow()

    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      name: '半导体',
      changePercent: 3.45,
      mainNetInflow: 1250000000,
    })
    expect(list[1]).toEqual({
      name: '航空机场',
      changePercent: -1.2,
      mainNetInflow: -50000000,
    })
  })
})

/** 东财 datacenter 信封（spikes/impl-akshare-cov/bond-cov-raw-sample.json 形态）。 */
function covPage(pages: number, data: unknown[]) {
  return { success: 1, result: { pages, count: 500 * pages, data } }
}

describe('AkshareRestClient.getCovSnapshot', () => {
  it('过滤退市与无报价行，量纲原样透传（spike 取证形态）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: 'reportName=RPT_BOND_CB_LIST',
        body: covPage(1, [
          {
            SECURITY_CODE: '123284', SECURITY_NAME_ABBR: '强达转债', TRADE_MARKET: 'CNSESZ',
            CONVERT_STOCK_CODE: '002997', CONVERT_STOCK_PRICE: 120.1, TRANSFER_PRICE: 84.04,
            TRANSFER_VALUE: 142.9081, CURRENT_BOND_PRICE: 207.925, TRANSFER_PREMIUM_RATIO: 45.5,
            DELIST_DATE: null,
          },
          {
            // 退市行（强赎摘牌）：DELIST_DATE 带日期 → 剔除。
            SECURITY_CODE: '113697', SECURITY_NAME_ABBR: '应流转债', TRADE_MARKET: 'CNSESH',
            CONVERT_STOCK_CODE: '603308', CONVERT_STOCK_PRICE: 41.5, TRANSFER_PRICE: null,
            CURRENT_BOND_PRICE: null, DELIST_DATE: '2026-08-28 00:00:00',
          },
          {
            // 存续但无报价（'-'）→ 剔除。
            SECURITY_CODE: '127116', SECURITY_NAME_ABBR: '瑞鹄转02', TRADE_MARKET: 'CNSESZ',
            CONVERT_STOCK_CODE: '002997', CONVERT_STOCK_PRICE: 41.5, TRANSFER_PRICE: '-',
            CURRENT_BOND_PRICE: '-', TRANSFER_PREMIUM_RATIO: '-', DELIST_DATE: null,
          },
        ]),
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const rows = await client.getCovSnapshot()

    expect(rows).toEqual([{
      bondCode: '123284',
      bondName: '强达转债',
      exchange: 'SZ',
      price: 207.925,
      stockCode: '002997',
      stockPrice: 120.1,
      conversionPrice: 84.04,
      conversionValue: 142.9081,
      premiumPct: 45.5,
    }])
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('reportName=RPT_BOND_CB_LIST')
    expect(urls[0]).toContain('pageNumber=1')
  })

  it('多页翻完即止（pages=2 → 恰好两次请求）', async () => {
    let calls = 0
    const impl = (async (input: unknown) => {
      const url = String(input)
      calls += 1
      const pageNumber = Number(new URL(url).searchParams.get('pageNumber'))
      const data = pageNumber === 1
        ? [{ SECURITY_CODE: '111001', SECURITY_NAME_ABBR: 'A', TRADE_MARKET: 'CNSESH', CONVERT_STOCK_CODE: '600001', CONVERT_STOCK_PRICE: 10, TRANSFER_PRICE: 10, CURRENT_BOND_PRICE: 100, DELIST_DATE: null }]
        : [{ SECURITY_CODE: '111002', SECURITY_NAME_ABBR: 'B', TRADE_MARKET: 'CNSESZ', CONVERT_STOCK_CODE: '000002', CONVERT_STOCK_PRICE: 20, TRANSFER_PRICE: 20, CURRENT_BOND_PRICE: 110, DELIST_DATE: null }]
      return jsonResponse(covPage(2, data))
    }) as typeof fetch
    const client = new AkshareRestClient({ fetchImpl: impl })
    const rows = await client.getCovSnapshot()
    expect(calls).toBe(2)
    expect(rows.map((r) => r.bondCode)).toEqual(['111001', '111002'])
  })

  it('HTTP 错误映射 TRADING_UPSTREAM_ERROR', async () => {
    const { impl } = stubFetch([
      { match: 'reportName=RPT_BOND_CB_LIST', body: { message: 'bad' }, status: 502 },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    await expect(client.getCovSnapshot()).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })
})
