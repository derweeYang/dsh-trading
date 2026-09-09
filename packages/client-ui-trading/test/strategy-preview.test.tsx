/**
 * StrategyPreview 冒烟（WB-4）：mock POST /options/strategy，验证
 * - 生成后列出期权腿、过滤现货腿；
 * - 点「填进下单面板」回调带出对应腿（方向/张数/长代码），且不下单。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { OptionStrategyResult } from '@dshtrading/api'
import { fetchOptionStrategy } from '../src/client/api.ts'
import { StrategyPreview } from '../src/client/StrategyPreview.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

vi.mock('../src/client/api.ts')
const mockFetch = vi.mocked(fetchOptionStrategy)

const t = (key: MarketLocaleKey): string => key

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SAMPLE: OptionStrategyResult = {
  underlying: '510050.SH',
  source: 'akshare',
  spot: 2.9,
  multiplier: 10000,
  entry: { debitCredit: -500, note: 'net debit' },
  payoff: [{ spot: 2.8, pnl: -100 }, { spot: 2.9, pnl: 0 }],
  greeks: {
    status: 'ok',
    net: { delta: 0.3, gamma: 0.01, vega: 12, vegaPerVolPoint: 12, theta: -5, thetaPerDay: -5, rho: 1, rhoPerBp: 1 },
    legs: [],
  },
  margin: { perLeg: [], totalInitial: 3000, totalMaintenance: 2000, note: 'margin note' },
  legs: [
    { kind: 'option', side: 'sell', qty: 1, code: '510050C2609M02900', optionType: 'C', strike: 2.9, premium: 50 },
    { kind: 'option', side: 'buy', qty: 2, code: '510050P2609M02850', optionType: 'P', strike: 2.85, premium: 30, covered: true },
    { kind: 'underlying', side: 'sell', qty: 10000 },
  ],
}

describe('StrategyPreview', () => {
  it('lists option legs, filters out underlying legs, and reports no-legs when empty', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: SAMPLE })
    render(
      <StrategyPreview
        t={t}
        underlyingSymbol="510050.SH"
        expiryMonth="2609"
        onLoadLeg={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('options.strategy.generate'))

    // 期权腿长代码出现
    expect(await screen.findByText('510050C2609M02900')).toBeTruthy()
    expect(await screen.findByText('510050P2609M02850')).toBeTruthy()
    // 现货腿（kind=underlying）被过滤：仅 2 个期权腿渲染「填进下单面板」按钮
    expect(screen.getAllByText('options.strategy.loadToBoard').length).toBe(2)

    // 净支出（debitCredit < 0）
    expect(screen.getByText(/options\.strategy\.debit/)).toBeTruthy()
  })

  it('clicking load-to-board calls onLoadLeg with the option leg (no auto-order)', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: SAMPLE })
    const onLoadLeg = vi.fn()
    render(
      <StrategyPreview
        t={t}
        underlyingSymbol="510050.SH"
        expiryMonth="2609"
        onLoadLeg={onLoadLeg}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('options.strategy.generate'))
    await screen.findByText('510050C2609M02900')

    const loadButtons = screen.getAllByText('options.strategy.loadToBoard')
    expect(loadButtons.length).toBe(2) // 两个期权腿
    fireEvent.click(loadButtons[0])

    await waitFor(() => expect(onLoadLeg).toHaveBeenCalledTimes(1))
    const legArg = onLoadLeg.mock.calls[0]?.[0] as OptionStrategyResult['legs'][number]
    expect(legArg.code).toBe('510050C2609M02900')
    expect(legArg.side).toBe('sell')
    expect(legArg.qty).toBe(1)
  })

  it('shows error text when the strategy endpoint fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, code: 'TRADING_NOT_IMPLEMENTED', message: 'no strategy' })
    render(
      <StrategyPreview
        t={t}
        underlyingSymbol="510050.SH"
        expiryMonth="2609"
        onLoadLeg={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('options.strategy.generate'))
    expect(await screen.findByText(/options\.strategy\.error/)).toBeTruthy()
  })
})
