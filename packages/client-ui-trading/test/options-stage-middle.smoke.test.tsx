/**
 * OptionsStageMiddleView 渲染冒烟（2026-09-12 P1-1）：T 板升格中栏直达 tab 的自取数薄壳。
 *
 * 薄壳是本批次唯一的「新挂载面」——类型与构建全绿仍可能一渲染就崩（同族教训见
 * quote-stage.smoke 的 TDZ 网）。覆盖两条分支：
 * - 当前标的非期权合格（7 只 ETF 之外）→ 空态提示，不出 T 板；
 * - 当前标的为期权 ETF → 取数落地后渲染 OptionsStage（认购/认沽表头）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

/** 桥取数桩：固定名册 / 名册月 / 链，避免真打 fetch（vi.hoisted 规避 mock 提升 TDZ）。 */
const FIX = vi.hoisted(() => ({
  underlyings: [{
    underlying: '510050', exchange: 'SSE' as const, name: '50ETF',
    multiplier: 10000, tickSize: 0.0001, quotesSource: 'sse_board' as const,
  }],
  expiries: {
    underlying: '510050', source: 'local' as const,
    months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }],
  },
  chain: {
    underlying: '510050', expiryMonth: '2609', expiryDate: '2026-09-23',
    source: 'akshare', spot: 2.901,
    calls: [{ code: '510050C2609M02900', strike: 2.9, last: 0.05 }],
    puts: [],
  },
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchOptionsUnderlyings: vi.fn(async () => ({ ok: true as const, data: FIX.underlyings })),
    fetchOptionsExpiries: vi.fn(async () => ({ ok: true as const, data: FIX.expiries })),
    fetchOptionsChain: vi.fn(async () => ({ ok: true as const, data: FIX.chain })),
  }
})

import { OptionsStageMiddleView } from '../src/client/OptionsStageMiddleView.tsx'
import { selectionStore } from '../src/client/store.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { StageViewProps } from '../src/client/stage-views.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key
const props: StageViewProps = { t, view: 'options-stage' }

afterEach(() => {
  cleanup()
  // 模块级单例 + localStorage 双复位：selectionStore.select 会写盘，跨用例泄漏会污染后续。
  selectionStore.set({ instrument: null })
  localStorage.clear()
})

describe('OptionsStageMiddleView', () => {
  it('非期权合格标的 → 空态提示，不出 T 板', () => {
    selectionStore.set({ instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' } })
    const { container, getByText } = render(<OptionsStageMiddleView {...props} />)
    expect(container.querySelector('[data-dshtrading-options-stage-middle]')).toBeTruthy()
    expect(getByText('options.stage.middle.emptyHint')).toBeTruthy()
    // T 板表头不应出现
    expect(container.textContent).not.toContain('options.calls')
  })

  it('期权 ETF → 取数落地后渲染 T 板（认购/认沽表头 + 到期月胶囊）', async () => {
    selectionStore.set({ instrument: { market: 'cn', symbol: '510050', name: '50ETF' } })
    const { container, getByText } = render(<OptionsStageMiddleView {...props} />)
    await waitFor(() => { expect(getByText('options.calls')).toBeTruthy() })
    expect(getByText('options.puts')).toBeTruthy()
    // 到期月胶囊（名册月 2609）
    expect(getByText('2609')).toBeTruthy()
    // 空态提示不应出现
    expect(container.textContent).not.toContain('options.stage.middle.emptyHint')
  })
})
