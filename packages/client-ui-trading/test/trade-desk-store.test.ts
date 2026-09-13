/**
 * trade-desk-store：交易台开关的懒单例读回、持久化（旧 '1'/'0' 格式兼容）与 toggle 通知契约。
 *
 * 注意：store 是模块级懒单例，本文件**首个** tradeDeskStore() 调用触发 readInitial——
 * 所以「旧值恢复」用例必须排在最前（vitest 同文件内按声明顺序串行执行）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toggleTradeDesk, tradeDeskStore, writeTradeDeskOpen } from '../src/client/trade-desk-store.ts'

const OPEN_KEY = 'dshtrading.tradeDesk.open'

/** 内存版 localStorage 假件（node 环境无该全局）。 */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  })
  return map
}

describe('tradeDeskStore', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('旧持久化值 "1" 恢复为展开（首读 localStorage，兼容 QuoteStage 时代格式）', () => {
    const storage = stubStorage({ [OPEN_KEY]: '1' })
    expect(tradeDeskStore().getSnapshot()).toBe(true)
    expect(storage.get(OPEN_KEY)).toBe('1')
  })

  it('writeTradeDeskOpen 落内存态 + 以 "1"/"0" 持久化', () => {
    const storage = stubStorage()
    writeTradeDeskOpen(false)
    expect(tradeDeskStore().getSnapshot()).toBe(false)
    expect(storage.get(OPEN_KEY)).toBe('0')
    writeTradeDeskOpen(true)
    expect(tradeDeskStore().getSnapshot()).toBe(true)
    expect(storage.get(OPEN_KEY)).toBe('1')
  })

  it('无 localStorage 时静默降级（不抛，内存态仍可切换）', () => {
    vi.unstubAllGlobals()
    expect(() => { writeTradeDeskOpen(true) }).not.toThrow()
    expect(tradeDeskStore().getSnapshot()).toBe(true)
    writeTradeDeskOpen(false)
    expect(tradeDeskStore().getSnapshot()).toBe(false)
  })

  it('toggle 取反并逐次通知订阅者', () => {
    stubStorage()
    writeTradeDeskOpen(false)
    const seen: boolean[] = []
    const unsubscribe = tradeDeskStore().subscribe(() => { seen.push(tradeDeskStore().getSnapshot()) })
    toggleTradeDesk()
    toggleTradeDesk()
    unsubscribe()
    toggleTradeDesk()
    expect(seen).toEqual([true, false])
  })
})
