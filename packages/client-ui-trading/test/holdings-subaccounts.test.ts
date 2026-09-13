/**
 * 子账户汇总单测（2026-09-14）：总资产 = Σ 每个子账户。
 *
 * 这里守的不是算术（加法不会错），而是**口径边界**——期权账本是「含现金的权益」、
 * 股票侧是「持仓市值」，两者不同质却被加进同一个「总资产」：
 * - 缺 CNY 汇率时，期权账本必须进未折算分区而**不能**被当成 0 元加进合计
 *   （「没拿到汇率」与「账户没钱」是两回事，后者才会让总资产变小）；
 * - 账本还没取到（`optionBooks` 为空）时，总资产只反映股票侧，且
 *   `hasOptionAccounts=false` 让 UI 知道「期权还没进来」而不是「期权是 0」；
 * - 桥只回一个账本时按回的算，不补桩出第二个。
 */
import { describe, expect, it } from 'vitest'
import type { OptionPaperBookWire } from '@dshtrading/api'
import { aggregateHoldings } from '../src/client/holdings-aggregate.ts'
import { aggregateSubAccounts } from '../src/client/holdings-subaccounts.ts'
import type { FxSnapshot, TaggedPosition } from '../src/client/holdings-types.ts'

function pos(
  overrides: Partial<TaggedPosition> & Pick<TaggedPosition, 'symbol' | 'size' | 'origin' | 'account' | 'market'>,
): TaggedPosition {
  return { side: 'long', kind: 'real', timestamp: 1, ...overrides }
}

const FX_CNY: FxSnapshot = { base: 'CNY', rates: { CNY: 1, USD: 7.2 }, asOf: 1000, stale: false }
const FX_USD: FxSnapshot = { base: 'USD', rates: { USD: 1, CNY: 0.14 }, asOf: 1000, stale: false }
const FX_USD_NO_CNY: FxSnapshot = { base: 'USD', rates: { USD: 1 }, asOf: 1000, stale: false }

const STOCK_ROWS: TaggedPosition[] = [
  pos({ symbol: '510050', size: 100, origin: 'paper', account: '模拟账户', market: 'cn', entryPrice: 2.5, currency: 'CNY' }),
  pos({ symbol: '600519', size: 10, origin: 'live', account: '国信', market: 'cn', entryPrice: 1600, currency: 'CNY' }),
  pos({ symbol: 'AAPL', size: 5, origin: 'imported', account: '富途', market: 'cn', entryPrice: 180, currency: 'USD' }),
]

function book(id: 'strategy' | 'arbitrage', equity: number, positions = 0): OptionPaperBookWire {
  return {
    ok: true,
    book: id,
    account: {
      currency: 'CNY',
      initialCash: 100_000,
      cash: equity,
      realizedPnl: 0,
      updatedAt: '2026-09-14T02:00:00.000Z',
      id,
    },
    equity,
    positions: Array.from({ length: positions }, (_unused, i) => ({
      id: `${id}:p${i}`,
      underlying: '510050',
      template: 'vertical',
      openedBucketStart: '2026-09-14T02:00:00.000Z',
      invalidIf: '',
      qty: 1,
      marginCny: 0,
      legs: [],
      book: id,
      expiryMonth: '2609',
      expiryDate: '2026-09-23',
    })),
  }
}

describe('aggregateSubAccounts —— 总资产 = Σ 子账户', () => {
  it('股票三源 + 期权双账本：逐行相加等于总资产（基准币 CNY 恒等）', () => {
    const holdings = aggregateHoldings(STOCK_ROWS, { 'cn:510050': 3, 'cn:600519': 1700, 'cn:AAPL': 200 }, FX_CNY)
    const merged = aggregateSubAccounts(holdings, [book('arbitrage', 100_000), book('strategy', 105_000)], FX_CNY)

    expect(merged.rows.map(r => r.id)).toEqual(['stock:paper', 'stock:live', 'stock:imported', 'option:arbitrage', 'option:strategy'])
    const summed = merged.rows.reduce((sum, r) => sum + r.amountBase, 0)
    expect(merged.totalBase).toBe(summed)
    // 300（510050×100）+ 17000（600519×10）+ 1000（AAPL×5×200 折 USD→CNY 见下）
    expect(merged.totalBase).toBe(holdings.totalBase + 205_000)
    expect(merged.hasOptionAccounts).toBe(true)
    expect(merged.approximate).toBe(false)
    expect(merged.unconverted).toEqual([])
  })

  it('期权 equity 按汇率折算（CNY → USD）；basis 标为 equity（含现金）', () => {
    const holdings = aggregateHoldings(STOCK_ROWS, { 'cn:510050': 3, 'cn:600519': 1700, 'cn:AAPL': 200 }, FX_USD)
    const merged = aggregateSubAccounts(holdings, [book('strategy', 100_000)], FX_USD)
    const optionRow = merged.rows.find(r => r.id === 'option:strategy')
    expect(optionRow?.basis).toBe('equity')
    expect(optionRow?.kind).toBe('option')
    expect(optionRow?.amountBase).toBeCloseTo(100_000 * 0.14, 6)
    // 股票侧是持仓市值口径，不是权益口径
    expect(merged.rows.find(r => r.id === 'stock:paper')?.basis).toBe('holdings')
  })

  it('缺 CNY 汇率 → 期权进未折算分区、不计入总资产、标近似', () => {
    const holdings = aggregateHoldings(STOCK_ROWS, { 'cn:510050': 3, 'cn:600519': 1700, 'cn:AAPL': 200 }, FX_USD_NO_CNY)
    const merged = aggregateSubAccounts(holdings, [book('strategy', 100_000)], FX_USD_NO_CNY)
    const optionRow = merged.rows.find(r => r.id === 'option:strategy')

    expect(optionRow?.converted).toBe(false)
    expect(optionRow?.amountBase).toBe(0)
    // 该账本自己的未折算额是 10 万；跨子账户合并后与股票侧的 CNY 未折算相加
    // （510050/600519 都是 CNY 计价且在缺 CNY 汇率时同样未折算）。
    expect(optionRow?.unconverted).toEqual([{ currency: 'CNY', amount: 100_000 }])
    const stockUnconvertedCny = holdings.unconverted
      .filter(u => u.currency === 'CNY')
      .reduce((sum, u) => sum + u.amount, 0)
    expect(merged.unconverted).toEqual([{ currency: 'CNY', amount: stockUnconvertedCny + 100_000 }])
    // 关键：没拿到汇率 ≠ 账户没钱——总资产不得把期权当 0 吞掉，而是原样不计入
    expect(merged.totalBase).toBe(holdings.totalBase)
    expect(merged.approximate).toBe(true)
  })

  it('账本未取到（空集）→ 无期权行、hasOptionAccounts=false、总资产只反映股票侧', () => {
    const holdings = aggregateHoldings(STOCK_ROWS, { 'cn:510050': 3, 'cn:600519': 1700, 'cn:AAPL': 200 }, FX_CNY)
    const merged = aggregateSubAccounts(holdings, [], FX_CNY)
    expect(merged.rows.map(r => r.id)).toEqual(['stock:paper', 'stock:live', 'stock:imported'])
    expect(merged.hasOptionAccounts).toBe(false)
    expect(merged.totalBase).toBe(holdings.totalBase)
  })

  it('桥只回一个账本 → 按回的算，不补第二个桩', () => {
    const holdings = aggregateHoldings(STOCK_ROWS, { 'cn:510050': 3, 'cn:600519': 1700, 'cn:AAPL': 200 }, FX_CNY)
    const merged = aggregateSubAccounts(holdings, [book('strategy', 100_000, 2)], FX_CNY)
    const optionIds = merged.rows.filter(r => r.kind === 'option').map(r => r.id)
    expect(optionIds).toEqual(['option:strategy'])
    expect(merged.rows.find(r => r.id === 'option:strategy')?.count).toBe(2)
    expect(merged.hasOptionAccounts).toBe(true)
  })

  it('持仓为空的期权账本仍计入总资产（10 万现金就是资产）', () => {
    const merged = aggregateSubAccounts(aggregateHoldings([], {}, FX_CNY), [book('arbitrage', 100_000), book('strategy', 100_000)], FX_CNY)
    expect(merged.totalBase).toBe(200_000)
    expect(merged.rows.map(r => r.count)).toEqual([0, 0])
  })
})
