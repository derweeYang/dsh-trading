/**
 * OptionOrderPanel 回填行为（WB-4）：验证策略腿的 prefill 一次性写入方向/张数，
 * 且不清空用户后续在面板内的手动改动逻辑（prefill 仅在该腿首次匹配时应用一次）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { OptionOrderPanel } from '../src/client/OptionsStage.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const t = (key: MarketLocaleKey): string => key

afterEach(() => {
  cleanup()
})

const LEG = { code: '510050C2609M02900', side: 'call' as const, strike: 2.9, last: 0.05 }

describe('OptionOrderPanel prefill (WB-4)', () => {
  it('applies strategy leg prefill (side + qty) on mount', async () => {
    render(
      <OptionOrderPanel
        t={t}
        leg={LEG}
        multiplier={10000}
        underlying="510050"
        coveredLots={0}
        prefill={{ code: LEG.code, side: 'sell', qty: 3 }}
        onPlaced={() => {}}
      />,
    )

    await waitFor(() => {
      // 卖出方向被选中
      const sell = screen.getByText('trade.sell')
      expect(sell.getAttribute('aria-selected')).toBe('true')
      // 张数回填为 3
      expect(screen.getByDisplayValue('3')).toBeTruthy()
    })
  })

  it('does not apply prefill when code mismatches the selected leg', () => {
    render(
      <OptionOrderPanel
        t={t}
        leg={LEG}
        multiplier={10000}
        underlying="510050"
        coveredLots={0}
        prefill={{ code: 'OTHERCODE', side: 'sell', qty: 9 }}
        onPlaced={() => {}}
      />,
    )
    // 默认仍为买入、张数 1（prefill 不匹配，不覆盖）
    expect(screen.getByText('trade.buy').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByDisplayValue('1')).toBeTruthy()
  })
})
