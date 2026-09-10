/**
 * 期权聚合面桥 fetch（2026-09-09 WB-0）。
 *
 * 锁的是 **请求形状**，不是数据加工——这四个端点是总览/箱体/闭环页面的唯一
 * 入口，query 字符串被改坏（比如 includeIv 默认打开）不会在本地报错，只会在
 * 真机把网关打爆。同时锁错误分诊：NOT_IMPLEMENTED 要原样透出给 UI 隐藏透镜。
 *
 * 覆盖：
 * - overview：sort 透传、includeIv 默认 0（不默认打九路 vol_analytics）；
 * - intraday-box：horizon 不出现（写死 5 由桥缺省），underlying/asOf 透传；
 * - cycles/loop：无参固定端点；
 * - cycles：underlying + limit 透传；
 * - 分诊：TRADING_NOT_IMPLEMENTED → ok:false 且 code 原样；缺键 → 失败不吞。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchOptionsBarPacket, fetchOptionsCycleLoop, fetchOptionsCycles, fetchOptionsIntradayBox, fetchOptionsOverview,
} from '../src/client/api.ts'

/** 记录每次请求的 URL，返回预置响应体。 */
function stubFetch(handler: (url: string) => unknown): () => string[] {
  const urls: string[] = []
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
    return Promise.resolve(new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  })
  vi.stubGlobal('fetch', mock as unknown as typeof globalThis.fetch)
  return () => urls
}

const OVERVIEW = {
  ok: true,
  overview: {
    source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z',
    scanAllPrompt: 'scan all', rows: [],
  },
}
const BOX = { ok: true, box: { asOf: '2026-09-09T01:00:00.000Z', horizonMin: 5, lookback: 60, rows: [] } }
const LOOP = { ok: true, loop: { running: true, horizonMin: 5, rows: [] } }
const CYCLES = { ok: true, cycles: [] }

describe('options aggregate bridge fetch', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('overview 透传 sort，includeIv 默认 0', async () => {
    const urls = stubFetch(() => OVERVIEW)
    const res = await fetchOptionsOverview({ sort: 'strength' })
    expect(res.ok).toBe(true)
    expect(urls()[0]).toBe('/dshtrading/api/options/overview?sort=strength&includeIv=0')
  })

  it('overview 切 iv 排序才显式 includeIv=1（并打网关）', async () => {
    const urls = stubFetch(() => OVERVIEW)
    await fetchOptionsOverview({ sort: 'iv', includeIv: true })
    expect(urls()[0]).toContain('sort=iv')
    expect(urls()[0]).toContain('includeIv=1')
  })

  it('overview 不传 sort 时不拼该键（桥缺省 strength）', async () => {
    const urls = stubFetch(() => OVERVIEW)
    await fetchOptionsOverview({})
    expect(urls()[0]).toBe('/dshtrading/api/options/overview?includeIv=0')
  })

  it('intraday-box 不拼 horizon（写死 5），透传 underlying/asOf', async () => {
    const urls = stubFetch(() => BOX)
    const res = await fetchOptionsIntradayBox({ underlying: '510050', asOf: '2026-09-09T02:30:00.000Z' })
    expect(res.ok).toBe(true)
    const url = urls()[0] ?? ''
    expect(url).not.toContain('horizon')
    expect(url).toContain('underlying=510050')
    expect(url).toContain('asOf=')
  })

  it('cycles/loop 无参固定端点', async () => {
    const urls = stubFetch(() => LOOP)
    const res = await fetchOptionsCycleLoop()
    expect(res.ok).toBe(true)
    expect(urls()[0]).toBe('/dshtrading/api/options/cycles/loop')
  })

  it('cycles 透传 underlying 与 limit', async () => {
    const urls = stubFetch(() => CYCLES)
    const res = await fetchOptionsCycles({ underlying: '510050', limit: 24 })
    expect(res.ok).toBe(true)
    expect(urls()[0]).toBe('/dshtrading/api/options/cycles?underlying=510050&limit=24')
  })

  it('未挂连接器：NOT_IMPLEMENTED 原样透出（UI 据此隐藏期权透镜）', async () => {
    stubFetch(() => ({ ok: false, code: 'TRADING_NOT_IMPLEMENTED', message: 'connector-options not installed' }))
    const res = await fetchOptionsOverview({})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('TRADING_NOT_IMPLEMENTED')
  })

  it('HTTP 200 但缺业务键 → 失败，不当成功值吞掉', async () => {
    stubFetch(() => ({ ok: true }))
    const res = await fetchOptionsCycleLoop()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('TRADING_UNKNOWN')
  })
})

describe('options bar-packet fetch（WB-12）', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('固定无参端点 /options/bar-packet', async () => {
    const urls = stubFetch(() => ({ ok: true }))
    const res = await fetchOptionsBarPacket()
    expect(res.ok).toBe(true)
    expect(urls()[0]).toBe('/dshtrading/api/options/bar-packet')
  })

  /** WB-12：无 packet 文件是正常态——桥不写 packet 键，前端收到 null（整条不渲染）。 */
  it('无 packet 键 → data 为 null，不报错', async () => {
    stubFetch(() => ({ ok: true }))
    const res = await fetchOptionsBarPacket()
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toBeNull()
  })

  it('有 packet → data 原样透传，按 underlying 对齐 rows', async () => {
    stubFetch(() => ({
      ok: true,
      packet: {
        bucketStart: '2026-09-10T01:45:00.000Z',
        asOf: '2026-09-10T01:45:12.000Z',
        rows: [{ underlying: '510050', regime: 'range_hold', ivRegime: 'unknown', candidates: [], volumeRatio: 0.8 }],
      },
    }))
    const res = await fetchOptionsBarPacket()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).not.toBeNull()
      expect(res.data?.rows[0]?.underlying).toBe('510050')
      expect(res.data?.rows[0]?.ivRegime).toBe('unknown')
    }
  })
})
