/**
 * Client stores: a minimal observable engine (snapshot + subscribe, the
 * HostObservable face the slot renderer synthesizes use* hooks from) plus the
 * two trading-shell stores — instrument selection and per-market watchlists.
 *
 * Deliberately framework-free and dependency-free of SDK runtime code (no
 * @deepseek-ai/dsh-client-store import): these modules are unit-tested under
 * vitest, where seed-module resolution is unavailable. The only workspace
 * import is the watchlist seed table (@dshtrading/watchlist, pure data) —
 * bundled inline by the client build; Agent 工具同源（见 seeds.ts）。Both stores
 * persist to localStorage (durable across reloads; single-user local app — no
 * server sync by design).
 */
import type { Instrument, MarketId } from './types.ts'
import { WATCHLIST_SEEDS } from '@dshtrading/watchlist'

/** Minimal observable face — matches the slot kit's HostObservable contract. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface WritableObservable<T> extends Observable<T> {
  set(next: T): void
  update(mutator: (current: T) => T): void
}

export function createObservable<T>(initial: T): WritableObservable<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    update(mutator) {
      this.set(mutator(snapshot))
    },
  }
}

/** localStorage read that survives unavailable storage (privacy mode) and corrupt JSON. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** localStorage write that survives unavailable storage. */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — session-only degradation */
  }
}

// ---------------------------------------------------------------------------
// Instrument selection (shared by MarketSidebar → QuoteStage)
// ---------------------------------------------------------------------------

const SELECTION_KEY = 'dshtrading.selection.v1'

export interface SelectionState {
  instrument: Instrument | null
}

export type SelectionStore = WritableObservable<SelectionState> & {
  select(instrument: Instrument): void
}

/**
 * 市场恒为 cn（市场收敛后唯一市场）；签名保留 symbol 便于符号规范化扩展，
 * 现仅做防御性归一：历史 localStorage / 上游数据里的 crypto/us/hk 一律落 cn。
 */
export function inferMarket(symbol?: string): MarketId {
  void symbol
  return 'cn'
}

export function createSelectionStore(): SelectionStore {
  const raw = readJson<Instrument | null>(SELECTION_KEY, null)
  const initialInstrument: Instrument | null = raw && typeof raw.symbol === 'string' && raw.symbol
    ? {
        market: inferMarket(raw.symbol),
        symbol: raw.symbol,
        ...(raw.name ? { name: raw.name } : {}),
      }
    : null
  const store = createObservable<SelectionState>({
    instrument: initialInstrument,
  })
  return {
    ...store,
    select(instrument) {
      const sanitized: Instrument = {
        market: inferMarket(instrument.symbol),
        symbol: instrument.symbol,
        ...(instrument.name ? { name: instrument.name } : {}),
      }
      store.set({ instrument: sanitized })
      writeJson(SELECTION_KEY, sanitized)
    },
  }
}

/**
 * 模块级单例：行情中栏与各 StageView 共享同一选中标的。期权 T 板直达 tab
 * （OptionsStageMiddleView）需要跨视图读取当前标的，故把 selection 提升为单例，
 * index.ts 的 `selection` 变量直接复用本实例（inject 契约不变）。
 */
export const selectionStore: SelectionStore = createSelectionStore()

// ---------------------------------------------------------------------------
// Per-market watchlists (the "自选" concept; seeded with defaults when empty)
// ---------------------------------------------------------------------------

const WATCHLIST_KEY = 'dshtrading.watchlist.v1'

export type Watchlists = Partial<Record<MarketId, Instrument[]>>

export interface WatchlistStore extends WritableObservable<Watchlists> {
  /** List for one market: the user's rows, or the market's seed list when untouched. */
  listFor(market: MarketId): Instrument[]
  /** Whether the user has customized this market's list (else seeds show). */
  isCustomized(market: MarketId): boolean
  add(market: MarketId, instrument: Instrument): void
  remove(market: MarketId, symbol: string): void
}

export function sameInstrument(a: Instrument, b: Instrument): boolean {
  return a.market === b.market && a.symbol === b.symbol
}

function sanitizeWatchlists(raw: Watchlists): Watchlists {
  const clean: Watchlists = {}
  for (const [key, rows] of Object.entries(raw)) {
    // 市场收敛后唯一合法键 'cn'；localStorage 里遗留的 crypto/us/hk 键直接丢弃。
    if (key !== 'cn' || !Array.isArray(rows)) continue
    const market = key as MarketId
    clean[market] = rows
      .filter((row): row is Instrument => Boolean(row && typeof row.symbol === 'string' && row.symbol))
      .map(row => ({
        market,
        symbol: row.symbol,
        ...(row.name ? { name: row.name } : {}),
      }))
  }
  return clean
}

export function createWatchlistStore(): WatchlistStore {
  const store = createObservable<Watchlists>(sanitizeWatchlists(readJson<Watchlists>(WATCHLIST_KEY, {})))
  const persist = (): void => { writeJson(WATCHLIST_KEY, store.getSnapshot()) }
  return {
    ...store,
    listFor(market) {
      const rows = store.getSnapshot()[market]
      if (Array.isArray(rows)) return rows
      return DEFAULT_WATCHLISTS[market] ?? []
    },
    isCustomized(market) {
      const rows = store.getSnapshot()[market]
      return Array.isArray(rows)
    },
    add(market, instrument) {
      void market // 签名保留多市场形参；市场收敛后恒 cn（inferMarket 决定）
      const targetMarket = inferMarket(instrument.symbol)
      const sanitized: Instrument = {
        market: targetMarket,
        symbol: instrument.symbol,
        ...(instrument.name ? { name: instrument.name } : {}),
      }
      store.update((current) => {
        const existing = current[targetMarket]
        const rows = Array.isArray(existing) ? existing : (DEFAULT_WATCHLISTS[targetMarket] ?? [])
        if (rows.some(row => row.symbol === sanitized.symbol)) return current
        return { ...current, [targetMarket]: [...rows, sanitized] }
      })
      persist()
    },
    remove(market, symbol) {
      void market // 同 add：签名保留，目标市场恒 cn
      const targetMarket = inferMarket(symbol)
      store.update((current) => {
        const existing = current[targetMarket]
        const baseRows = Array.isArray(existing) ? existing : (DEFAULT_WATCHLISTS[targetMarket] ?? [])
        return { ...current, [targetMarket]: baseRows.filter(row => row.symbol !== symbol) }
      })
      persist()
    },
  }
}

/** Seed rows per market（SSOT 在 @dshtrading/watchlist：agent 的 watchlist_list
 * 合并视图与 GUI 左栏展示同源，2026-09-02 agent 可见性修复）。 */
export const DEFAULT_WATCHLISTS = WATCHLIST_SEEDS as unknown as Record<MarketId, Instrument[]>

/** 一个市场的展示行：用户列表（若已定制，包括空数组），未定制时回落种子列表。 */
export function rowsFor(watchlists: Watchlists, market: MarketId): Instrument[] {
  const rows = watchlists[market]
  if (Array.isArray(rows)) return rows
  return DEFAULT_WATCHLISTS[market] ?? []
}

/** Chart intervals offered per market (connector-supported subsets only).
 *  市场收敛后仅 cn（腾讯连接器支持的周期子集）。 */
export const MARKET_INTERVALS: Record<MarketId, string[]> = {
  cn: ['5m', '30m', '1d', '1w', '1M'],
}
