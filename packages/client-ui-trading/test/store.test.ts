/**
 * Client 纯逻辑单测：observable、自选 store（含种子回落与持久化）、
 * 行选择辅助。localStorage 用 vi.stubGlobal 假件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type StoreMap = Map<string, string>
const backing: StoreMap = new Map()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => { backing.set(key, value) },
  removeItem: (key: string) => { backing.delete(key) },
})

import {
  createObservable,
  createWatchlistStore,
  inferMarket,
  rowsFor,
  sameInstrument,
} from '../src/client/store.ts'

beforeEach(() => { backing.clear() })

describe('createObservable', () => {
  it('set/update 触发订阅，退订后不再触发', () => {
    const store = createObservable({ count: 0 })
    const seen: number[] = []
    const off = store.subscribe(() => { seen.push(store.getSnapshot().count) })
    store.set({ count: 1 })
    store.update(current => ({ count: current.count + 1 }))
    off()
    store.set({ count: 99 })
    expect(seen).toEqual([1, 2])
    expect(store.getSnapshot().count).toBe(99)
  })
})

describe('createWatchlistStore', () => {
  it('未定制 → 种子列表；add/remove 定制后持久化', () => {
    const store = createWatchlistStore()
    expect(store.isCustomized('cn')).toBe(false)
    expect(store.listFor('cn').map(row => row.symbol)).toContain('600519')

    store.add('cn', { market: 'cn', symbol: '600519', name: '贵州茅台' })
    expect(store.isCustomized('cn')).toBe(false)

    store.add('cn', { market: 'cn', symbol: '600036', name: '招商银行' })
    expect(store.isCustomized('cn')).toBe(true)
    expect(store.listFor('cn').some(row => row.symbol === '600036')).toBe(true)
    expect(store.listFor('cn').map(row => row.symbol)).toEqual(
      ['600519', '000001', '601318', '510050', '600036'],
    )

    store.add('cn', { market: 'cn', symbol: '600036', name: '招商银行' })
    expect(store.listFor('cn').filter(row => row.symbol === '600036')).toHaveLength(1)

    store.remove('cn', '600036')
    expect(store.listFor('cn').some(row => row.symbol === '600036')).toBe(false)
  })

  it('重载后从 localStorage 恢复（持久化契约）', () => {
    const first = createWatchlistStore()
    first.add('cn', { market: 'cn', symbol: '300750', name: '宁德时代' })
    const second = createWatchlistStore()
    expect(second.listFor('cn').some(row => row.symbol === '300750')).toBe(true)
  })

  it('未定制状态下直接 remove 种子标的：物化定制列表并持久化', () => {
    const store = createWatchlistStore()
    expect(store.isCustomized('cn')).toBe(false)
    expect(store.listFor('cn').map(row => row.symbol)).toContain('600519')

    // 未定制状态下直接删除 600519（贵州茅台）
    store.remove('cn', '600519')
    expect(store.isCustomized('cn')).toBe(true)
    expect(store.listFor('cn').map(row => row.symbol)).toEqual(['000001', '601318', '510050'])

    // 从 localStorage 恢复验证持久化
    const reloaded = createWatchlistStore()
    expect(reloaded.isCustomized('cn')).toBe(true)
    expect(reloaded.listFor('cn').map(row => row.symbol)).toEqual(['000001', '601318', '510050'])
  })

  it('删光自选标的后保持空列表，不复活种子', () => {
    const store = createWatchlistStore()
    // 按当前种子表逐行删光（CN 已含 510050；勿写死 symbol，避免再漏同步）。
    for (const row of store.listFor('cn')) {
      store.remove('cn', row.symbol)
    }

    expect(store.isCustomized('cn')).toBe(true)
    expect(store.listFor('cn')).toEqual([])
    expect(rowsFor(store.getSnapshot(), 'cn')).toEqual([])

    // 重载后依然保持空列表
    const reloaded = createWatchlistStore()
    expect(reloaded.isCustomized('cn')).toBe(true)
    expect(reloaded.listFor('cn')).toEqual([])
    expect(rowsFor(reloaded.getSnapshot(), 'cn')).toEqual([])
  })

  it('rowsFor：定制列表优先（含空数组），仅缺键回落种子', () => {
    expect(rowsFor({}, 'cn').map(row => row.symbol)).toContain('600519')
    expect(rowsFor({ cn: [] }, 'cn')).toEqual([])
    expect(rowsFor({ cn: [{ market: 'cn', symbol: '000001', name: '平安银行' }] }, 'cn'))
      .toEqual([{ market: 'cn', symbol: '000001', name: '平安银行' }])
  })

  it('sameInstrument：market+symbol 二元组判定', () => {
    expect(sameInstrument({ market: 'cn', symbol: '600519' }, { market: 'cn', symbol: '600519' })).toBe(true)
    expect(sameInstrument({ market: 'cn', symbol: '600519' }, { market: 'cn', symbol: '000001' })).toBe(false)
  })

  it('inferMarket：市场收敛后恒 cn（历史 crypto/us/hk 词汇一律归一）', () => {
    expect(inferMarket('600519.SH')).toBe('cn')
    expect(inferMarket('BTCUSDT')).toBe('cn')
    expect(inferMarket('AAPL')).toBe('cn')
    expect(inferMarket('00700')).toBe('cn')
    expect(inferMarket(undefined)).toBe('cn')
  })
})
