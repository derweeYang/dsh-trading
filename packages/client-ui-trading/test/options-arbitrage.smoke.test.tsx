/**
 * 套利机会表渲染冒烟（2026-09-13 WB-13；同日增强：分类显示 + 盈利>50 过滤 + 收益前10 + 点击看组合）。
 *
 * 拦住「构建/逻辑全绿、一渲染就崩」：把 OptionsArbitrageTable 真正 mount 进 jsdom，
 * 验证它能在浏览器内跑 scanArbitrage / scanVerticalSpreads 并正确分诊；并覆盖各增强点。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { OptionChain } from '@dshtrading/api'
import { OptionsArbitrageTable } from '../src/client/OptionsArbitrageTable.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

afterEach(() => {
  cleanup()
})

// 平价偏离链：spot=2.9，call 偏贵 → 内核应检出至少一行 parity 机会（无 bid/ask → 理论估算）。
const CHAIN: OptionChain = {
  underlying: '510050',
  expiryMonth: '2609',
  expiryDate: '2026-09-23',
  snapshotAt: '2026-09-08T02:00:00+08:00',
  source: 'akshare',
  spot: 2.9,
  calls: [
    { code: '510050C2609M02850', strike: 2.85, last: 0.12 },
    { code: '510050C2609M02900', strike: 2.90, last: 0.05 },
  ],
  puts: [
    { code: '510050P2609M02850', strike: 2.85, last: 0.02 },
    { code: '510050P2609M02900', strike: 2.90, last: 0.03 },
  ],
}

/**
 * 过滤测试专用链：制造一高一低两笔平价偏离 ——
 *  - K=3.00：合成远期 ≈ 现货远期 → 边际机会（收益 ≤ 50 元/张，默认应被隐藏）
 *  - K=3.05：call 明显偏贵 → 显著机会（收益 ≫ 50，默认应显示）
 */
const FILTER_CHAIN: OptionChain = {
  underlying: '510050',
  expiryMonth: '2609',
  expiryDate: '2026-09-10',
  snapshotAt: '2026-09-08T02:00:00+08:00',
  source: 'akshare',
  spot: 3.0,
  calls: [
    { code: '510050C2609M03000', strike: 3.00, last: 0.0305 },
    { code: '510050C2609M03050', strike: 3.05, last: 0.05 },
  ],
  puts: [
    { code: '510050P2609M03000', strike: 3.00, last: 0.03 },
    { code: '510050P2609M03050', strike: 3.05, last: 0.03 },
  ],
}

/** 12 档行权价、每档均生成一笔显著平价机会 → 用于「默认前 10 + 显示更多」断言。 */
const MANY_CHAIN: OptionChain = {
  underlying: '510050',
  expiryMonth: '2609',
  expiryDate: '2026-09-10',
  snapshotAt: '2026-09-08T02:00:00+08:00',
  source: 'akshare',
  spot: 3.0,
  calls: Array.from({ length: 12 }, (_, i) => ({ code: `C${i}`, strike: 3.0 + i * 0.01, last: 0.06 })),
  puts: Array.from({ length: 12 }, (_, i) => ({ code: `P${i}`, strike: 3.0 + i * 0.01, last: 0.03 })),
}

/** 套利行（带 data-edge），排除展开的组合明细行。 */
const arbRows = (c: HTMLElement): Element[] =>
  Array.from(c.querySelectorAll('[data-dshtrading-options-arbitrage] tr[data-edge]'))
const lowEdgeRows = (c: HTMLElement): Element[] =>
  arbRows(c).filter(r => Number(r.getAttribute('data-edge')) <= 50)

describe('OptionsArbitrageTable', () => {
  it('renders the arbitrage section with a title', () => {
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    expect(getByText('options.arbitrage.title')).toBeTruthy()
  })

  it('runs scanArbitrage in-browser and flags theoretical-only edges (no bid/ask)', () => {
    const { queryByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    expect(queryByText('options.arbitrage.theoryNote')).toBeTruthy()
  })

  it('shows the empty state when the chain lacks spot/expiry (scan returns [])', () => {
    const empty: OptionChain = { underlying: '510050', expiryMonth: '2609', source: 'akshare', calls: [], puts: [] }
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={empty} multiplier={10000} />)
    expect(getByText('options.arbitrage.none')).toBeTruthy()
  })

  it('toggles the directional vertical-spread section', () => {
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    fireEvent.click(getByText('options.arbitrage.showVertical'))
    expect(getByText('options.arbitrage.verticalTitle')).toBeTruthy()
    fireEvent.click(getByText('options.arbitrage.hideVertical'))
    expect(getByText('options.arbitrage.showVertical')).toBeTruthy()
  })

  it('groups opportunities by category (parity section has its own header)', () => {
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    expect(getByText('options.arbitrage.kind.parity')).toBeTruthy()
  })

  it('defaults to profit>50 only, and reveals the rest on demand', () => {
    const { container, getByText } = render(<OptionsArbitrageTable t={t} chain={FILTER_CHAIN} multiplier={10000} />)
    expect(arbRows(container).length).toBeGreaterThan(0)
    expect(lowEdgeRows(container).length).toBe(0)
    fireEvent.click(getByText('options.arbitrage.filter.showAll'))
    expect(lowEdgeRows(container).length).toBeGreaterThan(0)
    expect(getByText('options.arbitrage.filter.onlyProfitable')).toBeTruthy()
    fireEvent.click(getByText('options.arbitrage.filter.onlyProfitable'))
    expect(lowEdgeRows(container).length).toBe(0)
  })

  it('defaults to the top 10 by profit and reveals more on demand', () => {
    const { container } = render(<OptionsArbitrageTable t={t} chain={MANY_CHAIN} multiplier={10000} />)
    const parity = container.querySelector('[data-arb-group="parity"]') as HTMLElement
    expect(parity).toBeTruthy()
    const rows = (): NodeListOf<Element> => parity.querySelectorAll('tr[data-edge]')
    // 默认只显示前 10 条（共 12 条平价机会）。
    expect(rows().length).toBe(10)
    fireEvent.click(within(parity).getByText('options.arbitrage.showMore'))
    expect(rows().length).toBe(12)
  })

  it('expands a row to show the concrete leg combination (and collapses back)', () => {
    const { container } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    expect(container.querySelector('[data-arb-combo]')).toBeNull()
    const row = container.querySelector('tr[data-arb-row]') as HTMLElement
    expect(row).toBeTruthy()
    fireEvent.click(row)
    const combo = container.querySelector('[data-arb-combo]')
    expect(combo).toBeTruthy()
    const text = combo?.textContent ?? ''
    expect(text).toContain('options.arbitrage.combo.title')
    // 平价组合 = 两张期权腿（卖出 call / 买入 put）+ 现货腿。
    expect(text).toContain('options.arbitrage.leg.sell')
    expect(text).toContain('options.arbitrage.leg.buy')
    expect(text).toContain('options.arbitrage.leg.spotBuy')
    // 再次点击收起。
    fireEvent.click(row)
    expect(container.querySelector('[data-arb-combo]')).toBeNull()
  })
})
