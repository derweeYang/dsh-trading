/**
 * 套利机会表渲染冒烟（2026-09-13 WB-13；同日增强：分类显示 + 盈利>50 默认过滤）。
 *
 * 拦住「构建/逻辑全绿、一渲染就崩」：把 OptionsArbitrageTable 真正 mount 进 jsdom，
 * 验证它能在浏览器内跑 scanArbitrage / scanVerticalSpreads 并正确分诊
 * （有 spot+expiry → 检出机会；缺 spot/expiry → 空态；方向性表可展开）；
 * 并覆盖本次增强：按分类成组显示 + 默认只显示盈利>50、可展开全部。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
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
 *  - K=3.00：合成远期 ≈ 现货远期 → 边际机会（edge ≤ 50 元/张，默认应被隐藏）
 *  - K=3.05：call 明显偏贵 → 显著机会（edge ≫ 50，默认应显示）
 * 两笔均无 bid/ask → executable=false（理论估算）。
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

const arbRows = (c: HTMLElement): Element[] =>
  Array.from(c.querySelectorAll('[data-dshtrading-options-arbitrage] tbody tr'))
const lowEdgeRows = (c: HTMLElement): Element[] =>
  arbRows(c).filter(r => Number(r.getAttribute('data-edge')) <= 50)

describe('OptionsArbitrageTable', () => {
  it('renders the arbitrage section with a title', () => {
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    expect(getByText('options.arbitrage.title')).toBeTruthy()
  })

  it('runs scanArbitrage in-browser and flags theoretical-only edges (no bid/ask)', () => {
    const { queryByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    // 实时链无买卖盘 → executable=false → 理论估算提示必须出现。
    expect(queryByText('options.arbitrage.theoryNote')).toBeTruthy()
  })

  it('shows the empty state when the chain lacks spot/expiry (scan returns [])', () => {
    const empty: OptionChain = { underlying: '510050', expiryMonth: '2609', source: 'akshare', calls: [], puts: [] }
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={empty} multiplier={10000} />)
    expect(getByText('options.arbitrage.none')).toBeTruthy()
  })

  it('toggles the directional vertical-spread section', () => {
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    // 默认收起 → 显示展开按钮；点击后显示方向性表标题。
    const open = getByText('options.arbitrage.showVertical')
    fireEvent.click(open)
    expect(getByText('options.arbitrage.verticalTitle')).toBeTruthy()
    // 再次点击收起。
    fireEvent.click(getByText('options.arbitrage.hideVertical'))
    expect(getByText('options.arbitrage.showVertical')).toBeTruthy()
  })

  it('groups opportunities by category (parity section has its own header)', () => {
    const { getByText } = render(<OptionsArbitrageTable t={t} chain={CHAIN} multiplier={10000} />)
    // 分类显示：平价套利以独立小标题成组（kind 列已随分组移除，故该文案仅作分组标题出现）。
    expect(getByText('options.arbitrage.kind.parity')).toBeTruthy()
  })

  it('defaults to profit>50 only, and reveals the rest on demand', () => {
    const { container, getByText } = render(<OptionsArbitrageTable t={t} chain={FILTER_CHAIN} multiplier={10000} />)
    // 默认：有显著机会显示，但盈利≤50 的边际机会被隐藏。
    expect(arbRows(container).length).toBeGreaterThan(0)
    expect(lowEdgeRows(container).length).toBe(0)
    // 展开全部 → 边际机会出现，且按钮翻转为「仅显示盈利大于50」。
    fireEvent.click(getByText('options.arbitrage.filter.showAll'))
    expect(lowEdgeRows(container).length).toBeGreaterThan(0)
    expect(getByText('options.arbitrage.filter.onlyProfitable')).toBeTruthy()
    // 再点回去 → 边际机会重新隐藏。
    fireEvent.click(getByText('options.arbitrage.filter.onlyProfitable'))
    expect(lowEdgeRows(container).length).toBe(0)
  })
})
