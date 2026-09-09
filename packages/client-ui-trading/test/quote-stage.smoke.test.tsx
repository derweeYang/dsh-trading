/**
 * 渲染冒烟（issue #54 评审遗留基建）：把 QuoteStage 真正 mount 进 jsdom，
 * 拦住「构建与逻辑单测全绿、一渲染就崩」的回归——2026-09-03 实证：viewTab 声明
 * 顺序 TDZ（Cannot access 'stageTab' before initialization）炸掉整个中栏 slot，
 * tsdown 构建与 790 条逻辑测试均未发现，靠 live 验证才捕获。
 *
 * 2026-09-08 市场收敛 + 期权升格重写：fixture 统一 cn 词汇；crypto 衍生品
 * 冒烟已随 DerivativesStage/Pane 删除移除；新增「现货 ⇄ 期权」双透镜冒烟
 * （名册命中 → 期权透镜 → T 板 → 底仓徽章 → 合约点选下单面板，阶段 3 接线网）。
 *
 * 覆盖：
 * - QuoteStage 在 cn 标的下渲染不抛错；期权透镜仅名册命中标的出现；
 * - 基本面工作台挂载降级渲染（桥 500 不崩溃）；
 * - 统一「发送给 Agent」入口：fillComposer 注入 → 报价头主按钮 + 下拉菜单，
 *   行情快照可一键填入；
 * - 期权透镜：T 板渲染、底仓徽章（备兑张数）、合约点选出下单面板与备兑快捷。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

// TvChart 依赖 lightweight-charts（canvas 族 API 在 jsdom 不可用）：冒烟只关心
// QuoteStage 自身的渲染与交互编排，图表区以桩替代。
vi.mock('../src/client/TvChart.tsx', () => ({
  TvChart: () => null,
  toBar: (k: unknown) => k,
  toVolume: (k: unknown) => k,
}))

import { QuoteStage } from '../src/client/QuoteStage.tsx'
import { optionsCycleLoopStore, optionsOverviewStore } from '../src/client/stage-actions.ts'
import type { OptionCycleLoop } from '@dshtrading/api'
import type { SelectionState } from '../src/client/store.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey, _params?: Record<string, unknown>): string => key

beforeEach(() => {
  // 断网桩：桥请求一律 500，各轮询走既有 catch/降级路径（静默不炸）。
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // 共享聚合快照复位（模块级单例，跨测试污染会互相「看见」对方的 loop/overview）
  optionsCycleLoopStore.set({ loop: null, loaded: false, failure: null })
  optionsOverviewStore.set(null)
})

/** 5 分钟闭环 fixture（redesign 后 QuoteStage 从共享 store 读，不再自己 fetch）。 */
const LOOP: OptionCycleLoop = {
  running: true, horizonMin: 5, lastBucket: '2026-09-09T02:30:00.000Z',
  rows: [{
    underlying: '510050',
    stats: { n: 4, hits: 2, misses: 1, partials: 0, skipped: 1, hitRate: 0.67 },
    latest: {
      id: '510050:1', bucketStart: '2026-09-09T02:30:00.000Z', asOf: '2026-09-09T02:30:00.000Z',
      forecast: {
        underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', horizonMin: 5,
        boxLow: 2.99, boxHigh: 3.01, regime: 'range_hold', session: 'regular',
        candidates: [{ template: 'butterfly', bias: 'neutral', invalidIf: 'x', reason: 'y' }],
      },
      calibration: 'none',
    },
  }],
}

function quoteStageProps(symbol = '600519') {
  const selection: SelectionState = { instrument: { market: 'cn', symbol } }
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

describe('QuoteStage 渲染冒烟（TDZ 网）', () => {
  it('cn 标的：渲染不抛错；名册未命中 → 期权透镜不渲染', () => {
    const { container, queryByText } = render(<QuoteStage {...quoteStageProps()} />)
    expect(container.textContent).toContain('600519')
    expect(queryByText('lens.options')).toBeNull()
    expect(queryByText('quote.tab.chart')).toBeTruthy()
  })

  it('基本面页签存在且可切换到基本面工作台', async () => {
    const { getByText, container } = render(<QuoteStage {...quoteStageProps()} />)
    fireEvent.click(getByText('quote.tab.fundamentals'))
    // 桥请求被断网桩 500 → 挂载 spinner → 降级渲染工作台根节点，不崩溃
    await waitFor(() => {
      expect(container.querySelector('[data-dshtrading-fundamentals]')).toBeTruthy()
    })
  })

  it('统一发送入口：报价头常驻主按钮，下拉菜单行情快照可一键填入（2026-09-04）', async () => {
    const fillComposer = vi.fn(async () => {})
    const { container, getByText, queryByText } = render(
      <QuoteStage {...quoteStageProps()} fillComposer={fillComposer} />,
    )
    // 主按钮在报价头渲染（t 直出 key）
    expect(getByText('quote.sendToAgent')).toBeTruthy()
    // 打开下拉菜单：行情快照项在位
    fireEvent.click(container.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement)
    expect(getByText('quote.sendMenuSnapshot')).toBeTruthy()
    expect(queryByText('options.sendLegToAgent')).toBeNull()
    // 点击行情快照 → fillComposer 恰被调用一次（只填不发语义由 fill-composer 测试覆盖）
    fireEvent.click(getByText('quote.sendMenuSnapshot'))
    await waitFor(() => { expect(fillComposer).toHaveBeenCalledTimes(1) })
  })

  it('默认主按钮在图表页也补齐公告、新闻与基本面，重复点击只填一次', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/news?')) return new Response(JSON.stringify({ ok: true, items: [
        { source: 'eastmoney', title: 'Annual disclosure', url: 'https://example.com/filing', publishedAt: '2026-09-01' },
        { source: 'eastmoney', title: 'Product launch', url: 'https://example.com/news', publishedAt: '2026-09-02' },
      ], unavailable: [] }))
      if (url.includes('/fundamentals?')) return new Response(JSON.stringify({ ok: true, fundamentals: { market: 'cn', symbol: '600519', profile: { symbol: '600519', industry: 'Liquor' } } }))
      return new Response('{}', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const fillComposer = vi.fn(async () => {})
    const { getByText } = render(<QuoteStage {...quoteStageProps()} fillComposer={fillComposer} />)
    const button = getByText('quote.sendToAgent')
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(fillComposer).toHaveBeenCalledTimes(1))
    const body = (fillComposer.mock.calls as unknown as string[][])[0]?.[0]
    expect(body).toContain('Annual disclosure')
    expect(body).toContain('Product launch')
    expect(body).toContain('Liquor')
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/fundamentals?'))).toHaveLength(1)
  })

  it('切标的取消补齐，不把旧结果填入输入框', async () => {
    let finishNews: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/news?')
      ? new Promise<Response>(resolve => { finishNews = resolve })
      : Promise.resolve(new Response('{}', { status: 500 }))))
    const fillComposer = vi.fn(async () => {})
    const view = render(<QuoteStage {...quoteStageProps('600519')} fillComposer={fillComposer} />)
    fireEvent.click(view.getByText('quote.sendToAgent'))
    view.rerender(<QuoteStage {...quoteStageProps('000001')} fillComposer={fillComposer} />)
    finishNews?.(new Response(JSON.stringify({ ok: true, items: [], unavailable: [] })))
    await waitFor(() => expect(view.getByText('quote.sendToAgent')).toBeTruthy())
    expect(fillComposer).not.toHaveBeenCalled()
  })

  it('异步补齐使用点击时捕获的 composer 目标', async () => {
    const fill = vi.fn(async () => {})
    const target = vi.fn(async () => {})
    const captureTarget = vi.fn(() => target)
    const fillComposer = Object.assign(fill, { captureTarget })
    const view = render(<QuoteStage {...quoteStageProps()} fillComposer={fillComposer} />)
    fireEvent.click(view.getByText('quote.sendToAgent'))
    expect(captureTarget).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(target).toHaveBeenCalledTimes(1))
    expect(fill).not.toHaveBeenCalled()
  })

  it('补齐超时仍填入行情与缺项提示，不永久停留 sending', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
        if (url.includes('/news?') || url.includes('/fundamentals?')) return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
        return Promise.resolve(new Response('{}', { status: 500 }))
      }))
      const fillComposer = vi.fn(async () => {})
      const view = render(<QuoteStage {...quoteStageProps()} fillComposer={fillComposer} />)
      fireEvent.click(view.getByText('quote.sendToAgent'))
      expect(fillComposer).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(15001) })
      expect(fillComposer).toHaveBeenCalledTimes(1)
      expect((fillComposer.mock.calls as unknown as string[][])[0]?.[0]).toContain('compose.research.unavailable')
      view.unmount()
    } finally { vi.useRealTimers() }
  })

  it('未注入 fillComposer → 统一发送入口整体不渲染', () => {
    const { queryByText, container } = render(<QuoteStage {...quoteStageProps()} />)
    expect(queryByText('quote.sendToAgent')).toBeNull()
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull()
  })
})

describe('QuoteStage「现货 ⇄ 期权」双透镜冒烟（阶段 3 交易面接线网）', () => {
  /** 期权桥桩：名册命中 510050（乘数 10000、底仓 20000 份 → 备兑 2 张）+ T 表一档。 */
  function stubOptionsBridge(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/options/underlyings')) {
        return new Response(JSON.stringify({
          ok: true,
          underlyings: [{ underlying: '510050', exchange: 'SSE', name: '上证50ETF', multiplier: 10000, tickSize: 0.0001, quotesSource: 'cn', heldQty: 20000 }],
        }))
      }
      if (url.includes('/options/expiries')) {
        return new Response(JSON.stringify({
          ok: true,
          expiries: { months: [{ expiryMonth: '2609', expiryDate: '2026-09-23' }] },
        }))
      }
      if (url.includes('/options/chain')) {
        return new Response(JSON.stringify({
          ok: true,
          chain: {
            underlying: '510050', expiryMonth: '2609', expiryDate: '2026-09-23',
            snapshotAt: '2026-09-08T10:00:00+08:00', source: 'akshare', spot: 2.9,
            calls: [{ code: '510050C2609M02900', strike: 2.9, last: 0.05, volume: 10, impliedVol: 0.2 }],
            puts: [{ code: '510050P2609M02900', strike: 2.9, last: 0.04, volume: 5, impliedVol: 0.23 }],
          },
        }))
      }
      if (url.includes('/options/positions')) {
        return new Response(JSON.stringify({ ok: true, positions: [] }))
      }
      if (url.includes('/options/overview')) {
        return new Response(JSON.stringify({
          ok: true,
          overview: {
            source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z',
            scanAllPrompt: 'scan all underlyings',
            rows: [{
              underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', spotSymbol: '510050.SH',
              last: 2.91, changePct: 0.4, return5d: 1.2, volumeRatio: 0.8, strengthScore: 0.96,
              days: [{ date: '2026-09-08', changePct: 0.3, volumeSurge: true }],
              divergence: 'weak_rally', heldQty: 20000, optionQty: 2, scanPrompt: 'scan 510050',
            }],
          },
        }))
      }
      if (url.includes('/options/cycles/loop')) {
        return new Response(JSON.stringify({
          ok: true,
          loop: {
            running: true, horizonMin: 5, lastBucket: '2026-09-09T02:30:00.000Z',
            rows: [{
              underlying: '510050',
              stats: { n: 4, hits: 2, misses: 1, partials: 0, skipped: 1, hitRate: 0.67 },
              latest: {
                id: '510050:1', bucketStart: '2026-09-09T02:30:00.000Z', asOf: '2026-09-09T02:30:00.000Z',
                forecast: {
                  underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', horizonMin: 5,
                  boxLow: 2.99, boxHigh: 3.01, regime: 'range_hold', session: 'regular',
                  candidates: [{ template: 'butterfly', bias: 'neutral', invalidIf: 'x', reason: 'y' }],
                },
                calibration: 'none',
              },
            }],
          },
        }))
      }
      if (url.includes('/options/resolve')) {
        return new Response(JSON.stringify({
          ok: true,
          input: '510050.SH',
          underlying: '510050',
          link: { underlying: '510050', spotSymbol: '510050.SH', exchange: 'SSE', callPrefix: '510050C', putPrefix: '510050P' },
        }))
      }
      return new Response('{}', { status: 500 })
    }))
  }

  it('期权透镜落地页 = T 板（redesign：总览升格中栏顶部 tab）+ 底仓徽章 + 箱体条', async () => {
    stubOptionsBridge()
    optionsCycleLoopStore.set({ loop: LOOP, loaded: true, failure: null })
    const { container, getByText } = render(
      <QuoteStage {...quoteStageProps('510050')} />,
    )
    const lensTab = await waitFor(() => getByText('lens.options'))
    fireEvent.click(lensTab)
    // 落地页直接是 T 板：总览不再是透镜落地页（已升格中栏顶部 tab，不在透镜渲染）
    await waitFor(() => { expect(container.querySelector('[data-dshtrading-options-stage]')).toBeTruthy() })
    expect(container.querySelector('[data-dshtrading-options-overview]')).toBeNull()
    expect(getByText('options.underlying')).toBeTruthy()
    expect(getByText('options.calls')).toBeTruthy()
    expect(getByText('options.held.badge')).toBeTruthy()
    // WB-3 箱体条：读共享闭环快照的本桶预报，不自己算
    expect(getByText('options.box.title')).toBeTruthy()
    expect(getByText('options.cycle.regime.range_hold')).toBeTruthy()
    expect(getByText('options.template.butterfly')).toBeTruthy()
    // 点认购最新价单元格 → 下单面板出现（含备兑快捷：认购腿 + 备兑 2 张）
    const callLast = await waitFor(() => container.querySelector('[data-dshtrading-options-stage] tbody tr td:nth-child(4)') as HTMLTableCellElement)
    fireEvent.click(callLast)
    expect(container.querySelector('[data-dshtrading-option-order]')).toBeTruthy()
    expect(getByText('options.order.title')).toBeTruthy()
    expect(getByText('options.held.cover')).toBeTruthy()
    // 切回现货透镜：期权透镜卸载
    fireEvent.click(getByText('lens.spot'))
    await waitFor(() => { expect(container.querySelector('[data-dshtrading-options-stage]')).toBeNull() })
  })

  it('非注册标的（个股）：透镜不渲染（redesign：总览走中栏顶部 tab，不依赖标的上下文）', async () => {
    stubOptionsBridge()
    const { container } = render(<QuoteStage {...quoteStageProps('600519')} />)
    await waitFor(() => { expect(container.textContent).toContain('600519') })
    // 显隐判据收紧回 optionsAvailable：个股无透镜入口，也不会渲染 T 板/总览
    expect(container.querySelector('[aria-label="spot or options lens"]')).toBeNull()
    expect(container.querySelector('[data-dshtrading-options-stage]')).toBeNull()
    expect(container.querySelector('[data-dshtrading-options-overview]')).toBeNull()
  })
})
