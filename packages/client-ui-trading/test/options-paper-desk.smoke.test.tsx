/**
 * 纸账户执行台渲染冒烟（2026-09-13）。
 *
 * 本节的核心语义与 detected opportunities 相反：**空数据不隐藏**。要锁的静默失真：
 * - 零成交/全 skipped 的工作台被整节隐藏 → 「零成交」这个诊断信号就看不见了；
 * - 记录缺口（gapBuckets>0）不标警示 → 2026-09-10 那种「有候选无 fill」的链路
 *   缺口会被当成正常日子扫过去；
 * - skip 词表映射失败炸渲染 → 流水/日级表整节消失。
 * 用 jsdom 真挂载锁这三类；断言用 i18n key 直出（与词典解耦）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { OptionPaperDesk } from '@dshtrading/api'
import { OptionsPaperDesk } from '../src/client/OptionsPaperDesk.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey, _params?: Record<string, unknown>): string => key

afterEach(() => {
  cleanup()
})

const ACCOUNT = {
  currency: 'CNY' as const,
  initialCash: 100000,
  cash: 100000,
  realizedPnl: 0,
  updatedAt: '2026-09-10T15:02:51.060Z',
}

/** 2026-09-10 事故形状：7 候选 / 0 成交 / 7 记录缺口，全 skipped 打分。 */
const DESK: OptionPaperDesk = {
  account: ACCOUNT,
  equity: 100000,
  positions: [],
  dayCount: 2,
  days: [
    {
      date: '2026-09-11',
      candidates: 4,
      filled: 0,
      gapBuckets: 0,
      skipReasons: { session: 85, overlap: 15 },
      paperSkips: { no_quote: 4 },
      verdicts: { hit: 0, partial: 0, miss: 0, skipped: 1013 },
      scored: 0,
    },
    {
      date: '2026-09-10',
      candidates: 7,
      filled: 0,
      gapBuckets: 7,
      skipReasons: { session: 97, overlap: 15 },
      paperSkips: {},
      verdicts: { hit: 0, partial: 0, miss: 0, skipped: 1253 },
      scored: 0,
    },
  ],
  recentFills: [
    {
      id: '2026-09-11T02:30:00.000Z:skip:no_quote',
      bucketStart: '2026-09-11T02:30:00.000Z',
      asOf: '2026-09-11T02:37:39.326Z',
      underlying: '510050',
      template: 'vertical',
      offset: 'open',
      qty: 0,
      legs: [],
      premiumCny: 0,
      marginCny: 0,
      cashAfter: 100000,
      reason: 'skipped',
      skip: 'no_quote',
    },
  ],
  asOf: '2026-09-13T06:00:00.000Z',
}

describe('OptionsPaperDesk', () => {
  it('未加载 / 失败 → notice 文案；suppressNotice 只静默 notice', () => {
    const loading = render(<OptionsPaperDesk t={t} desk={null} failure={null} loaded={false} />)
    expect(loading.getByText('options.desk.loading')).toBeTruthy()
    loading.unmount()

    const failed = render(<OptionsPaperDesk t={t} desk={null} failure={{ code: 'X', message: 'm' }} loaded />)
    expect(failed.getByText('options.desk.unavailable')).toBeTruthy()
    expect(failed.getByText('X: m')).toBeTruthy()
    failed.unmount()

    const suppressed = render(<OptionsPaperDesk t={t} desk={null} failure={{ code: 'X', message: 'm' }} loaded suppressNotice />)
    expect(suppressed.container.textContent).toBe('')
  })

  it('零成交/全 skipped 的工作台照常渲染：09-10 形状 7 候选 0 成交 7 缺口可见', () => {
    const { container, getByText } = render(<OptionsPaperDesk t={t} desk={DESK} failure={null} loaded />)
    expect(container.querySelector('[data-dshtrading-paper-desk]')).toBeTruthy()
    const gapRow = container.querySelector('[data-dshtrading-paper-desk-day="2026-09-10"]') as HTMLElement
    expect(gapRow.getAttribute('data-gap')).toBe('7')
    expect(gapRow.textContent).toContain('7')
    // 账户条六项指标 + 权益
    expect(getByText('options.desk.account.equity')).toBeTruthy()
    // 09-11 行：no_quote 纸账跳过词 + 全 skipped 打分串
    const skipRow = container.querySelector('[data-dshtrading-paper-desk-day="2026-09-11"]') as HTMLElement
    expect(skipRow.textContent).toContain('options.desk.paperskip.no_quote')
    expect(skipRow.textContent).toContain('0/0/0/1013')
  })

  it('近期流水：skip 桩行出标的与词表键；空流水出占位不炸', () => {
    const withFills = render(<OptionsPaperDesk t={t} desk={DESK} failure={null} loaded />)
    expect(withFills.getByText('510050')).toBeTruthy()
    expect(withFills.getByText('options.desk.paperskip.no_quote')).toBeTruthy()
    withFills.unmount()

    const empty = render(
      <OptionsPaperDesk
        t={t}
        desk={{ ...DESK, days: [], recentFills: [], dayCount: 0 }}
        failure={null}
        loaded
      />,
    )
    expect(empty.container.querySelector('[data-dshtrading-paper-desk]')).toBeTruthy()
    expect(empty.getByText('options.desk.fills.title')).toBeTruthy()
  })
})
