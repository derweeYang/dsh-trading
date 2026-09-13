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
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { OptionOverview } from '@dshtrading/api'

/** 桥取数桩（vi.hoisted 规避 mock 提升 TDZ；每个用例可改实现）。 */
const API = vi.hoisted(() => ({
  overview: vi.fn(),
  cycle: vi.fn(),
  packet: vi.fn(),
  desk: vi.fn(),
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchOptionsOverview: API.overview,
    fetchOptionsCycleLoop: API.cycle,
    fetchOptionsBarPacket: API.packet,
    fetchOptionsPaperDesk: API.desk,
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
  API.desk.mockResolvedValue({ ok: false, code: 'NO_DESK', message: 'desk not wired' })
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

  it('纸账户执行台已迁出到资产面板（WB-18）：本页不再渲染 desk，也不再刷该端点', async () => {
    API.overview.mockResolvedValue({ ok: true, data: OVERVIEW })
    const { container } = render(<OptionsOverviewMiddleView {...props} />)
    await waitFor(() => {
      expect(container.textContent).toContain('510050')
    })

    // 迁移而非复制：中栏无 desk 区（它在资产面板的期权账户页签）
    expect(container.querySelector('[data-dshtrading-paper-desk]')).toBeNull()
    expect(container.textContent).not.toContain('options.desk.title')
    // 也不再为它单独轮询——中栏只剩总览与闭环两条数据源
    expect(API.desk).not.toHaveBeenCalled()
  })
})

/* ── task #11 检测机会的**端到端透传**（WB-16）──────────────────────────
 *
 * 叶组件（OptionsDetectedOpportunities）已有自己的冒烟，但它把 opportunities
 * 直接塞进 OptionsOverview 的 props，**绕过了真实数据路径**：桥 JSON →
 * `OptionsOverviewMiddleView.overview` state → `displayOverview = {...overview, rows}`
 * → `OptionsOverview`（cast）→ 检测区。这段路上任何一处把 overview 重建成
 * 字面量对象，`opportunities` 都会静默消失，而叶组件测试照样全绿。
 *
 * 交接单 §11.4 的口径正是「src/client/** 零改动下前端自动渲染」——所以这条必须
 * 从**中栏挂载**开始验，才叫证据。
 */
describe('OptionsOverviewMiddleView → 检测机会端到端（task #11 / WB-16）', () => {
  /** 桥返回的 overview 原文形状：额外带 opportunities（后端 task #11 的产出）。 */
  const OVERVIEW_WITH_DETECTED = {
    ...OVERVIEW,
    opportunities: [
      {
        id: '2026-09-10T06:00:00Z-588000',
        date: '2026-09-10',
        bucketStartUtc: '2026-09-10T06:00:00.000Z',
        bucketStartCst: '2026-09-10 14:00:00',
        session: 'regular',
        opportunity: 'mean_reversion',
        opportunityLabel: 'MEAN-REV',
        noTrade: false,
        underlyings: ['588000'],
        picks: [{
          underlying: '588000', regime: 'mean_revert', regimeLabel: 'MR', template: 'vertical',
          structure: 'bear_call_credit', expiryMonth: '2609', expiryDate: '2026-09-23', maxContracts: 10,
          legs: [
            { code: '588000C2609M01700', side: 'sell', optionType: 'C', strike: 1.7, last: 0.0566, prevSettle: 0.0475 },
            { code: '588000C2609M01750', side: 'buy', optionType: 'C', strike: 1.75, last: 0.0348, prevSettle: 0.0309 },
          ],
          netCreditCnyPerSpread: 218, maxLossCnyPerSpread: 282, breakevenAtExpiry: 1.7218,
          verification: null, quoteSource: 'test', status: 'PRICED',
        }],
        edge: 'E', logic: 'L', playbook: 'P', invalidIf: 'I',
        edgeZh: 'E', logicZh: 'L', playbookZh: 'P', invalidIfZh: 'I',
      },
      {
        id: '2026-09-10T05:50:00Z-510050',
        date: '2026-09-10',
        bucketStartUtc: '2026-09-10T05:50:00.000Z',
        bucketStartCst: '2026-09-10 13:50:00',
        session: 'regular',
        opportunity: 'mean_reversion',
        opportunityLabel: 'MEAN-REV',
        noTrade: false,
        underlyings: ['510050'],
        picks: [{
          underlying: '510050', regime: 'mean_revert', regimeLabel: 'MR', template: 'vertical',
          structure: null, expiryMonth: null, expiryDate: null, maxContracts: null,
          legs: [], netCreditCnyPerSpread: null, maxLossCnyPerSpread: null, breakevenAtExpiry: null,
          verification: null, quoteSource: null, status: 'IDENTIFIED',
        }],
        edge: 'E2', logic: 'L2', playbook: 'P2', invalidIf: 'I2',
        edgeZh: 'E2', logicZh: 'L2', playbookZh: 'P2', invalidIfZh: 'I2',
      },
    ],
  }

  it('桥原文带 opportunities（类型尚未进 api 契约）→ 中栏挂载即渲染检测区，前端零改动', async () => {
    // 用 unknown 桥接：契约字段还没进 @dshtrading/api，前端正是靠 cast 透传（见 WB-14 note）
    API.overview.mockResolvedValue({ ok: true, data: OVERVIEW_WITH_DETECTED as unknown as OptionOverview })
    const { container } = render(<OptionsOverviewMiddleView {...props} />)

    await waitFor(() => {
      expect(container.querySelector('[data-dshtrading-detected-opportunities]')).toBeTruthy()
    })
    const section = container.querySelector('[data-dshtrading-detected-opportunities]') as HTMLElement
    // 两条机会都渲染，且**定价与否按数据判**（不看文案）
    const cards = Array.from(section.querySelectorAll('[data-detected-card]'))
    expect(cards.map(c => c.getAttribute('data-priced'))).toEqual(['true', 'false'])

    // 已定价：腿表两行 + 三项风险指标（交接单 §11.4 第 3 条）
    const priced = cards[0] as HTMLElement
    const legs = priced.querySelectorAll('[data-detected-legs] tbody tr')
    expect(legs.length).toBe(2)
    expect(priced.textContent).toContain('588000C2609M01700')
    const metrics = priced.querySelector('[data-detected-metrics]') as HTMLElement
    expect(metrics.textContent).toContain('options.detected.netCredit')
    expect(metrics.textContent).toContain('218')
    expect(metrics.textContent).toContain('options.detected.maxLoss')
    expect(metrics.textContent).toContain('282')
    expect(metrics.textContent).toContain('options.detected.breakeven')
    expect(metrics.textContent).toContain('1.7218')

    // 未定价：只出闸门提示，不出腿表、不出风险指标（不编造价位）
    const unpriced = cards[1] as HTMLElement
    expect(unpriced.querySelector('[data-detected-blocker]')?.textContent).toBe('options.detected.unpriced')
    expect(unpriced.querySelector('[data-detected-legs]')).toBeNull()
    expect(unpriced.querySelector('[data-detected-metrics]')).toBeNull()
  })

  it('折叠开关在中栏路径下同样生效（收起后四段与腿表都不在文档里）', async () => {
    API.overview.mockResolvedValue({ ok: true, data: OVERVIEW_WITH_DETECTED as unknown as OptionOverview })
    const { container, getByText } = render(<OptionsOverviewMiddleView {...props} />)

    await waitFor(() => {
      expect(container.querySelector('[data-detected-legs]')).toBeTruthy()
    })
    fireEvent.click(getByText('options.detected.collapse'))
    expect(container.querySelector('[data-detected-legs]')).toBeNull()
    expect(getByText('options.detected.expandMore')).toBeTruthy()
  })

  it('后端未发货（无 opportunities 键）→ 检测区整体不渲染，总览照常', async () => {
    API.overview.mockResolvedValue({ ok: true, data: OVERVIEW })
    const { container, getByText } = render(<OptionsOverviewMiddleView {...props} />)

    await waitFor(() => {
      expect(getByText('options.overview.title')).toBeTruthy()
    })
    expect(container.querySelector('[data-dshtrading-detected-opportunities]')).toBeNull()
    expect(container.querySelectorAll(NOTICE_SELECTOR).length).toBe(0)
  })
})
