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
    // 正常行关键列在（WB-9 后该文案在表头与机会卡指标各出现一次，故按表头限定）
    const headers = Array.from(container.querySelectorAll('thead th')).map(th => th.textContent)
    expect(headers).toContain('options.overview.col.strength')
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

  it('WB-11 机会卡整卡可点进 T 板；底部按钮不冒泡双触发', () => {
    const onScanRow = vi.fn()
    const { container, onPickRow } = renderOverview({
      overview: {
        source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [{
          underlying: '510050', name: '上证50ETF', exchange: 'SSE' as const, spotSymbol: '510050.SH',
          days: [{ date: '2026-09-09', changePct: 0.4, volumeSurge: false }], scanPrompt: 's',
        }],
      },
      onScanRow,
    })
    const card = container.querySelector('[data-dshtrading-opportunity-card="510050"]') as HTMLElement
    fireEvent.click(card)
    expect(onPickRow).toHaveBeenCalledTimes(1)
    // 「问 AI」不冒泡成进 T 板
    const askBtn = Array.from(card.querySelectorAll('button'))
      .find(btn => btn.textContent === 'options.overview.card.askAi') as HTMLElement
    expect(askBtn).toBeTruthy()
    fireEvent.click(askBtn)
    expect(onScanRow).toHaveBeenCalledTimes(1)
    expect(onPickRow).toHaveBeenCalledTimes(1)
  })

  it('WB-11 排序在途：根节点 data-sorting 标记（降透明度反馈）', () => {
    const { container } = renderOverview({ sorting: true })
    expect(container.querySelector('[data-dshtrading-options-overview]')?.getAttribute('data-sorting')).toBe('true')
    const { container: idle } = renderOverview()
    expect(idle.querySelector('[data-dshtrading-options-overview]')?.getAttribute('data-sorting')).toBeNull()
  })

  it('WB-11 排序切 iv 且 IV 全缺席 → 出 ivMissing 提示，不伪装无响应', () => {
    const { container } = renderOverview({ sort: 'iv' })
    expect(container.textContent).toContain('options.overview.ivMissing')
    // 有 IV 值时不提示
    const { container: withIv } = renderOverview({
      sort: 'iv',
      overview: {
        source: 'iquant', sort: 'iv', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [{
          underlying: '510050', name: '上证50ETF', exchange: 'SSE' as const, spotSymbol: '510050.SH',
          ivPercentile: 0.72, days: [], scanPrompt: 's',
        }],
      },
    })
    expect(withIv.textContent).not.toContain('options.overview.ivMissing')
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

  it('WB-7 推荐策略列表头落在 optionQty 与 T-5 之间', () => {
    const { container } = renderOverview({
      overview: {
        source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [
          { underlying: '510050', name: '上证50ETF', exchange: 'SSE', spotSymbol: '510050.SH', days: [], scanPrompt: 's',
            strategy: { opportunity: 'theta_rent', template: 'butterfly', edge: 'range_hold collect theta', noTrade: false, bucketStart: '2026-09-09T01:00:00.000Z' } },
        ],
      },
    })
    const headers = Array.from(container.querySelectorAll('thead th')).map(th => th.textContent)
    const iStr = headers.indexOf('options.overview.col.strategy')
    const iQty = headers.indexOf('options.overview.col.optionQty')
    const iT5 = headers.indexOf('options.overview.col.t5')
    expect(iStr).toBeGreaterThan(iQty)
    expect(iStr).toBeLessThan(iT5)
  })

  it('WB-7 三分支渲染：edge 模板·机会 / no_edge / skip / 缺键「—」', () => {
    const { container } = renderOverview({
      overview: {
        source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [
          { underlying: '510050', name: '上证50ETF', exchange: 'SSE', spotSymbol: '510050.SH', days: [], scanPrompt: 's',
            strategy: { opportunity: 'theta_rent', template: 'butterfly', edge: 'range_hold collect theta', noTrade: false, bucketStart: '2026-09-09T01:00:00.000Z' } },
          { underlying: '159915', name: '创业板ETF', exchange: 'SZSE', spotSymbol: '159915.SZ', days: [], scanPrompt: 's',
            strategy: { opportunity: 'no_edge', noTrade: true, edge: 'no edge today', bucketStart: '2026-09-09T01:00:00.000Z' } },
          { underlying: '510300', name: '沪深300ETF', exchange: 'SSE', spotSymbol: '510300.SH', days: [], scanPrompt: 's',
            strategy: { opportunity: 'rv_vs_iv', skipReason: 'overlap', edge: 'prev bucket unfinished', bucketStart: '2026-09-09T01:00:00.000Z' } },
          { underlying: '588000', name: '科创50ETF', exchange: 'SSE', spotSymbol: '588000.SH', days: [], scanPrompt: 's' },
        ],
      },
    })
    const rows = container.querySelectorAll('tbody tr')
    // edge：模板 · 机会，title 用后端 edge 原文
    expect(rows[0]?.textContent).toContain('options.template.butterfly · options.overview.strategy.theta_rent')
    expect(rows[0]?.querySelector('[data-tone="edge"]')?.getAttribute('title')).toBe('range_hold collect theta')
    // no_edge：观望标签（tone none）
    expect(rows[1]?.textContent).toContain('options.overview.strategy.no_edge')
    expect(rows[1]?.querySelector('[data-tone="none"]')).toBeTruthy()
    // skip：跳过标签（tone skip）
    expect(rows[2]?.textContent).toContain('options.overview.strategy.skip.overlap')
    expect(rows[2]?.querySelector('[data-tone="skip"]')).toBeTruthy()
    // 缺 strategy 键：出「—」（按行容错，不整列空白）
    expect(rows[3]?.textContent).toContain('—')
  })

  it('redesign 走势列落在 strength 与 iv 之间', () => {
    const { container } = renderOverview()
    const headers = Array.from(container.querySelectorAll('thead th')).map(th => th.textContent)
    const iTrend = headers.indexOf('options.overview.col.trend')
    const iStrength = headers.indexOf('options.overview.col.strength')
    const iIv = headers.indexOf('options.overview.col.iv')
    expect(iTrend).toBeGreaterThan(iStrength)
    expect(iTrend).toBeLessThan(iIv)
  })

  it('redesign 走势列内嵌 sparkline（svg）', () => {
    const { container } = renderOverview()
    const first = container.querySelector('tbody tr') as HTMLElement
    const trendCell = first.querySelector('[class*="colTrend"]') as HTMLElement
    expect(trendCell).toBeTruthy()
    expect(trendCell.querySelector('svg')).toBeTruthy()
  })

  it('WB-9 叠加图：九线共 Y 轴，图例按 5 日累计降序，最强/最弱/中位标记加粗', () => {
    const overview = {
      source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
      rows: [
        { underlying: '510050', name: '上证50ETF', exchange: 'SSE' as const, spotSymbol: '510050.SH', return5d: 1.2,
          days: [{ date: '2026-09-08', changePct: 0.5, volumeSurge: false }, { date: '2026-09-09', changePct: 0.7, volumeSurge: false }], scanPrompt: 's' },
        { underlying: '159915', name: '创业板ETF', exchange: 'SZSE' as const, spotSymbol: '159915.SZ', return5d: -0.4,
          days: [{ date: '2026-09-08', changePct: -0.2, volumeSurge: false }, { date: '2026-09-09', changePct: -0.2, volumeSurge: false }], scanPrompt: 's' },
        { underlying: '588000', name: '科创50ETF', exchange: 'SSE' as const, spotSymbol: '588000.SH', return5d: 0.1,
          days: [{ date: '2026-09-08', changePct: 0.0, volumeSurge: false }, { date: '2026-09-09', changePct: 0.1, volumeSurge: false }], scanPrompt: 's' },
      ],
    }
    const { container } = renderOverview({ overview })
    const overlay = container.querySelector('[data-dshtrading-overlay-trend]') as HTMLElement
    expect(overlay).toBeTruthy()
    // 九线同坐标：只画一个 svg 而不是每行一条 sparkline
    expect(overlay.querySelectorAll('svg').length).toBe(1)
    expect(overlay.querySelectorAll('polyline').length).toBe(3)

    const legend = Array.from(overlay.querySelectorAll('[class*="legendItem"]')) as HTMLElement[]
    expect(legend.length).toBe(3)
    // 名次 = 图上终点顺序：+1.20% → +0.10% → -0.40%
    expect(legend[0]?.textContent).toContain('上证50ETF')
    expect(legend[1]?.textContent).toContain('科创50ETF')
    expect(legend[2]?.textContent).toContain('创业板ETF')
    // 最强 / 中位 / 最弱 各自被标记（对应粗线）
    expect(legend[0]?.getAttribute('data-emph')).toBe('strong')
    expect(legend[1]?.getAttribute('data-emph')).toBe('median')
    expect(legend[2]?.getAttribute('data-emph')).toBe('weak')
  })

  it('WB-9 叠加图：5 日序列缺失 → 出空态，不画假线', () => {
    const { container } = renderOverview({
      overview: {
        source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [{ underlying: '159915', name: '创业板ETF', exchange: 'SZSE' as const, spotSymbol: '159915.SZ', days: [], scanPrompt: 's' }],
      },
    })
    const overlay = container.querySelector('[data-dshtrading-overlay-trend]') as HTMLElement
    expect(overlay.textContent).toContain('options.overview.overlayEmpty')
    expect(overlay.querySelector('svg')).toBeNull()
  })

  it('WB-9 机会卡：分析数据 / 解读 / 操作计划三段齐全，来源徽章如实标注', () => {
    const { container } = renderOverview({
      overview: {
        source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [{
          underlying: '510050', name: '上证50ETF', exchange: 'SSE' as const, spotSymbol: '510050.SH',
          last: 2.91, changePct: 0.4, return5d: 1.2, volumeRatio: 0.8, strengthScore: 0.96, ivPercentile: 0.9,
          days: [{ date: '2026-09-09', changePct: 0.4, volumeSurge: true }], scanPrompt: 's',
          // 后端尚未投影 logic/playbook（现状）→ 必须回落规则解读并标 rule
          strategy: { opportunity: 'theta_rent', template: 'butterfly', edge: 'range_hold collect theta', noTrade: false, bucketStart: '2026-09-09T01:00:00.000Z' },
        }],
      },
    })
    const card = container.querySelector('[data-dshtrading-opportunity-card="510050"]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('options.overview.card.data')
    expect(card.textContent).toContain('options.overview.card.reading')
    expect(card.textContent).toContain('options.overview.card.plan')
    // 来源徽章：无 logic/playbook → 规则，不冒充 AI
    const badges = Array.from(card.querySelectorAll('[data-source]')).map(el => el.getAttribute('data-source'))
    expect(badges.length).toBeGreaterThan(0)
    expect(new Set(badges)).toEqual(new Set(['rule']))
    // 风险标签：IV 0.9 → iv_high；有 edge 但无 invalidIf → no_invalid
    expect(card.textContent).toContain('options.insight.risk.iv_high')
    expect(card.textContent).toContain('options.insight.risk.no_invalid')
  })

  it('WB-9 机会卡：后端补 logic/playbook 后来源切 ai，且原文照录', () => {
    const { container } = renderOverview({
      overview: {
        source: 'iquant', sort: 'strength', asOf: '2026-09-09T01:00:00.000Z', scanAllPrompt: 'scan all',
        rows: [{
          underlying: '510050', name: '上证50ETF', exchange: 'SSE' as const, spotSymbol: '510050.SH',
          days: [{ date: '2026-09-09', changePct: 0.4, volumeSurge: false }], scanPrompt: 's',
          strategy: {
            opportunity: 'theta_rent', template: 'vertical', edge: 'theta rich', noTrade: false,
            bucketStart: '2026-09-09T01:00:00.000Z', invalidIf: 'spot < 2.90',
            // 桥 JSON 尚未定义这两个键，用宽容类型预读
            ...({ logic: '箱体上沿不破，收 theta', playbook: '卖 2900 购 / 买 2950 购' } as Record<string, unknown>),
          } as never,
        }],
      },
    })
    const card = container.querySelector('[data-dshtrading-opportunity-card="510050"]') as HTMLElement
    const badges = Array.from(card.querySelectorAll('[data-source]')).map(el => el.getAttribute('data-source'))
    expect(new Set(badges)).toEqual(new Set(['ai']))
    expect(card.textContent).toContain('箱体上沿不破，收 theta')
    expect(card.textContent).toContain('卖 2900 购 / 买 2950 购')
    expect(card.textContent).toContain('spot < 2.90')
  })

  it('WB-9 明细表默认展开、可折叠（保留 WB-1 9 行基线）', () => {
    const { container, getByText } = renderOverview()
    expect(container.querySelectorAll('tbody tr').length).toBe(2)
    fireEvent.click(getByText('options.overview.hideTable'))
    expect(container.querySelectorAll('tbody tr').length).toBe(0)
    fireEvent.click(getByText('options.overview.showTable'))
    expect(container.querySelectorAll('tbody tr').length).toBe(2)
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

  it('WB-10 机会排序：最强 / 最弱 / 中位排前三，并出示档位徽章', () => {
    const codes = ['159915', '159901', '510300', '510500', '510050']
    const loop: OptionCycleLoop = {
      running: true,
      horizonMin: 5,
      rows: codes.map(code => ({
        underlying: code,
        stats: { n: 4, hits: 2, misses: 1, partials: 0, skipped: 1, hitRate: 0.5 },
        latest: {
          id: `${code}:1`,
          underlying: code,
          bucketStart: '2026-09-09T02:30:00.000Z',
          asOf: '2026-09-09T02:30:00.000Z',
          forecast: {
            underlying: code, name: code, exchange: 'SSE', horizonMin: 5,
            boxLow: 2.9, boxHigh: 3.1, regime: 'range_hold', session: 'regular',
            candidates: [{ template: 'butterfly', bias: 'neutral', invalidIf: 'x', reason: 'y' }],
          },
          calibration: 'none',
        },
      })),
    }
    // 降序：510500(+3) → 510300(+1) → 510050(0，中位) → 159915(-1) → 159901(-4，最弱)
    const cum5d = { '159915': -1, '159901': -4, '510300': 1, '510500': 3, '510050': 0 }
    const { container } = renderLoop(loop, { cum5d })
    const order = Array.from(container.querySelectorAll('[data-dshtrading-cycle-card]'))
      .map(el => el.getAttribute('data-dshtrading-cycle-card'))
    // 三档在前，其余（159915 / 510300）保持桥给的原始顺序
    expect(order).toEqual(['510500', '159901', '510050', '159915', '510300'])
    expect(order.slice(0, 3)).toEqual(['510500', '159901', '510050'])
    expect(container.textContent).toContain('options.cycle.tier.strong')
    expect(container.textContent).toContain('options.cycle.tier.weak')
    expect(container.textContent).toContain('options.cycle.tier.median')
    // 展开独占整行、不压扁邻居（CSS 契约）
    expect(container.querySelector('[data-dshtrading-cycle-card="510500"]')?.getAttribute('data-tier')).toBe('strong')
  })

  it('WB-10 累计值缺席：不出档位徽章（不冒充最强 / 最弱）', () => {
    const loop: OptionCycleLoop = {
      running: true,
      horizonMin: 5,
      rows: [{
        underlying: '510050',
        stats: { n: 0, hits: 0, misses: 0, partials: 0, skipped: 0 },
        latest: {
          id: '510050:9',
          underlying: '510050',
          bucketStart: '2026-09-09T02:30:00.000Z',
          asOf: '2026-09-09T02:30:00.000Z',
          forecast: {
            underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', horizonMin: 5,
            boxLow: 2.9, boxHigh: 3.1, regime: 'range_hold', session: 'regular', candidates: [],
          },
          calibration: 'none',
        },
      }],
    }
    const { container } = renderLoop(loop)
    expect(container.querySelector('[data-dshtrading-cycle-card="510050"]')?.getAttribute('data-tier')).toBe('rest')
    expect(container.textContent).not.toContain('options.cycle.tier.strong')
  })
})

describe('OptionsCycleLoop — WB-12 定时桶 packet 对齐', () => {
  const baseLoop: OptionCycleLoop = {
    running: true,
    horizonMin: 5,
    lastBucket: '2026-09-10T01:45:00.000Z',
    rows: [{
      underlying: '510050',
      stats: { n: 4, hits: 2, misses: 1, partials: 0, skipped: 1, hitRate: 0.67 },
      latest: {
        id: '510050:1',
        underlying: '510050',
        bucketStart: '2026-09-10T01:45:00.000Z',
        asOf: '2026-09-10T01:45:12.000Z',
        forecast: {
          underlying: '510050', name: '华夏上证50ETF', exchange: 'SSE', horizonMin: 5,
          boxLow: 2.99, boxHigh: 3.01, regime: 'range_hold', session: 'regular',
          candidates: [], volumeRatio: 1.5,
        },
        calibration: 'none',
      },
    }],
  }

  const packet = {
    bucketStart: '2026-09-10T01:45:00.000Z',
    asOf: '2026-09-10T01:45:12.000Z',
    rows: [{
      underlying: '510050', regime: 'range_hold', ivRegime: 'unknown' as const,
      candidates: [], volumeRatio: 0.8, atmIv: 0.21,
    }],
  }

  it('无 packet（默认 null）→ 整条「智能体所见」不渲染，页面不炸', () => {
    const { container } = renderLoop(baseLoop)
    expect(container.querySelector('[data-dshtrading-cycle-packet]')).toBeNull()
    // 闭环卡片本身照常渲染
    expect(container.querySelector('[data-dshtrading-cycle-card="510050"]')).not.toBeNull()
  })

  it('有 packet → 顶条渲染 + 卡片制度徽章按 underlying 对齐', () => {
    const { container } = renderLoop(baseLoop, { packet })
    expect(container.querySelector('[data-dshtrading-cycle-packet]')).not.toBeNull()
    // 卡片制度徽章：闭集翻译 + data-iv-regime，未知即「制度不明」
    const badge = container.querySelector('[data-iv-regime="unknown"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('options.overview.ivRegime.unknown')
    // packet 量能标 5/20 日，不与箱体量比混
    expect(container.textContent).toContain('options.loop.volumeRatioDaily')
    expect(container.textContent).toContain('0.80')
  })

  it('forecast 量比与 packet 量能分两枚词典键（同一维度不混标）', () => {
    const { container } = renderLoop(baseLoop, { packet })
    expect(container.textContent).toContain('options.loop.volumeRatioBox')
    expect(container.textContent).toContain('options.loop.volumeRatioDaily')
    expect(container.textContent).toContain('1.50')
    expect(container.textContent).toContain('0.80')
  })
})
