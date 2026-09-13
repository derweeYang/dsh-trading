/**
 * 套利机会表渲染冒烟（2026-09-13 WB-13）。
 *
 * 拦住「构建/逻辑全绿、一渲染就崩」：把 OptionsArbitrageTable 真正 mount 进 jsdom，
 * 验证它能在浏览器内跑 scanArbitrage / scanVerticalSpreads 并正确分诊
 * （有 spot+expiry → 检出机会；缺 spot/expiry → 空态；方向性表可展开）。
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
})
