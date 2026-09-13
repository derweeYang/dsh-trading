/**
 * 期权纸账户 api 封装单测（2026-09-13 WB-15）。
 *
 * 这层唯一职责是「把桥 JSON 分诊成 OptionsOutcome」，最容易出的错是
 * **把失败吞成空数据**：资产面板会把 404 画成「权益 0」，等于把故障说成事实。
 * 所以每支都断言两件事：请求形状（URL/method）与失败信封（code 原样上浮）。
 *
 * 全程 fetch 桩，不触网。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OPTION_PAPER_FILLS_LIMIT, fetchOptionPaperAccount, fetchOptionPaperAccounts, fetchOptionPaperFills, resetOptionPaper,
} from '../src/client/api.ts'

function stubFetchOnce(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(handler) as unknown as typeof globalThis.fetch
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const ACCOUNT = { currency: 'CNY' as const, initialCash: 100_000, cash: 72_755.4, realizedPnl: 154.8, updatedAt: '2026-09-08T06:56:00.000Z', id: 'arbitrage' as const }

describe('期权纸账户 api 封装', () => {
  it('fetchOptionPaperAccounts：GET 两账本；books 缺键兜底空数组（不炸调用方）', async () => {
    let url: string | undefined
    stubFetchOnce(async (u) => {
      url = String(u)
      return jsonResponse({
        ok: true,
        books: [
          { ok: true, book: 'arbitrage', account: ACCOUNT, equity: 100_154.8, positions: [] },
          { ok: true, book: 'strategy', account: { ...ACCOUNT, id: 'strategy' }, equity: 100_000, positions: [] },
        ],
      })
    })
    const res = await fetchOptionPaperAccounts()
    expect(url).toBe('/dshtrading/api/options/paper/accounts')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.books.map(b => b.book)).toEqual(['arbitrage', 'strategy'])

    stubFetchOnce(async () => jsonResponse({ ok: true }))
    const sparse = await fetchOptionPaperAccounts()
    expect(sparse.ok && sparse.data.books).toEqual([])
  })

  it('fetchOptionPaperAccount：缺省不打 book；显式 book 进 query；account 缺键 → 失败信封', async () => {
    const urls: string[] = []
    stubFetchOnce(async (u) => {
      urls.push(String(u))
      return jsonResponse({ ok: true, book: 'strategy', account: ACCOUNT, equity: 100_000, positions: [] })
    })
    expect((await fetchOptionPaperAccount()).ok).toBe(true)
    expect((await fetchOptionPaperAccount('arbitrage')).ok).toBe(true)
    expect(urls).toEqual([
      '/dshtrading/api/options/paper/account',
      '/dshtrading/api/options/paper/account?book=arbitrage',
    ])

    stubFetchOnce(async () => jsonResponse({ ok: true, book: 'strategy' }))
    const broken = await fetchOptionPaperAccount()
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.message).toContain('account missing in wire')
  })

  it('fetchOptionPaperFills：limit 恒有（与桥缺省一致）+ book；缺 fills 键兜底空数组', async () => {
    let url: string | undefined
    stubFetchOnce(async (u) => {
      url = String(u)
      return jsonResponse({ ok: true, fills: [{ id: 'f1' }] })
    })
    const res = await fetchOptionPaperFills('arbitrage')
    expect(url).toBe(`/dshtrading/api/options/paper/fills?limit=${String(OPTION_PAPER_FILLS_LIMIT)}&book=arbitrage`)
    expect(res.ok && res.data.length).toBe(1)

    stubFetchOnce(async () => jsonResponse({ ok: true }))
    const sparse = await fetchOptionPaperFills()
    expect(sparse.ok && sparse.data).toEqual([])
  })

  it('fetchOptionPaperFills：桥 400（limit/book 非法）→ code 原样上浮，不静默空', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'options paper fills: limit must be a positive integer' }, 400))
    const res = await fetchOptionPaperFills('strategy', 0)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('TRADING_PROTOCOL')
    expect(res.message).toContain('limit must be a positive integer')
  })

  it('fetchOptionPaperFills：网络失败 → TRADING_UNKNOWN（不当成「没有成交」）', async () => {
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    const res = await fetchOptionPaperFills()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('TRADING_UNKNOWN')
  })

  it('resetOptionPaper：POST + query book（桥两条路都收，这里只走 query）', async () => {
    let url: string | undefined
    let method: string | undefined
    let body: string | undefined
    stubFetchOnce(async (u, init) => {
      url = String(u)
      method = init?.method
      body = String(init?.body)
      return jsonResponse({
        ok: true, book: 'arbitrage',
        account: { ...ACCOUNT, cash: 100_000, realizedPnl: 0 }, equity: 100_000, positions: [],
      })
    })
    const res = await resetOptionPaper('arbitrage')
    expect(method).toBe('POST')
    expect(url).toBe('/dshtrading/api/options/paper/reset?book=arbitrage')
    expect(body).toBe('{}')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.book).toBe('arbitrage')
    expect(res.data.account.cash).toBe(100_000)
  })

  it('resetOptionPaper：业务拒绝（200 + ok:false，book 非法）→ 失败信封带桥的 code', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'options paper: book must be strategy|arbitrage' }))
    const res = await resetOptionPaper('strategy')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('TRADING_PROTOCOL')
  })

  it('resetOptionPaper：回包缺 account → 失败（不冒充重置成功）', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: true, book: 'strategy' }))
    const res = await resetOptionPaper('strategy')
    expect(res.ok).toBe(false)
  })
})
