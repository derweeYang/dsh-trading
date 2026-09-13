/**
 * OptionsOverviewMiddleView 空态聚合渲染冒烟（P2-8，2026-09-12）。
 *
 * 病灶：中栏「期权总览」由两条独立端点拼成（① 七标的聚合总览 / ② 5 分钟闭环），
 * 两条各自渲染一个灰字通知框——期权网关未起时同页叠两个同样的「code: message」。
 * 修法：两条都没数据时由薄壳出**一条**页面级通知，两个子节让位（suppressNotice）。
 *
 * 这里用 jsdom 真挂载把三件事钉死：
 * - 两条都失败 → 整页恰好 1 条聚合通知（人话 + 首个失败源明细），另一条不再自报；
 * - 仅一条失败（另一条有数据）→ **不聚合**，失败节自报，保留「哪一节坏了」的定位；
 * - 两条都还在途 → 也只出 1 条「加载中」，不叠两个 loading。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { OptionOverview } from '@dshtrading/api'

/** 桥取数桩（vi.hoisted 规避 mock 提升 TDZ；每个用例可改实现）。 */
const API = vi.hoisted(() => ({
  overview: vi.fn(),
  cycle: vi.fn(),
  packet: vi.fn(),
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchOptionsOverview: API.overview,
    fetchOptionsCycleLoop: API.cycle,
    fetchOptionsBarPacket: API.packet,
  }
})

import { OptionsOverviewMiddleView } from '../src/client/OptionsOverviewMiddleView.tsx'
import { optionsCycleLoopStore, optionsOverviewStore } from '../src/client/stage-actions.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { StageViewProps } from '../src/client/stage-views.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key
const props: StageViewProps = { t, view: 'options-overview' }

const OVERVIEW_FAIL = { ok: false as const, code: 'OVERVIEW_DOWN', message: 'gateway down' }
const CYCLE_FAIL = { ok: false as const, code: 'CYCLE_DOWN', message: 'loop down' }

/** 最小可用总览（部分可用场景用）。 */
const OVERVIEW: OptionOverview = {
  source: 'iquant', sort: 'strength', asOf: '2026-09-12T01:00:00.000Z', scanAllPrompt: 'scan all',
  rows: [{
    underlying: '510050', name: '上证50ETF', exchange: 'SSE', spotSymbol: '510050.SH',
    days: [{ date: '2026-09-12', changePct: 0.4, volumeSurge: false }], scanPrompt: 's',
  }],
}

beforeEach(() => {
  API.overview.mockResolvedValue(OVERVIEW_FAIL)
  API.cycle.mockResolvedValue(CYCLE_FAIL)
  API.packet.mockResolvedValue({ ok: false, code: 'NO_PACKET', message: 'no packet file' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // 共享聚合快照复位（模块级单例，跨用例污染会互相「看见」对方的 loop/overview）
  optionsOverviewStore.set(null)
  optionsCycleLoopStore.set({ loop: null, loaded: false, failure: null })
  localStorage.clear()
})

const NOTICE_SELECTOR = '[data-dshtrading-options-sources-notice]'

describe('OptionsOverviewMiddleView 空态聚合（P2-8）', () => {
  it('两条都失败：整页恰好 1 条聚合通知，第二条不再自报', async () => {
    const { container, getByText } = render(<OptionsOverviewMiddleView {...props} />)

    await waitFor(() => {
      expect(container.querySelector(NOTICE_SELECTOR)).toBeTruthy()
    })
    expect(container.querySelectorAll(NOTICE_SELECTOR).length).toBe(1)
    // 人话标题 + 恢复提示 + 首个失败源原文（保留可诊断性）
    expect(getByText('options.sources.failed')).toBeTruthy()
    expect(getByText('options.sources.failedHint')).toBeTruthy()
    expect(container.textContent).toContain('OVERVIEW_DOWN: gateway down')
    // 第二条失败源被聚合接管 → 页面不该再出现它的原文/自报文案
    expect(container.textContent).not.toContain('CYCLE_DOWN')
    expect(container.textContent).not.toContain('options.cycle.unavailable')
    expect(container.textContent).not.toContain('options.overview.loading')
    // 只收敛通知，不吞分区：两节的标题仍在
    expect(getByText('options.overview.title')).toBeTruthy()
    expect(getByText('options.cycle.title')).toBeTruthy()
  })

  it('仅闭环失败（总览有数据）：不聚合，失败节自报以保留定位', async () => {
    API.overview.mockResolvedValue({ ok: true, data: OVERVIEW })
    const { container } = render(<OptionsOverviewMiddleView {...props} />)

    await waitFor(() => {
      expect(container.textContent).toContain('CYCLE_DOWN: loop down')
    })
    // 有数据 ⇒ 页面级空态不接管
    expect(container.querySelector(NOTICE_SELECTOR)).toBeNull()
  })

  it('两条都还在途：只出 1 条「加载中」，不叠两个 loading 框', () => {
    API.overview.mockReturnValue(new Promise(() => { /* 永挂起：停在未落地 */ }))
    API.cycle.mockReturnValue(new Promise(() => { /* 永挂起：停在未落地 */ }))
    const { container, getByText } = render(<OptionsOverviewMiddleView {...props} />)

    expect(container.querySelectorAll(NOTICE_SELECTOR).length).toBe(1)
    expect(getByText('options.sources.loading')).toBeTruthy()
    expect(container.textContent).not.toContain('options.cycle.loading')
    expect(container.textContent).not.toContain('options.overview.loading')
  })
})
