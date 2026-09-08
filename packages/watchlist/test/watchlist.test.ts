/**
 * watchlist 包单测（离线）：内存/file store 往返、原子写无残留、4 工具链
 * （list/add 去重/remove/select 名称解析）、事件回调接线。
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '../src/index.ts'
import { WATCHLIST_SEEDS } from '../src/seeds.ts'
import { createFileSelectionStore, createFileWatchlistStore } from '../src/file-store.ts'
import {
  createWatchlistAddTool,
  createWatchlistListTool,
  createWatchlistRemoveTool,
  createWatchlistSelectTool,
  type WatchlistToolDeps,
} from '../src/plugin.ts'

function makeDeps() {
  const watchlists = createMemoryWatchlistStore()
  const selection = createMemorySelectionStore()
  const onWatchlistsChanged = vi.fn()
  const onSelectionChanged = vi.fn()
  const deps: WatchlistToolDeps = { watchlists, selection, onWatchlistsChanged, onSelectionChanged }
  return { deps, watchlists, selection, onWatchlistsChanged, onSelectionChanged }
}

describe('memory stores', () => {
  it('add 按 symbol 去重；remove 返回 existed；save 全量替换', async () => {
    const store = createMemoryWatchlistStore()
    expect(await store.add('cn', { market: 'cn', symbol: '600519', name: '贵州茅台' })).toBe(true)
    expect(await store.add('cn', { market: 'cn', symbol: '600519' })).toBe(false)
    expect(await store.add('cn', { market: 'cn', symbol: '000001', name: '平安银行' })).toBe(true)
    expect(await store.remove('cn', '600519')).toBe(true)
    expect(await store.remove('cn', '600519')).toBe(false)
    await store.save({ cn: [{ market: 'cn', symbol: '510050' }] })
    expect(await store.list()).toEqual({ cn: [{ market: 'cn', symbol: '510050' }] })
  })
})

describe('file stores（原子写）', () => {
  it('watchlist 往返 + 跨实例持久化 + 无 tmp 残留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    await store.add('cn', { market: 'cn', symbol: '600519', name: '贵州茅台' })
    const reread = createFileWatchlistStore(filePath)
    expect(await reread.list()).toEqual({ cn: [{ market: 'cn', symbol: '600519', name: '贵州茅台' }] })
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
  })

  it('selection 往返 + null 覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'selection.json')
    const store = createFileSelectionStore(filePath)
    await store.set({ instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' } })
    const reread = createFileSelectionStore(filePath)
    expect(await reread.get()).toEqual({ instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' } })
    await reread.set({ instrument: null })
    expect(await reread.get()).toEqual({ instrument: null })
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    expect(parsed).toEqual({ instrument: null })
  })
})

describe('watchlist_* tools', () => {
  it('watchlist_list：空库也回落种子行（合并视图，与 GUI 左栏一致），sources 标注来源', async () => {
    const { deps } = makeDeps()
    const tool = createWatchlistListTool(deps)
    const empty = JSON.parse(String(await tool.execute({}))) as {
      total: number
      markets: string[]
      sources: Record<string, 'custom' | 'seed'>
      watchlists: Record<string, Array<{ market: string; symbol: string; name?: string }>>
    }
    // 全空 host store → cn 市场回落种子展示行。
    expect(empty.markets).toEqual(['cn'])
    expect(empty.total).toBe(4)
    expect(Object.values(empty.sources).every(source => source === 'seed')).toBe(true)
    expect(empty.watchlists.cn[0]).toEqual({ market: 'cn', symbol: '600519', name: '贵州茅台' })

    await createWatchlistAddTool(deps).execute({ market: 'cn', symbol: '600519', name: '贵州茅台' })
    const wire = JSON.parse(String(await tool.execute({}))) as {
      total: number
      sources: Record<string, 'custom' | 'seed'>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    // 定制后该市场以用户行为准（不再混入种子），来源翻 custom；行内容不变。
    expect(wire.sources.cn).toBe('custom')
    expect(wire.watchlists.cn).toEqual([{ market: 'cn', symbol: '600519', name: '贵州茅台' }])
    // cn 1（定制后种子被抑制）。
    expect(wire.total).toBe(1)
  })

  it('watchlist_add：去重 + 事件回调仅在实际新增时触发', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const tool = createWatchlistAddTool(deps)
    const first = JSON.parse(String(await tool.execute({ market: 'cn', symbol: '600519' }))) as { added: boolean }
    expect(first.added).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
    const second = JSON.parse(String(await tool.execute({ market: 'cn', symbol: '600519' }))) as { added: boolean }
    expect(second.added).toBe(false)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
  })

  it('watchlist_add：缺 market → schema 层拒绝（required property）', async () => {
    const { deps } = makeDeps()
    await expect(createWatchlistAddTool(deps).execute({ symbol: '600519' })).rejects.toThrow(/missing required property/)
  })

  it('watchlist_remove：移除 + 事件回调', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    await createWatchlistAddTool(deps).execute({ market: 'cn', symbol: '600519' })
    onWatchlistsChanged.mockClear()
    const wire = JSON.parse(String(await createWatchlistRemoveTool(deps).execute({ market: 'cn', symbol: '600519' }))) as { removed: boolean }
    expect(wire.removed).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
  })

  it('watchlist_remove：未定制状态下可直接删除默认种子标的，剩余种子物化为 custom', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const removeTool = createWatchlistRemoveTool(deps)
    const listTool = createWatchlistListTool(deps)

    // 删除前：全部为 seed
    const before = JSON.parse(String(await listTool.execute({}))) as {
      sources: Record<string, string>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    expect(before.sources.cn).toBe('seed')
    expect(before.watchlists.cn.map(r => r.symbol)).toEqual(['600519', '000001', '601318', '510050'])

    // 空库未定制状态下，直接删除 600519
    const wire = JSON.parse(String(await removeTool.execute({ market: 'cn', symbol: '600519' }))) as { removed: boolean }
    expect(wire.removed).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)

    // 删除后：cn 变为 custom，剩余 3 行（000001, 601318, 510050）
    const after = JSON.parse(String(await listTool.execute({}))) as {
      sources: Record<string, string>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    expect(after.sources.cn).toBe('custom')
    expect(after.watchlists.cn.map(r => r.symbol)).toEqual(['000001', '601318', '510050'])

    // 删除不存在的 symbol：返回 removed: false
    const notFound = JSON.parse(String(await removeTool.execute({ market: 'cn', symbol: 'NONEXISTENT' }))) as { removed: boolean }
    expect(notFound.removed).toBe(false)
  })

  it('watchlist_remove：删光默认自选后保持空列表，不复活种子', async () => {
    const { deps } = makeDeps()
    const removeTool = createWatchlistRemoveTool(deps)
    const listTool = createWatchlistListTool(deps)

    // 按种子表逐行删光（与 client store 同构；加种子时本用例自动跟上）。
    for (const row of WATCHLIST_SEEDS.cn ?? []) {
      await removeTool.execute({ market: 'cn', symbol: row.symbol })
    }

    const list = JSON.parse(String(await listTool.execute({}))) as {
      sources: Record<string, string>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    expect(list.sources.cn).toBe('custom')
    expect(list.watchlists.cn).toEqual([])
  })

  it('watchlist_select：自选行名称复用；种子行同名解析；未知 symbol 以裸 symbol 兜底；触发 selection 事件', async () => {
    const { deps, selection, onSelectionChanged } = makeDeps()
    // 种子行（host store 无行且未定制）：合并视图解析出展示名（与 watchlist_list 一致）。
    // 先于任何 add 验证——定制后该市场种子回落被抑制，只剩 custom 行。
    const seeded = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'cn', symbol: '000001' }))) as { selected: { name?: string } }
    expect(seeded.selected).toEqual({ market: 'cn', symbol: '000001', name: '平安银行' })
    await createWatchlistAddTool(deps).execute({ market: 'cn', symbol: '600519', name: '贵州茅台' })
    const named = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'cn', symbol: '600519' }))) as { selected: { name?: string } }
    expect(named.selected.name).toBe('贵州茅台')
    const unknown = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'cn', symbol: '300999' }))) as { selected: { name?: string } }
    expect(unknown.selected).toEqual({ market: 'cn', symbol: '300999' })
    expect((await selection.get()).instrument).toEqual({ market: 'cn', symbol: '300999' })
    expect(onSelectionChanged).toHaveBeenCalledTimes(3)
  })
})

describe('file store 并发读改写（issue #58）', () => {
  it('并发 add 全部落盘不丢更新（RMW 全程入队串行化）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    const results = await Promise.all([
      store.add('cn', { market: 'cn', symbol: '600519' }),
      store.add('cn', { market: 'cn', symbol: '000001' }),
      store.add('cn', { market: 'cn', symbol: '601318' }),
      store.add('cn', { market: 'cn', symbol: '510050' }),
    ])
    expect(results).toEqual([true, true, true, true])
    // 新实例（空缓存）从盘上读：修复前最后一个 flush 用旧态整行覆盖，先写行丢失。
    const reread = createFileWatchlistStore(filePath)
    const list = await reread.list()
    expect(list.cn?.map(r => r.symbol).sort()).toEqual(['000001', '510050', '600519', '601318'])
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
  })

  it('并发 add 同一 symbol 仍按去重语义只落一行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    const results = await Promise.all([
      store.add('cn', { market: 'cn', symbol: '600519' }),
      store.add('cn', { market: 'cn', symbol: '600519' }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const list = await store.list()
    expect(list.cn).toHaveLength(1)
  })

  it('file store 空文件下直接 remove 默认种子标的持久化落盘，新实例可见定制', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)

    // 空文件下直接从 cn 删 600519
    const removed = await store.remove('cn', '600519')
    expect(removed).toBe(true)

    // 新实例重读：cn 应包含剩余 3 只标的
    const reread = createFileWatchlistStore(filePath)
    const list = await reread.list()
    expect(list.cn?.map(r => r.symbol)).toEqual(['000001', '601318', '510050'])
  })
})

