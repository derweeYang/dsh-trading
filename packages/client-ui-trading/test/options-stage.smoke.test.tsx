/**
 * CN ETF 期权 T 板渲染冒烟（2026-09-08 第一期前端）。
 *
 * 与 quote-stage.smoke 同族：把 OptionsStage 真正 mount 进 jsdom，拦住
 * 「类型与构建全绿、一渲染就崩」——T 板是本期第一个纯新增页签，没有历史回归网。
 *
 * 覆盖：
 * - 有链：到期月胶囊选中态、T 表行权价列、认购/认沽最新价与 IV、快照行；
 * - 分诊：网关未起（TRADING_NETWORK）→ 提示起网关；无行情（TRADING_NO_DATA）→
 *   空态；首个应答在途 → 加载中，不闪「不可用」；
 * - 点击到期月胶囊 → onSelectMonth 回调（页签内换月不切标的）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { OptionChain, OptionExpiryMonth } from '@dshtrading/api'
import { OptionsStage } from '../src/client/OptionsStage.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

afterEach(() => {
  cleanup()
})

const MONTHS: OptionExpiryMonth[] = [
  { expiryMonth: '2609', expiryDate: '2026-09-23' },
  { expiryMonth: '2610', expiryDate: '2026-10-28' },
]

const CHAIN: OptionChain = {
  underlying: '510050',
  expiryMonth: '2609',
  expiryDate: '2026-09-23',
  snapshotAt: '2026-09-08T02:00:00+08:00',
  source: 'akshare',
  spot: 2.901,
  calls: [
    { code: '510050C2609M02850', strike: 2.85, last: 0.12, prevSettle: 0.11, changePct: 9.09, volume: 123, impliedVol: 0.2 },
    { code: '510050C2609M02900', strike: 2.9, last: 0.05, volume: 60 },
  ],
  puts: [
    { code: '510050P2609M02850', strike: 2.85, last: 0.08, changePct: -4.5, volume: 80, impliedVol: 0.23 },
  ],
}

function renderStage(overrides: Partial<React.ComponentProps<typeof OptionsStage>> = {}) {
  const onSelectMonth = vi.fn()
  const view = render(
    <OptionsStage
      t={t}
      months={MONTHS}
      selectedMonth="2609"
      onSelectMonth={onSelectMonth}
      chain={CHAIN}
      failure={null}
      loaded
      colorMode="red-up"
      underlyingSymbol="510050.SH"
      multiplier={10000}
      onViewSpot={() => {}}
      onTradeSpot={() => {}}
      {...overrides}
    />,
  )
  return { ...view, onSelectMonth }
}

describe('OptionsStage', () => {
  it('renders the T-board: expiry pills, strike column, call/put rows', () => {
    const { container, getByText, getByRole } = renderStage()
    // 到期月胶囊：选中态落在 2609（data-active 是真值，不是仅靠样式）
    const active = getByRole('tab', { selected: true })
    expect(active.textContent).toBe('2609')
    // 表头：认购 / 行权价 / 认沽
    expect(getByText('options.calls')).toBeTruthy()
    expect(getByText('options.strike')).toBeTruthy()
    expect(getByText('options.puts')).toBeTruthy()
    // 行权价升序两档（认沽只在 2.85 挂出 → 2.90 行认购侧有值、认沽侧为 —）
    // 只数 T 板表（data-dshtrading-options-t-table），避免把 WB-13 套利机会表也数进来。
    const tTable = container.querySelector('[data-dshtrading-options-t-table]')
    expect(tTable).toBeTruthy()
    const rows = tTable!.querySelectorAll('tbody tr')
    expect(rows.length).toBe(2)
    // 行权价列（第 5 列）升序；按列取而非 getByText——标的现价格式化后可能与档位同文案。
    const strikes = Array.from(tTable!.querySelectorAll('tbody tr td:nth-child(5)')).map(td => td.textContent)
    expect(strikes).toEqual(['2.85', '2.90'])
    // 最新价（第 4 列认购 / 第 6 列认沽）：期权价格 4 位小数（priceDigits <1 规则）；
    // IV 是小数 sigma → 百分比（0.2 → +20.00%）。
    const firstRow = tTable!.querySelector('tbody tr:nth-child(1)')
    expect(firstRow?.querySelector('td:nth-child(4)')?.textContent).toBe('0.1200')
    expect(firstRow?.querySelector('td:nth-child(6)')?.textContent).toBe('0.0800')
    expect(getByText('+20.00%')).toBeTruthy()
    // 快照行：标的现价 + 数据源（缺字段即隐藏，不补占位）
    expect(getByText('options.spot')).toBeTruthy()
    expect(getByText('akshare')).toBeTruthy()
  })

  it('selecting another expiry month reports the month (no symbol switch)', () => {
    const { getByText, onSelectMonth } = renderStage()
    fireEvent.click(getByText('2610'))
    expect(onSelectMonth).toHaveBeenCalledWith('2610')
  })

  it('triage: gateway down → start-gateway hint; upstream gap → empty state', () => {
    const down = renderStage({ chain: null, failure: { code: 'TRADING_NETWORK', message: 'boom' } })
    expect(down.getByText('options.network')).toBeTruthy()
    cleanup()

    const gap = renderStage({ chain: null, failure: { code: 'TRADING_NO_DATA', message: 'no data' } })
    expect(gap.getByText('options.noData')).toBeTruthy()
    cleanup()

    const other = renderStage({ chain: null, failure: { code: 'TRADING_UPSTREAM_ERROR', message: 'x' } })
    expect(other.getByText('options.unavailable')).toBeTruthy()
  })

  it('first response in flight shows loading, not "unavailable"', () => {
    const { getByText } = renderStage({ chain: null, loaded: false })
    expect(getByText('options.loading')).toBeTruthy()
  })

  it('empty chain (contract list empty) shows the empty-contract state', () => {
    const { getByText } = renderStage({
      chain: { underlying: '510050', expiryMonth: '2609', source: 'akshare', calls: [], puts: [] },
    })
    expect(getByText('options.empty')).toBeTruthy()
  })
})
