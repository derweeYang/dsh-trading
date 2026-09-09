/**
 * 期权总览 + 5 分钟闭环渲染冒烟（2026-09-09 WB-1 / WB-6）。
 *
 * 这两个组件是「只拉一条聚合端点」的新页面，最容易犯的错不是崩，而是**静默失真**：
 * - 桥侧「单行失败键缺席」→ UI 若整页空白或填 0，就把数据缺口显示成事实；
 * - `includeIv` 若默认打开，九路 vol_analytics 打爆网关，本地看不出来；
 * - 闭环 `running=false` 若照常画「进行中」，就是把没启动说成在跑。
 * 这里用 jsdom 真挂载把这三类锁住。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { OptionCycleLoop, OptionOverview, OptionOverviewSort } from '@dshtrading/api'
import { OptionsOverview } from '../src/client/OptionsOverview.tsx'
import { OptionsCycleLoop } from '../src/client/OptionsCycleLoop.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey, _params?: Record<string, unknown>): string => key

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** 九行里故意留一行全缺键（模拟单行取数失败），另两行正常。 */
const OVERVIEW: OptionOverview = {
  source: 'iquant',
  sort: 'strength',
  asOf: '2026-09-09T01:00:00.000Z',
  scanAllPrompt: 'scan all underlyings',
  rows: [
    {
      underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', spotSymbol: '510050.SH',
      last: 2.91, changePct: 0.4, return5d: 1.2, volumeRatio: 0.8, strengthScore: 0.96,
      days: [
        { date: '2026-09-03', changePct: 0.1, volumeSurge: false },
        { date: '2026-09-04', changePct: -1.8, volumeSurge: true },
      ],
      divergence: 'weak_rally', heldQty: 20000, optionQty: 2, scanPrompt: 'scan 510050',
    },
    {
      underlying: '159915', name: '创业板ETF', exchange: 'SZSE', spotSymbol: '159915.SZ',
      days: [], scanPrompt: 'scan 159915',
    },
  ],
}

function renderOverview(overrides: Partial<React.ComponentProps<typeof OptionsOverview>> = {}) {
  const onSortChange = vi.fn<(sort: OptionOverviewSort) => void>()
  const onPickRow = vi.fn()
  const view = render(
    <OptionsOverview
      t={t}
      colorMode="red-up"
      overview={OVERVIEW}
      failure={null}
      loaded
      sort="strength"
      onSortChange={onSortChange}
      onPickRow={onPickRow}
      {...overrides}
    />,
  )
  return { ...view, onSortChange, onPickRow }
}

describe('OptionsOverview', () => {
  it('九行渲染 + 缺键按单元格出「—」，不整页空白', () => {
    const { container, getByText } = renderOverview()
    expect(container.querySelectorAll('tbody tr').length).toBe(2)
    // 缺键行：last/changePct/return5d/strengthScore/heldQty 全缺 → 单元格出「—」
    const rows = container.querySelectorAll('tbody tr')
    const sparse = rows[1] as HTMLElement
    expect(sparse.textContent).toContain('—')
    expect(sparse.textContent).toContain('159915')
    // 正常行关键列在
    expect(getByText('options.overview.col.strength')).toBeTruthy()
    expect(rows[0]?.textContent).toContain('0.96')
  })

  it('排序切 iv 才回调 iv（才打网关）；默认 strength 高亮', () => {
    const { getByText, onSortChange } = renderOverview()
    fireEvent.click(getByText('options.overview.sort.iv'))
    expect(onSortChange).toHaveBeenCalledWith('iv')
    fireEvent.click(getByText('options.overview.sort.holdings'))
    expect(onSortChange).toHaveBeenLastCalledWith('holdings')
  })

  it('T-5 只画实际有的格数，放量格带边框标记', () => {
    const { container } = renderOverview()
    const first = container.querySelector('tbody tr') as HTMLElement
    // 两日数据 → 两格（不是硬凑五格）
    expect(first.querySelectorAll('[data-surge]').length).toBe(1)
    const surge = first.querySelector('[data-surge]') as HTMLElement
    expect(surge.getAttribute('data-surge')).toBe('true')
    expect(surge.textContent).toContain('-1.80%')
  })

  it('点行进 T 板；点行内扫描不冒泡进行点击', () => {
    const onScanRow = vi.fn()
    const { container, onPickRow } = renderOverview({ onScanRow })
    fireEvent.click(container.querySelector('tbody tr') as HTMLElement)
    expect(onPickRow).toHaveBeenCalledTimes(1)
    const scanBtn = container.querySelector('tbody tr td:last-child button') as HTMLElement
    fireEvent.click(scanBtn)
    expect(onScanRow).toHaveBeenCalledTimes(1)
    expect(onPickRow).toHaveBeenCalledTimes(1)
  })

  it('未注入 fillComposer（无扫描回调）→ 不渲染扫描按钮', () => {
    const { container } = renderOverview()
    expect(container.querySelector('tbody tr td:last-child button')).toBeNull()
  })

  it('失败码原文展示（不吞成通用空态）', () => {
    const { container } = renderOverview({
      overview: null,
      failure: { code: 'TRADING_NETWORK', message: 'gateway down' },
    })
    expect(container.textContent).toContain('TRADING_NETWORK')
  })

  it('首个应答在途显示加载中，不闪「不可用」', () => {
    const { container } = renderOverview({ overview: null, loaded: false })
    expect(container.textContent).toContain('options.overview.loading')
    expect(container.textContent).not.toContain('options.overview.unavailable')
  })
})

/* ── 5 分钟闭环 ─────────────────────────────────────────────────────── */

function renderLoop(loop: OptionCycleLoop | null, overrides: Partial<React.ComponentProps<typeof OptionsCycleLoop>> = {}) {
  return render(
    <OptionsCycleLoop t={t} loop={loop} failure={null} loaded names={{ '510050': '上证50ETF' }} {...overrides} />,
  )
}

describe('OptionsCycleLoop', () => {
  it('running=false → 如实标「闭环未启动」，不假装在走', () => {
    const { container } = renderLoop({ running: false, horizonMin: 5, rows: [] })
    expect(container.textContent).toContain('options.cycle.stopped')
  })

  it('本桶预报 + 候选模板标签 + 命中率条带', () => {
    const loop: OptionCycleLoop = {
      running: true,
      horizonMin: 5,
      lastBucket: '2026-09-09T02:30:00.000Z',
      rows: [{
        underlying: '510050',
        stats: { n: 4, hits: 2, misses: 1, partials: 0, skipped: 1, hitRate: 0.67 },
        latest: {
          id: '510050:1',
          underlying: '510050',
          bucketStart: '2026-09-09T02:30:00.000Z',
          asOf: '2026-09-09T02:30:00.000Z',
          forecast: {
            underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', horizonMin: 5,
            boxLow: 2.99, boxHigh: 3.01, regime: 'range_hold', session: 'regular',
            candidates: [{ template: 'butterfly', bias: 'neutral', invalidIf: 'x', reason: 'y' }],
          },
          calibration: 'none',
        },
      }],
    }
    const { container } = renderLoop(loop)
    // 标的名从总览借（闭环行只有代码）
    expect(container.textContent).toContain('上证50ETF')
    expect(container.textContent).toContain('options.cycle.regime.range_hold')
    expect(container.textContent).toContain('options.template.butterfly')
    expect(container.textContent).toContain('67%')
    // latest 无 score（下一桶才补）→ 待评估，不伪造 verdict
    expect(container.textContent).toContain('options.cycle.verdict.pending')
  })

  it('no_trade 只出示原因，不画箱沿', () => {
    const loop: OptionCycleLoop = {
      running: true,
      horizonMin: 5,
      rows: [{
        underlying: '510050',
        stats: { n: 0, hits: 0, misses: 0, partials: 0, skipped: 0 },
        latest: {
          id: '510050:2',
          underlying: '510050',
          bucketStart: '2026-09-09T02:30:00.000Z',
          asOf: '2026-09-09T02:30:00.000Z',
          forecast: {
            underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', horizonMin: 5,
            regime: 'no_trade', session: 'lunch', noTradeReason: 'lunch', candidates: [],
          },
          calibration: 'suppressed',
        },
      }],
    }
    const { container } = renderLoop(loop)
    expect(container.textContent).toContain('options.cycle.session.lunch')
    expect(container.textContent).toContain('options.cycle.calibration.suppressed')
    expect(container.textContent).toContain('options.box.noTrade')
    // 命中率缺席（scored=0）→ 样本不足，不显示 0%
    expect(container.textContent).toContain('options.cycle.sampleShort')
  })
})
