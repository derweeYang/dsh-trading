/**
 * 分组自选存储（前端-only，独立 localStorage，不触碰 host watchlist 契约）。
 *
 * 背景（2026-09-12 领航员需求）：左侧自选栏需明确区分各 ETF 期权标的的
 * 沪/深归属——备兑流程不同（深圳=自动备兑，上海=手动备兑），深圳优先推进；
 * 同时在自选栏内新增「期权标的栏」「股票池·精选」两个分组，并允许各组增删标的。
 *
 * 为何不放 host `WatchlistsMap`（packages/watchlist，backend 包）：
 * `wireHostWatchlistSync.toLocalWatchlists` 会剥离 instrument 的额外字段，且
 * `boot()` 启动时会用 host 行整体覆盖本地 observable——分组维度无法在 host 契约上
 * 可靠存活。故分组完全前端承载，自用一个 localStorage 键；符号仍镜像进 host `cn`
 * 自选（经 MarketSidebar 注入的 addInstrument/removeInstrument），保证 Agent 的
 * watchlist_list 工具可见。
 *
 * 词汇纪律：symbol 用 6 位纯数字（市场收敛后恒 cn；沪/深由前缀推导，见 exchangeOf）。
 *
 * i18n-allow: 本文件内置默认分组的标的显示名（华夏上证50ETF 等）是**数据**，随名册
 *   一起落库/展示，非 UI 文案；界面文案一律走 dshtrading.market 词典。
 */
import type { Instrument, MarketId } from './types.ts'
import { createObservable, readJson, writeJson, type Observable } from './store.ts'

/** 三个分组（顺序即左栏展示顺序）。 */
export type WatchGroup = 'option' | 'stockpool' | 'watch'

export const WATCH_GROUP_ORDER: WatchGroup[] = ['option', 'stockpool', 'watch']

export type GroupedWatchlists = Record<WatchGroup, Instrument[]>

/** 交易所归属。 */
export type Exchange = 'SH' | 'SZ'

/** 备兑模式：深圳自动备兑、上海手动备兑（领航员 2026-09-12 定）。 */
export type CoveredMode = 'auto' | 'manual'

const GROUP_KEY = 'dshtrading.watchgroups.v1'

/** 沪市前缀集合（与 MarketSidebar 既有 KNOWN_SH_INDICES 推导口径一致）。 */
const SH_PREFIX = /^[569]/
const SZ_PREFIX = /^[013]/
const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

/**
 * 由 6 位 symbol 推导交易所（沪/深）。返回 null 表示无法判定（非 A 股代码形态）。
 * 与 MarketSidebar 既有逻辑一致：5/6/9 开头或沪深指数代码 = 沪；0/1/3 开头 = 深。
 */
export function exchangeOf(symbol: string): Exchange | null {
  const bare = symbol.replace(/\.[A-Z]{2}$/, '')
  if (KNOWN_SH_INDICES.has(bare)) return 'SH'
  const head = bare.charAt(0)
  if (SH_PREFIX.test(head)) return 'SH'
  if (SZ_PREFIX.test(head)) return 'SZ'
  return null
}

/** 备兑模式：深圳自动、上海手动。 */
export function coveredModeOf(symbol: string): CoveredMode | null {
  const ex = exchangeOf(symbol)
  if (ex === 'SZ') return 'auto'
  if (ex === 'SH') return 'manual'
  return null
}

/** 7 只 ETF 期权标的名册（与 packages/connector-options/src/rest.ts 的 IQUANT_UNDERLYINGS 对齐；2026-09-13 起 510300/510500 下架）。 */
export interface OptionUnderlyingSeed {
  symbol: string
  name: string
  exchange: Exchange
}

export const OPTION_UNDERLYINGS: OptionUnderlyingSeed[] = [
  // 上海（SSE，手动备兑）
  { symbol: '510050', name: '华夏上证50ETF', exchange: 'SH' },
  { symbol: '588000', name: '华夏科创50ETF', exchange: 'SH' },
  { symbol: '588080', name: '易方达科创50ETF', exchange: 'SH' },
  // 深圳（SZSE，自动备兑）—— 优先推进
  { symbol: '159919', name: '嘉实沪深300ETF', exchange: 'SZ' },
  { symbol: '159915', name: '创业板ETF易方达', exchange: 'SZ' },
  { symbol: '159901', name: '深证100ETF易方达', exchange: 'SZ' },
  { symbol: '159922', name: '嘉实中证500ETF', exchange: 'SZ' },
]

/** 精选股票池种子（蓝筹 + 成长，覆盖沪/深，演示交易所标签）。 */
export const STOCK_POOL_SEED: Instrument[] = [
  { market: 'cn', symbol: '600519', name: '贵州茅台' },
  { market: 'cn', symbol: '601318', name: '中国平安' },
  { market: 'cn', symbol: '600036', name: '招商银行' },
  { market: 'cn', symbol: '300750', name: '宁德时代' },
  { market: 'cn', symbol: '000858', name: '五粮液' },
  { market: 'cn', symbol: '002594', name: '比亚迪' },
]

function seedGroups(): GroupedWatchlists {
  const optionRows: Instrument[] = OPTION_UNDERLYINGS.map(u => ({
    market: 'cn' as MarketId,
    symbol: u.symbol,
    name: u.name,
  }))
  return {
    option: optionRows,
    stockpool: STOCK_POOL_SEED.map(r => ({ ...r })),
    watch: [],
  }
}

/** 深圳优先排序（备兑自动，领航员优先推进），同交易所内按代码升序。 */
export function sortByExchangePriority(rows: Instrument[]): Instrument[] {
  return [...rows].sort((a, b) => {
    const ea = exchangeOf(a.symbol)
    const eb = exchangeOf(b.symbol)
    const za = ea === 'SZ' ? 0 : 1
    const zb = eb === 'SZ' ? 0 : 1
    if (za !== zb) return za - zb
    return a.symbol.localeCompare(b.symbol)
  })
}

function sanitizeGroups(raw: unknown): GroupedWatchlists | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const out: GroupedWatchlists = { option: [], stockpool: [], watch: [] }
  for (const key of WATCH_GROUP_ORDER) {
    const rows = obj[key]
    if (!Array.isArray(rows)) continue
    out[key] = rows
      .filter((r): r is Instrument => Boolean(r && typeof r.symbol === 'string' && r.symbol))
      .map(r => ({
        market: 'cn' as MarketId,
        symbol: r.symbol,
        ...(typeof r.name === 'string' && r.name ? { name: r.name } : {}),
      }))
  }
  return out
}

export interface GroupedWatchlistStore extends Observable<GroupedWatchlists> {
  listFor(group: WatchGroup): Instrument[]
  /** 跨组查重：该 symbol 是否已存在于任一分组。 */
  has(symbol: string): boolean
  /** 增：组内按 symbol 去重；返回是否新增。 */
  add(group: WatchGroup, instrument: Instrument): boolean
  /** 删：仅删指定组内的该行；返回是否删除。 */
  remove(group: WatchGroup, symbol: string): boolean
}

export function createGroupedWatchlistStore(): GroupedWatchlistStore {
  const initial = sanitizeGroups(readJson<unknown>(GROUP_KEY, null)) ?? seedGroups()
  const store = createObservable<GroupedWatchlists>(initial)
  const persist = (): void => { writeJson(GROUP_KEY, store.getSnapshot()) }

  return {
    ...store,
    listFor(group) {
      return store.getSnapshot()[group]
    },
    has(symbol) {
      const all = store.getSnapshot()
      return WATCH_GROUP_ORDER.some(g => all[g].some(r => r.symbol === symbol))
    },
    add(group, instrument) {
      const target: Instrument = {
        market: 'cn' as MarketId,
        symbol: instrument.symbol,
        ...(instrument.name ? { name: instrument.name } : {}),
      }
      let added = false
      store.update((current) => {
        const rows = current[group]
        if (rows.some(r => r.symbol === target.symbol)) return current
        // 跨组去重：同一 symbol 只允许存在于一个分组（左栏按组增删，避免重复展示）。
        if (WATCH_GROUP_ORDER.some(g => g !== group && current[g].some(r => r.symbol === target.symbol))) return current
        added = true
        return { ...current, [group]: [...rows, target] }
      })
      if (added) persist()
      return added
    },
    remove(group, symbol) {
      let removed = false
      store.update((current) => {
        const rows = current[group]
        const next = rows.filter(r => r.symbol !== symbol)
        if (next.length === rows.length) return current
        removed = true
        return { ...current, [group]: next }
      })
      if (removed) persist()
      return removed
    },
  }
}

/** 单例（左栏与增删共享同一份前端存储）。 */
export const groupedWatchlistStore = createGroupedWatchlistStore()

/** 扁平化所有分组的标的（行情轮询 / 联想去重用）。 */
export function allGroupedInstruments(groups: GroupedWatchlists): Instrument[] {
  return WATCH_GROUP_ORDER.flatMap(g => groups[g])
}
