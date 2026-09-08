/**
 * 自选股 host SSOT 同步单测（离线，mock api 模块）：启动同步（host 赢）、
 * 一次性迁移（幂等拒绝跳过）、变更 host-first 接管、SSE 双通道刷新。
 *
 * 2026-09-08 市场收敛：fixture 统一 cn 词汇（store.add 经 inferMarket 归一 'cn'，
 * 非 cn 键会被 sanitizeWatchlists 剔除——断言必须落在 cn 键上）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSelectionStore, createWatchlistStore, type Instrument } from '../src/client/store.ts'
import { wireHostWatchlistSync } from '../src/client/host-watchlist-sync.ts'

const apiMock = vi.hoisted(() => ({
  fetchHostWatchlists: vi.fn(),
  fetchHostSelection: vi.fn(),
  addHostWatchlistRow: vi.fn(),
  removeHostWatchlistRow: vi.fn(),
  putHostSelection: vi.fn(),
  importHostWatchlists: vi.fn(),
  subscribeTradingEvents: vi.fn((handlers: Record<string, () => void>) => {
    apiMock.handlers = handlers
    return () => { apiMock.handlers = {} }
  }),
  handlers: {} as Record<string, () => void>,
}))

vi.mock('../src/client/api.ts', () => apiMock)

const MAOTAI: Instrument = { market: 'cn', symbol: '600519', name: '贵州茅台' }
const PINGAN: Instrument = { market: 'cn', symbol: '000001', name: '平安银行' }

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.handlers = {}
  apiMock.fetchHostWatchlists.mockResolvedValue({})
  apiMock.fetchHostSelection.mockResolvedValue(null)
})

describe('wireHostWatchlistSync', () => {
  it('启动同步：host 有行 → 覆盖本地（host SSOT）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    apiMock.fetchHostWatchlists.mockResolvedValue({ cn: [{ market: 'cn', symbol: '000001', name: '平安银行' }] })
    wireHostWatchlistSync({ watchlists, selection })
    await vi.waitFor(() => { expect(watchlists.getSnapshot().cn).toHaveLength(1) })
    expect(watchlists.getSnapshot().cn?.[0]).toMatchObject({ symbol: '000001' })
  })

  it('迁移：host 空 + 本地有定制行 → 导入成功后重拉；host 非空拒绝则跳过', async () => {
    const watchlists = createWatchlistStore()
    watchlists.set({ cn: [MAOTAI] }) // 本地已定制镜像（localStorage 模拟）
    const selection = createSelectionStore()

    apiMock.fetchHostWatchlists.mockResolvedValueOnce({}) // 首查：host 空
    apiMock.importHostWatchlists.mockResolvedValue(true)
    apiMock.fetchHostWatchlists.mockResolvedValueOnce({ cn: [{ market: 'cn', symbol: '600519', name: '贵州茅台' }] }) // 导入后重拉

    wireHostWatchlistSync({ watchlists, selection })
    await vi.waitFor(() => { expect(apiMock.importHostWatchlists).toHaveBeenCalledTimes(1) })
    expect(apiMock.importHostWatchlists.mock.calls[0]?.[0]).toMatchObject({ cn: [{ symbol: '600519' }] })
  })

  it('迁移幂等：host 非空拒绝导入 → 不改本地（等待统一重拉）', async () => {
    const watchlists = createWatchlistStore()
    watchlists.set({ cn: [MAOTAI] })
    const selection = createSelectionStore()

    apiMock.fetchHostWatchlists.mockResolvedValueOnce({}) // 首查 host 空
    apiMock.importHostWatchlists.mockResolvedValue(false) // 服务端拒绝（竞态非空）

    wireHostWatchlistSync({ watchlists, selection })
    await vi.waitFor(() => { expect(apiMock.importHostWatchlists).toHaveBeenCalledTimes(1) })
    // 拒绝后本地镜像保持（后续由 SSE 统一重拉覆盖）
  })

  it('变更 host-first：add/remove/select 写 host 成功后才更新本地', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    apiMock.addHostWatchlistRow.mockResolvedValue(true)
    apiMock.removeHostWatchlistRow.mockResolvedValue(true)
    apiMock.putHostSelection.mockResolvedValue(true)

    wireHostWatchlistSync({ watchlists, selection })

    const cmb: Instrument = { market: 'cn', symbol: '600036', name: '招商银行' }
    watchlists.add('cn', cmb)
    await vi.waitFor(() => { expect(watchlists.getSnapshot().cn).toHaveLength(5) })
    expect(apiMock.addHostWatchlistRow).toHaveBeenCalledWith(cmb)

    watchlists.remove('cn', '600036')
    await vi.waitFor(() => { expect(watchlists.getSnapshot().cn).toHaveLength(4) })

    selection.select(MAOTAI)
    await vi.waitFor(() => { expect(selection.getSnapshot().instrument).toEqual(MAOTAI) })
    expect(apiMock.putHostSelection).toHaveBeenCalledWith(MAOTAI)
  })

  it('变更 host 失败 → 本地不变（fail-closed，SSOT 不劣化）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    apiMock.addHostWatchlistRow.mockResolvedValue(false)

    wireHostWatchlistSync({ watchlists, selection })
    watchlists.add('cn', MAOTAI)
    await vi.waitFor(() => { expect(apiMock.addHostWatchlistRow).toHaveBeenCalled() })
    expect(watchlists.getSnapshot().cn ?? []).toHaveLength(0)
  })

  it('SSE：watchlists/selection 信号 → 重拉覆盖（watchlist_select 工具驱动切图）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    wireHostWatchlistSync({ watchlists, selection })

    expect(apiMock.subscribeTradingEvents).toHaveBeenCalledTimes(1)
    apiMock.fetchHostWatchlists.mockResolvedValue({ cn: [{ market: 'cn', symbol: '000001', name: '平安银行' }] })
    apiMock.fetchHostSelection.mockResolvedValue({ market: 'cn', symbol: '000001', name: '平安银行' })
    apiMock.handlers['watchlists']?.()
    apiMock.handlers['selection']?.()
    await vi.waitFor(() => { expect(watchlists.getSnapshot().cn).toHaveLength(1) })
    await vi.waitFor(() => { expect(selection.getSnapshot().instrument).toMatchObject({ symbol: '000001' }) })
  })

  it('启动同步与 SSE：host 包含清空列表（空数组）时正确同步并保持已定制状态', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    // host 端已将 cn 清空为 []
    apiMock.fetchHostWatchlists.mockResolvedValue({ cn: [] })
    wireHostWatchlistSync({ watchlists, selection })

    await vi.waitFor(() => {
      const snap = watchlists.getSnapshot()
      expect(snap.cn).toBeDefined()
      expect(snap.cn).toEqual([])
    })
    expect(watchlists.isCustomized('cn')).toBe(true)
    expect(watchlists.listFor('cn')).toEqual([])

    // SSE 触发重拉同样保持
    apiMock.fetchHostWatchlists.mockResolvedValue({ cn: [{ market: 'cn', symbol: '000001', name: '平安银行' }] })
    apiMock.handlers['watchlists']?.()
    await vi.waitFor(() => {
      const snap = watchlists.getSnapshot()
      expect(snap.cn).toHaveLength(1)
    })
  })
})
