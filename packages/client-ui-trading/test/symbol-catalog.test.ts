import { describe, expect, it } from 'vitest'
import {
  getMergedCatalog,
  searchAllMarkets,
  searchSymbols,
  setDynamicCatalog,
} from '../src/client/symbol-catalog.ts'

describe('symbol-catalog', () => {
  it('searches symbols by prefix from static catalog', () => {
    const maotai = searchSymbols('cn', '600519')
    expect(maotai.length).toBeGreaterThan(0)
    expect(maotai[0]?.symbol).toBe('600519.SH')
  })

  it('searches symbols by chinese name from static catalog', () => {
    const maotai = searchSymbols('cn', '茅台')
    expect(maotai.length).toBeGreaterThan(0)
    expect(maotai[0]?.symbol).toBe('600519.SH')

    const kc50 = searchSymbols('cn', '科创50')
    expect(kc50.length).toBeGreaterThan(0)
    expect(kc50[0]?.symbol).toBe('000688.SH')
    expect(kc50[0]?.name).toBe('科创50')

    const kc50Pinyin = searchSymbols('cn', 'KC50')
    expect(kc50Pinyin.length).toBeGreaterThan(0)
    expect(kc50Pinyin[0]?.symbol).toBe('000688.SH')

    const shIndex = searchSymbols('cn', '上证指数')
    expect(shIndex.length).toBeGreaterThan(0)
    expect(shIndex[0]?.symbol).toBe('000001.SH')
  })

  it('merges dynamic catalog and allows searching new symbols', () => {
    setDynamicCatalog('cn', [
      { symbol: '301999.SZ', name: '测试新股' },
      { symbol: '600519.SH', name: '茅台(动态覆盖尝试)' },
    ])
    const merged = getMergedCatalog('cn')
    const hasNewStock = merged.some(e => e.symbol === '301999.SZ')
    expect(hasNewStock).toBe(true)
    const maotai = merged.find(e => e.symbol === '600519.SH')
    expect(maotai?.name).toBe('贵州茅台')
    const results = searchSymbols('cn', '301999')
    expect(results.some(e => e.symbol === '301999.SZ')).toBe(true)
  })

  it('searchAllMarkets searches across all markets with market tag', () => {
    const results = searchAllMarkets('茅台')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.market).toBe('cn')
    expect(results[0]?.symbol).toBe('600519.SH')
  })

  it('empty query returns empty array', () => {
    expect(searchSymbols('cn', '')).toEqual([])
    expect(searchSymbols('cn', '   ')).toEqual([])
    expect(searchAllMarkets('')).toEqual([])
  })
})
