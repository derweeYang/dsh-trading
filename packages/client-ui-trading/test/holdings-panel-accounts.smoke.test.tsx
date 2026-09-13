/**
 * 资产面板「所有账户」可见性冒烟（2026-09-13 WB-17）。
 *
 * @vitest-environment jsdom
 *
 * 这里守的不是「崩」，而是**接进页签的账户悄悄掉线**：期权双账本
 * （strategy 策略 / arbitrage 套利，各 ¥10 万）由 2026-09-13 的
 * `feat/option-paper-books` 合并带入资产面板第 6 页签。若有人动
 * `TAB_LABEL_KEY` 或渲染分支，`OptionPaperBooks` 自己的用例照样全绿，
 * 而界面上「期权账户」已经没了——资产面板就看不见账户了。
 *
 * 真挂载 HoldingsPanel（台账 store 与网络走桩），锁四条：
 * 1. 页签条六域齐全，「期权账户」在列；
 * 2. 点开后双账本卡都在（arbitrage 在前，与桥返回序一致）；
 * 3. 切 live 后期权账户仍在、两卡不丢（不受 tradeMode 影响，防「切 live 账本消失」伪故障）；
 * 4. 股票侧三源同屏：paper（本地撮合写入）/ live（台账桩）徽章都在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { HoldingsPanel } from '../src/client/HoldingsPanel.tsx'
import { paperTradingStore } from '../src/client/paper-trading-store.ts'

const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

// 台账 store 走桩：只要一行 live 持仓与一份空快照，用来证明「live 源」在面板里可见。
// 工厂被提升到 import 之前，故桩数据必须内联，不能引用模块级常量。
vi.mock('../src/client/holdings-store.ts', () => {
  const liveRow = {
    symbol: '510300',
    side: 'buy',
    size: 500,
    entryPrice: 3.9,
    timestamp: '2026-09-13T02:00:00.000Z',
    origin: 'live',
    kind: 'stock',
    market: 'cn',
    account: 'A-live',
  }
  const snapshot = { book: null, liveTagged: [liveRow], prices: {}, fx: null }
  return {
    holdingsDataStore: { subscribe: () => () => {}, getSnapshot: () => snapshot },
    holdingsBaseStore: { subscribe: () => () => {}, getSnapshot: () => 'CNY' },
    holdingsActions: {
      discard: vi.fn(), confirm: vi.fn(), remove: vi.fn(), add: vi.fn(), update: vi.fn(),
    },
    stagedHoldings: () => [],
    subscribeTradingEventsHoldings: () => () => {},
    reloadHoldingsBook: vi.fn(),
    refreshLiveTagged: vi.fn(),
    refreshM2mPrices: vi.fn(),
    refreshFx: vi.fn(),
    setHoldingsBaseCurrency: vi.fn(),
  }
})

const ACCOUNT_BASE = {
  currency: 'CNY',
  initialCash: 100_000,
  cash: 100_000,
  realizedPnl: 0,
  updatedAt: '2026-09-13T02:00:00.000Z',
}

/** 桥桩：期权双账本一条请求拉全；其余端点一律 404（面板应静默，不得抛）。 */
function stubFetch(): string[] {
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/options/paper/accounts')) {
      return json({
        ok: true,
        books: [
          { ok: true, book: 'arbitrage', account: { ...ACCOUNT_BASE, id: 'arbitrage' }, equity: 105_000, positions: [] },
          { ok: true, book: 'strategy', account: { ...ACCOUNT_BASE, id: 'strategy' }, equity: 100_000, positions: [] },
        ],
      })
    }
    if (url.includes('/options/paper/fills')) return json({ ok: true, fills: [] })
    return json({ ok: false, code: 'TRADING_PROTOCOL', message: `unexpected ${url}` }, 404)
  }) as unknown as typeof globalThis.fetch
  return calls
}

function renderPanel(): ReturnType<typeof render> {
  return render(<HoldingsPanel t={t} onClose={() => {}} />)
}

function tabLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="tab"]')].map(el => el.textContent ?? '')
}

/** 页签标签去掉尾部计数徽标（持仓页签带 live 行数，数字不属于标签文案）。 */
function tabKeys(container: HTMLElement): string[] {
  return tabLabels(container).map(label => label.replace(/\d+$/, ''))
}

async function openOptionTab(view: ReturnType<typeof render>): Promise<void> {
  const tabs = view.container.querySelectorAll('[role="tab"]')
  fireEvent.click(tabs[5] as HTMLElement)
  await waitFor(() => {
    expect(view.container.querySelector('[data-dshtrading-option-paper-books]')).not.toBeNull()
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

beforeEach(() => {
  window.localStorage.clear()
  paperTradingStore.resetAccount()
  stubFetch()
})

describe('资产面板 —— 所有账户入口', () => {
  it('页签条六域齐全，「期权账户」在列', () => {
    const view = renderPanel()
    const keys = tabKeys(view.container as HTMLElement)
    expect(keys).toHaveLength(6)
    expect(keys).toEqual([
      'trade.tab.positions',
      'trade.tab.summary',
      'trade.tab.orders',
      'trade.tab.fills',
      'trade.tab.balances',
      'trade.tab.optPaper',
    ])
  })

  it('点开「期权账户」→ 双账本卡都在，arbitrage 在前', async () => {
    const view = renderPanel()
    await openOptionTab(view)
    const cards = [...view.container.querySelectorAll('[data-opt-paper-book]')]
      .map(el => el.getAttribute('data-opt-paper-book'))
    expect(cards).toEqual(['arbitrage', 'strategy'])
  })

  it('切 live 后期权账户仍在、两卡不丢（不受 tradeMode 影响）', async () => {
    const view = renderPanel()
    await openOptionTab(view)

    const modeBtn = view.container.querySelector('[data-mode="paper"]')
    expect(modeBtn).not.toBeNull()
    fireEvent.click(modeBtn as HTMLElement)
    await waitFor(() => {
      expect(view.container.querySelector('[data-mode="live"]')).not.toBeNull()
    })

    expect(tabKeys(view.container as HTMLElement)[5]).toBe('trade.tab.optPaper')
    expect(view.container.querySelectorAll('[data-opt-paper-book]')).toHaveLength(2)
  })

  it('股票侧三源同屏：paper 与 live 徽章都在持仓行', async () => {
    paperTradingStore.placeOrder({
      symbol: '510050', side: 'buy', type: 'market', quantity: 100, currentPrice: 2.9, market: 'cn',
    })
    const view = renderPanel()
    await waitFor(() => {
      expect(view.container.querySelector('[data-origin="paper"]')).not.toBeNull()
    })
    expect(view.container.querySelector('[data-origin="live"]')).not.toBeNull()
  })
})
