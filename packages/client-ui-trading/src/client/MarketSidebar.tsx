/**
 * 富途式市场/自选面板（内容组件，由 MarketDock 停靠在左缘）：
 * 顶部标题 + 折叠按钮 + 添加表单（含分组选择）→ 三段式分组自选列表
 * （期权标的 / 股票池·精选 / 自选）→ 底部设置入口。
 *
 * 2026-09-12 改造（分组自选）：
 * - 左栏按「期权标的 / 股票池·精选 / 自选」三个分组折叠展示，各组可独立增删标的；
 * - 每只 ETF/股票行标沪/深交易所标签，期权标的组额外标备兑模式
 *   （深圳=自动备兑、上海=手动备兑），深圳标的置顶优先；
 * - 分组维度完全前端承载（watch-groups.ts 独立 localStorage），符号仍镜像进
 *   host `cn` 自选（addInstrument/removeInstrument）保证 Agent 可见；
 * - 行情批量轮询、页面隐藏时暂停；迷你走势 + 最新价 + 涨跌幅（红涨绿跌）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchKlines, fetchSymbols, fetchTickers } from './api.ts'
import { searchAllMarkets, setDynamicCatalog, updateDynamicCatalog } from './symbol-catalog.ts'
import type { MarketLocaleKey } from './contract.ts'
import { changePercent, directionColor, fmtPercent, fmtPrice } from './format.ts'
import { colorModeStore } from './color-mode.ts'
import { Sparkline } from './Sparkline.tsx'
import { IconChevronDown, IconFoldPanel, IconSettings } from './icons.tsx'
import type { MarketId, Instrument, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import css from './market-sidebar.module.css'
import {
  allGroupedInstruments,
  coveredModeOf,
  exchangeOf,
  groupedWatchlistStore,
  sortByExchangePriority,
  type WatchGroup,
  WATCH_GROUP_ORDER,
} from './watch-groups.ts'

export function rowKey(market: string, symbol: string): string {
  return `${market}:${symbol}`
}

/** Registration-side business face. */
export interface MarketSidebarInjected {
  hooks: {
    selection: import('./store.ts').Observable<import('./store.ts').SelectionState>
    watchlists: import('./store.ts').Observable<import('./store.ts').Watchlists>
  }
  /** 写路径：加入 host `cn` 自选（镜像，保证 Agent watchlist_list 可见）。 */
  addInstrument(market: MarketId, instrument: Instrument): void
  /** 写路径：移除 host `cn` 自选。 */
  removeInstrument(market: MarketId, symbol: string): void
  /** 写路径：选中标的（中栏 QuotePane 消费）。 */
  selectInstrument(instrument: Instrument): void
  /** 打开官方设置弹层（MarketDock 注入转发）。 */
  openSettings(): void
}

export type MarketSidebarProps =
  PropsLocale<'dshtrading.market'>
  & InjectFace<MarketSidebarInjected>
  & { onFold?: () => void; updateAvailable?: boolean }

const SERIES_TTL_MS = 10 * 60 * 1000
const PRICE_POLL_MS = 8000
const SPARK_INTERVAL = '1d'
const SPARK_LIMIT = 32

const GROUP_TITLE: Record<WatchGroup, MarketLocaleKey> = {
  option: 'group.option',
  stockpool: 'group.stockpool',
  watch: 'group.watch',
}

export function MarketSidebar({
  t, useSelection, addInstrument, removeInstrument, selectInstrument, onFold, openSettings, updateAvailable,
}: MarketSidebarProps) {
  const selection = useSelection(value => value.instrument)
  const groups = useSyncExternalStore(groupedWatchlistStore.subscribe, groupedWatchlistStore.getSnapshot)
  const [addGroup, setAddGroup] = useState<WatchGroup>('watch')
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState<Set<WatchGroup>>(() => new Set())
  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)

  const allRows = useMemo(() => allGroupedInstruments(groups), [groups])
  const rowsKey = allRows.map(row => rowKey(row.market, row.symbol)).join('|')

  const [prices, setPrices] = useState<Record<string, Ticker>>({})
  const [series, setSeries] = useState<Record<string, import('./types.ts').ReferenceSeries>>({})
  const [catalogVersion, setCatalogVersion] = useState(0)

  // 动态标的全集预取（切到本面板时触发，注入 catalog 供联想）。
  useEffect(() => {
    let cancelled = false
    fetchSymbols('cn')
      .then((symbols) => {
        if (cancelled || symbols.length === 0) return
        setDynamicCatalog('cn', symbols)
        setCatalogVersion((v) => v + 1)
      })
      .catch(() => { /* 桥不可用/无全集静默回退纯静态 */ })
    return () => { cancelled = true }
  }, [])

  // 联想候选：跨市场全局搜索（候选自带市场）。
  const suggestions = useMemo(
    () => searchAllMarkets(draft),
    [draft, catalogVersion],
  )

  // 真实在线联想：用户输入时防抖向上游检索标的，注入动态字典。
  useEffect(() => {
    const raw = draft.trim()
    if (raw.length < 1) return
    let cancelled = false
    const timer = setTimeout(() => {
      fetchSymbols('cn', raw)
        .then((items) => {
          if (cancelled || items.length === 0) return
          const valid = items.filter(it => it.symbol && it.name && !/\(A股\)|\(港股\)/.test(it.name)) // i18n-allow: regex matches exchange suffix in instrument names (A股/港股)
          if (valid.length > 0) {
            updateDynamicCatalog('cn', valid)
            setCatalogVersion(v => v + 1)
          }
        })
        .catch(() => {})
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draft])

  // 参考序列（日K收盘 → 迷你走势 + 昨收）：逐标的惰性拉一次，TTL 内复用。
  useEffect(() => {
    if (allRows.length === 0) return
    let cancelled = false
    const now = Date.now()
    for (const row of allRows) {
      const key = rowKey(row.market, row.symbol)
      const cached = series[key]
      if (cached !== undefined && now - cached.fetchedAt < SERIES_TTL_MS) continue
      fetchKlines(row.market, row.symbol, SPARK_INTERVAL, SPARK_LIMIT)
        .then((klines) => {
          if (cancelled) return
          setSeries((current) => ({
            ...current,
            [key]: {
              closes: klines.map(candle => candle.close),
              prevClose: klines.length >= 2 ? klines[klines.length - 2]?.close : undefined,
              fetchedAt: Date.now(),
            },
          }))
        })
        .catch(() => { /* 序列失败不影响报价行 */ })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey])

  // 最新价批量轮询：按市场分组，每市场每拍一次请求。
  usePoll(async () => {
    if (allRows.length === 0) return
    const byMarket = new Map<MarketId, string[]>()
    for (const row of allRows) {
      const list = byMarket.get(row.market) ?? []
      list.push(row.symbol)
      byMarket.set(row.market, list)
    }
    const next: Record<string, Ticker> = {}
    await Promise.all([...byMarket.entries()].map(async ([market, symbols]) => {
      try {
        const outcome = await fetchTickers(market, symbols)
        for (const [symbol, result] of Object.entries(outcome)) {
          if (result.ok) next[rowKey(market, symbol)] = result.ticker
        }
      } catch { /* 桥暂不可用，下轮再试 */ }
    }))
    if (Object.keys(next).length > 0) setPrices(current => ({ ...current, ...next }))
  }, PRICE_POLL_MS, [rowsKey])

  const resolveDraft = (): Instrument | null => {
    const rawDraft = draft.trim()
    if (rawDraft === '') return null
    const raw = rawDraft.toUpperCase()
    const match = suggestions.find(s =>
      s.symbol.toUpperCase() === raw ||
      (s.name && s.name.toUpperCase() === raw)
    ) ?? suggestions.find(s =>
      s.symbol.toUpperCase().startsWith(raw) ||
      (s.name && s.name.toUpperCase().startsWith(raw))
    ) ?? (suggestions.length > 0 ? suggestions[0] : undefined)

    let symbol: string
    let name: string | undefined
    if (match) {
      symbol = match.symbol
      name = match.name
    } else {
      if (/[\u4e00-\u9fa5]/.test(rawDraft)) return null
      if (/^\d{6}$/.test(raw)) {
        const isSh = raw.startsWith('6') || raw.startsWith('9') || raw.startsWith('5')
        symbol = `${raw}.${isSh ? 'SH' : 'SZ'}`
      } else {
        symbol = raw
      }
    }
    return { market: 'cn', symbol, ...(name ? { name } : {}) }
  }

  const submitAdd = (): void => {
    const item = resolveDraft()
    if (item === null) return
    if (groupedWatchlistStore.has(item.symbol)) {
      setDraft('')
      return
    }
    groupedWatchlistStore.add(addGroup, item)
    addInstrument('cn', item) // 镜像进 host 自选（Agent 可见）
    selectInstrument(item)
    setDraft('')
  }

  const toggleCollapse = (group: WatchGroup): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group); else next.add(group)
      return next
    })
  }

  return (
    <div className={css.root} data-dshtrading-market-sidebar="">
      <div className={css.topBar}>
        <div className={css.titleGroup} title={t('tab.watch')}>
          <span>{t('tab.watch')}</span>
          <IconChevronDown size={12} />
        </div>
        {onFold !== undefined && (
          <button type="button" className={css.foldBtn} aria-label={t('sidebar.fold')} title={t('sidebar.fold')} onClick={onFold}>
            <IconFoldPanel size={15} />
          </button>
        )}
      </div>

      {/* 添加标的表单（含分组选择） */}
      <form className={css.addRow} onSubmit={(event) => { event.preventDefault(); submitAdd() }}>
        <select
          className={css.addGroupSelect}
          value={addGroup}
          title={t('sidebar.addGroup')}
          onChange={event => { setAddGroup(event.target.value as WatchGroup) }}
        >
          {WATCH_GROUP_ORDER.map(g => (
            <option key={g} value={g}>{t(GROUP_TITLE[g])}</option>
          ))}
        </select>
        <input
          className={css.addInput}
          value={draft}
          placeholder={t('sidebar.addPlaceholder')}
          onChange={event => { setDraft(event.target.value) }}
        />
        <button className={css.addButton} type="submit" disabled={draft.trim() === ''}>{t('sidebar.add')}</button>
        {suggestions.length > 0 && (
          <div className={css.suggestions} role="listbox" aria-label={t('sidebar.addPlaceholder')}>
            {suggestions.map(entry => (
              <button
                key={entry.market + ':' + entry.symbol}
                type="button"
                role="option"
                aria-selected="true"
                className={css.suggestion}
                onMouseDown={(e) => { e.preventDefault() }}
                onClick={() => {
                  const item: Instrument = { market: entry.market, symbol: entry.symbol, name: entry.name }
                  if (!groupedWatchlistStore.has(item.symbol)) {
                    groupedWatchlistStore.add(addGroup, item)
                    addInstrument('cn', item)
                  }
                  selectInstrument(item)
                  setDraft('')
                }}
              >
                <span className={css.suggestionSymbol}>{entry.symbol}</span>
                <span className={css.suggestionName}>{entry.name}</span>
                <span className={css.suggestionMarket}>{t('tab.cn')}</span>
              </button>
            ))}
          </div>
        )}
      </form>

      {/* 表头 */}
      <div className={css.listHeader}>
        <span>{t('header.symbol')}</span>
        <span className={css.listHeaderColCenter}>{t('header.trend')}</span>
        <span className={css.listHeaderColRight}>{t('header.priceChange')}</span>
      </div>

      {/* 分组自选列表 */}
      <div className={css.groups}>
        {WATCH_GROUP_ORDER.map(group => {
          const raw = groups[group]
          const rows = group === 'option' ? sortByExchangePriority(raw) : raw
          const isCollapsed = collapsed.has(group)
          const count = raw.length
          return (
            <section key={group} className={css.group} data-group={group}>
              <button
                type="button"
                className={css.groupHeader}
                aria-expanded={!isCollapsed}
                onClick={() => { toggleCollapse(group) }}
              >
                <span className={isCollapsed ? css.groupChevronCollapsed : undefined}>
                  <IconChevronDown size={12} />
                </span>
                <span className={css.groupTitle}>{t(GROUP_TITLE[group])}</span>
                <span className={css.groupCount}>{count}</span>
                {group === 'option' && <span className={css.groupHint}>{t('group.optionHint')}</span>}
              </button>
              {!isCollapsed && (
                count === 0
                  ? (
                    <div className={css.groupEmpty}>{t('sidebar.empty')}</div>
                  )
                  : (
                    <div className={css.list} role="listbox" aria-label={t(GROUP_TITLE[group])}>
                      {rows.map((row) => {
                        const key = rowKey(row.market, row.symbol)
                        const ticker = prices[key]
                        const ref = series[key]
                        const price = ticker?.price
                        const pct = changePercent(price, ticker?.prevClose ?? ref?.prevClose)
                        const up = (pct ?? 0) >= 0
                        const selected = selection !== null && selection.market === row.market && selection.symbol === row.symbol
                        const exchange = exchangeOf(row.symbol)
                        const covered = group === 'option' ? coveredModeOf(row.symbol) : null
                        return (
                          <button
                            key={key}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={css.row}
                            data-selected={selected ? 'true' : undefined}
                            title={t('row.select')}
                            onClick={() => { selectInstrument(row) }}
                          >
                            <span className={css.idents}>
                              <span className={css.name}>
                                {(() => {
                                  const rowRaw = row.name
                                  const isPlaceholder = !rowRaw || rowRaw === row.symbol || /\(A股\)|\(港股\)/.test(rowRaw) // i18n-allow: regex matches exchange suffix in instrument names (A股/港股)
                                  const tickName = (ticker as { name?: string })?.name
                                  return !isPlaceholder ? rowRaw : (tickName || rowRaw || row.symbol)
                                })()}
                              </span>
                              <span className={css.codeRow}>
                                <span className={css.code}>{row.symbol}</span>
                                {exchange !== null && (
                                  <span className={exchange === 'SZ' ? css.exTagSz : css.exTagSh}>
                                    {t(exchange === 'SZ' ? 'exchange.sz' : 'exchange.sh')}
                                  </span>
                                )}
                                {covered !== null && (
                                  <span className={covered === 'auto' ? css.coveredAuto : css.coveredManual}>
                                    {t(covered === 'auto' ? 'covered.auto' : 'covered.manual')}
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className={css.spark}>
                              <Sparkline values={ref?.closes ?? []} width={56} height={22} up={up} colorMode={colorMode} />
                            </span>
                            <span className={css.quote}>
                              <span className={css.price} style={{ color: directionColor(pct ?? 0, colorMode) }}>{fmtPrice(price)}</span>
                              <span className={css.pct} style={{ color: directionColor(pct ?? 0, colorMode) }}>{fmtPercent(pct)}</span>
                            </span>
                            <span
                              role="button"
                              aria-label={t('row.remove')}
                              className={css.remove}
                              onClick={(event) => {
                                event.stopPropagation()
                                groupedWatchlistStore.remove(group, row.symbol)
                                removeInstrument('cn', row.symbol)
                              }}
                            >
                              ✕
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )
              )}
            </section>
          )
        })}
      </div>

      {/* 底部设置入口 */}
      <div className={css.footBar}>
        <button type="button" className={css.settingsBtn} aria-label={t('entry.settings')} title={t('entry.settings')} onClick={() => { openSettings() }}>
          <IconSettings size={15} />
          <span>{t('entry.settings')}</span>
          {updateAvailable === true && <span className={css.badgeDot} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
