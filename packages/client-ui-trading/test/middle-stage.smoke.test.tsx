/**
 * MiddleStage 渲染冒烟 + 全 tab 交易台入口（P1-2，2026-09-12）。
 *
 * 背景：过去交易台开关是 QuoteStage 的组件内 state，只有行情工具栏能开 → 非行情 tab
 * （期权总览 / 预测 / 策略 / 知识库）没有下单入口。修法是把开关抽成 trade-desk-store
 * 单例，并在 MiddleStage 的 tab 条右侧加一个全 tab 常驻的「交易台」动作按钮。
 *
 * 本文件是这道接线的回归护栏（live 探针抓得到、CI 也抓得到）：
 * - 停在**插件视图**（非行情 tab）时，交易台入口仍渲染且 aria-pressed 反映 store；
 * - 非行情 tab 点击 → 切到行情视图（QuoteStage 真挂载、不崩）+ 展开交易台；
 * - 行情视图点击 → 就地取反开关（不开新视图）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

// TvChart 依赖 lightweight-charts（canvas 族 API 在 jsdom 不可用）：切到行情视图会
// 真挂载 QuoteStage，图表区以桩替代（与 quote-stage.smoke 同款）。
vi.mock('../src/client/TvChart.tsx', () => ({
  TvChart: () => null,
  toBar: (k: unknown) => k,
  toVolume: (k: unknown) => k,
}))

import { MiddleStage } from '../src/client/MiddleStage.tsx'
import { stageViews } from '../src/client/stage-views.ts'
import { tradeDeskStore, writeTradeDeskOpen } from '../src/client/trade-desk-store.ts'
import type { SelectionState } from '../src/client/store.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** 测试专用插件视图 id（本文件注册/注销，不污染 registry）。 */
const FAKE_VIEW_ID = 'test-only-tab'
const STAGE_KEY = 'dshtrading.stage.v1'
const DESK_KEY = 'dshtrading.tradeDesk.open'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

/** 停在非行情 tab：注册一个最薄的插件视图，并把持久化视图指向它。 */
function registerFakeView(): void {
  stageViews.register({
    id: FAKE_VIEW_ID,
    titleKey: 'stage.strategy',
    order: 99,
    render: () => <div data-testid="fake-tab-body" />,
  })
}

function middleStageProps() {
  const selection: SelectionState = { instrument: { market: 'cn', symbol: '510050' } }
  const chart: ChartState = { instances: [] }
  return {
    t,
    useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
    useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
    toggleIndicator: () => {},
    setIndicatorParams: () => {},
    setIndicatorVisible: () => {},
    removeIndicator: () => {},
    deleteIndicator: async () => true,
  }
}

beforeEach(() => {
  registerFakeView()
  // 断网桩：桥请求一律 500，各轮询走既有 catch/降级路径（静默不炸）。
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  stageViews.unregister(FAKE_VIEW_ID)
  // store 是模块级懒单例：内存态要显式复位，否则跨用例污染
  writeTradeDeskOpen(false)
  localStorage.clear()
})

describe('MiddleStage 交易台全局入口（P1-2）', () => {
  it('停在插件视图：交易台入口仍常驻，aria-pressed 反映 store 缺省关', () => {
    localStorage.setItem(STAGE_KEY, JSON.stringify(FAKE_VIEW_ID))
    const { getByRole, getByTestId } = render(<MiddleStage {...middleStageProps()} />)

    expect(getByTestId('fake-tab-body')).toBeTruthy()
    const entry = getByRole('button', { name: 'stage.tradeDesk' })
    expect(entry.getAttribute('aria-pressed')).toBe('false')
  })

  it('非行情 tab 点击：切到行情视图（真挂载 QuoteStage 不崩）并展开交易台', async () => {
    localStorage.setItem(STAGE_KEY, JSON.stringify(FAKE_VIEW_ID))
    const { getByRole, getByText, queryByTestId } = render(<MiddleStage {...middleStageProps()} />)

    fireEvent.click(getByRole('button', { name: 'stage.tradeDesk' }))

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STAGE_KEY) ?? 'null')).toBe('quote')
    })
    // 行情视图真挂载（不是白屏）+ 交易台展开
    expect(getByText('quote.tab.chart')).toBeTruthy()
    expect(queryByTestId('fake-tab-body')).toBeNull()
    expect(tradeDeskStore().getSnapshot()).toBe(true)
    expect(getByRole('button', { name: 'stage.tradeDesk' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('已在行情视图点击：就地取反开关，不重置视图', () => {
    localStorage.setItem(STAGE_KEY, JSON.stringify('quote'))
    const { getByRole } = render(<MiddleStage {...middleStageProps()} />)
    const entry = (): HTMLElement => getByRole('button', { name: 'stage.tradeDesk' })

    fireEvent.click(entry())
    expect(tradeDeskStore().getSnapshot()).toBe(true)
    expect(localStorage.getItem(DESK_KEY)).toBe('1')

    fireEvent.click(entry())
    expect(tradeDeskStore().getSnapshot()).toBe(false)
    expect(localStorage.getItem(DESK_KEY)).toBe('0')
    expect(JSON.parse(localStorage.getItem(STAGE_KEY) ?? 'null')).toBe('quote')
  })
})
