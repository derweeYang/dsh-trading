import { describe, expect, it } from 'vitest'
import {
  coveredModeOf,
  exchangeOf,
  groupedWatchlistStore,
  sortByExchangePriority,
  type WatchGroup,
} from '../src/client/watch-groups.ts'

const cn = (symbol: string, name?: string) => ({ market: 'cn' as const, symbol, ...(name ? { name } : {}) })

describe('exchangeOf / coveredModeOf', () => {
  it('maps the 7 ETF option underlyings to the correct exchange', () => {
    expect(exchangeOf('510050')).toBe('SH')
    expect(exchangeOf('588000')).toBe('SH')
    expect(exchangeOf('588080')).toBe('SH')
    expect(exchangeOf('159919')).toBe('SZ')
    expect(exchangeOf('159915')).toBe('SZ')
    expect(exchangeOf('159901')).toBe('SZ')
    expect(exchangeOf('159922')).toBe('SZ')
  })

  it('derives exchange for plain A-share codes', () => {
    expect(exchangeOf('600519')).toBe('SH')
    expect(exchangeOf('000858')).toBe('SZ')
    expect(exchangeOf('300750')).toBe('SZ')
  })

  it('Shenzhen is auto-cover, Shanghai is manual-cover (exchange-based)', () => {
    expect(coveredModeOf('159919')).toBe('auto')
    expect(coveredModeOf('510050')).toBe('manual')
    expect(coveredModeOf('000858')).toBe('auto') // 深市股票同样按交易所判自动备兑
    expect(coveredModeOf('AAPL')).toBeNull() // 非 A 股代码无交易所归属
  })
})

describe('sortByExchangePriority', () => {
  it('puts Shenzhen (auto-cover) first, then Shanghai, stable within exchange by code', () => {
    const rows = [
      cn('510050'), cn('159919'), cn('588080'), cn('159915'), cn('588000'),
    ]
    const sorted = sortByExchangePriority(rows).map(r => r.symbol)
    expect(sorted[0]).toBe('159915') // SZ first, smallest code
    expect(sorted[1]).toBe('159919') // SZ second
    expect(sorted[2]).toBe('510050') // SH after all SZ
    expect(sorted).toEqual(['159915', '159919', '510050', '588000', '588080'])
  })
})

describe('groupedWatchlistStore', () => {
  it('seeds option underlyings and curated pool; watch starts empty', () => {
    const groups = groupedWatchlistStore.getSnapshot()
    expect(groups.option.map(r => r.symbol)).toContain('510050')
    expect(groups.option.map(r => r.symbol)).toContain('159919')
    expect(groups.stockpool.length).toBeGreaterThan(0)
    expect(groups.watch).toEqual([])
  })

  it('add dedupes within a group and across groups via has()', () => {
    const group: WatchGroup = 'watch'
    const symbol = '601012' // 隆基绿能：不在任何种子分组，隔离本次用例
    const before = groupedWatchlistStore.listFor(group).length
    expect(groupedWatchlistStore.has(symbol)).toBe(false)
    expect(groupedWatchlistStore.add(group, cn(symbol))).toBe(true)
    expect(groupedWatchlistStore.add(group, cn(symbol))).toBe(false) // dup in-group
    expect(groupedWatchlistStore.has(symbol)).toBe(true)
    // cross-group add should be rejected (already tracked)
    expect(groupedWatchlistStore.add('stockpool', cn(symbol))).toBe(false)
    expect(groupedWatchlistStore.listFor(group).length).toBe(before + 1)
    expect(groupedWatchlistStore.remove(group, symbol)).toBe(true)
    expect(groupedWatchlistStore.has(symbol)).toBe(false)
  })
})
