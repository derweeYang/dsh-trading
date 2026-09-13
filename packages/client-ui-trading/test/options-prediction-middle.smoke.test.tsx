/**
 * OptionsPredictionMiddleView 轮询加固渲染冒烟（P2-9，2026-09-12）。
 *
 * 钉死两件事：
 * - 跟踪回溯取数**带 limit**：桥契约明确「limit 仅约束返回的预测条数（统计仍按全量）」——
 *   不传则 30s 轮询每次都全量重取整段历史，载荷与重渲染成本随预测累积线性增长；
 * - 成功落地后给出「每 N 秒自动刷新 · 最后更新 HH:mm:ss」回执：轮询本身是隐形的，没有回执
 *   就无法区分「只是没新数据」与「压根没在刷新」。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { OptionPredictionTrack } from '@dshtrading/api'

/** 桥取数桩（vi.hoisted 规避 mock 提升 TDZ）。 */
const API = vi.hoisted(() => ({ board: vi.fn(), track: vi.fn() }))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchOptionPredictions: API.board,
    fetchOptionPredictionTrack: API.track,
  }
})

import { OptionsPredictionMiddleView } from '../src/client/OptionsPredictionMiddleView.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { StageViewProps } from '../src/client/stage-views.ts'

/** key 直出翻译 + 记录调用：断言文案键与插值参数（time / interval）。 */
const tCalls: { key: MarketLocaleKey; params?: Record<string, unknown> }[] = []
const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string => {
  tCalls.push(params === undefined ? { key } : { key, params })
  return key
}
const props: StageViewProps = { t, view: 'options-prediction' }

/** 最小合法 track 载荷（一条未回填预测 + 空矩阵）。 */
const TRACK: OptionPredictionTrack = {
  predictions: [{
    id: '510050:2026-09-15', underlying: '510050', asOfDate: '2026-09-12', targetDate: '2026-09-15',
    marketExpectation: 'consolidation', volExpectation: 'down', confidence: 0.5,
    factors: [], thesis: '缩量整理', evaluationMethod: '收盘涨跌幅 > +1% 判涨',
    createdAt: '2026-09-12T01:00:00.000Z',
  }],
  stats: {
    total: 1, scored: 0, marketHitRate: 0, volHitRate: 0, avgScore: 0,
    marketMatrix: {}, volMatrix: {},
  },
  knowledge: [],
}

beforeEach(() => {
  tCalls.length = 0
  // 看板走失败态即够（免造 board payload）；本用例只关心 track 链路
  API.board.mockResolvedValue({ ok: false, code: 'BOARD_DOWN', message: 'down' })
  API.track.mockResolvedValue({ ok: true, data: TRACK })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('OptionsPredictionMiddleView 轮询加固（P2-9）', () => {
  it('跟踪回溯取数带 limit（拦住 30s 轮询全量重取整段历史）', async () => {
    const { getByText } = render(<OptionsPredictionMiddleView {...props} />)

    fireEvent.click(getByText('options.prediction.tab.track'))

    await waitFor(() => { expect(API.track).toHaveBeenCalled() })
    // 无聚焦标的分支：只带 limit
    expect(API.track.mock.calls[0]?.[0]).toEqual({ limit: 50 })
  })

  it('成功落地后给出新鲜度回执，且次数 / 时间插值正确', async () => {
    const { getByText } = render(<OptionsPredictionMiddleView {...props} />)

    fireEvent.click(getByText('options.prediction.tab.track'))

    await waitFor(() => { expect(getByText('options.prediction.autoRefresh')).toBeTruthy() })
    const call = tCalls.find(item => item.key === 'options.prediction.autoRefresh')
    expect(call?.params?.interval).toBe('30')
    expect(String(call?.params?.time)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('看板页签的回执独立于跟踪回溯（各自成功才出现）', async () => {
    API.board.mockResolvedValue({ ok: false, code: 'BOARD_DOWN', message: 'down' })
    const { queryByText, getByText } = render(<OptionsPredictionMiddleView {...props} />)

    // 看板失败 → 无回执（失败没有「最后更新」可言）
    await waitFor(() => { expect(getByText('BOARD_DOWN: down')).toBeTruthy() })
    expect(queryByText('options.prediction.autoRefresh')).toBeNull()
  })
})
