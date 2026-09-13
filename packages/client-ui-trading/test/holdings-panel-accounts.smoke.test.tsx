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
  const importedRow = {
    id: 'hd-1', symbol: '510050', side: 'long', size: 100, entryPrice: 2.8,
    updatedAt: '2026-09-13T02:00:00.000Z', kind: 'stock', market: 'cn', account: '富途',
  }
  const snapshot = {
    book: { holdings: [importedRow] },
    liveTagged: [liveRow],
    prices: { 'cn:510300': 3.9, 'cn:510050': 3 },
    fx: { base: 'CNY', rates: { CNY: 1 }, asOf: 1, stale: false },
  }
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
    if (url.includes('/options/paper/desk')) {
      // 桥按 `{ ok, desk }` 包一层（与 overview/barPacket 同构），不是裸 OptionPaperDesk。
      return json({
        ok: true,
        desk: {
          account: { ...ACCOUNT_BASE, id: 'strategy' },
          equity: 100_000,
          positions: [],
          days: [],
          dayCount: 0,
          recentFills: [],
          asOf: '2026-09-13T02:00:00.000Z',
        },
      })
    }
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

  it('汇总页签逐子账户列出：股票三源 + 期权双账本，总资产 = 各行之和', async () => {
    // 三源都要有持仓——`byOrigin` 只含出现的来源，paper 空仓就没有这一行。
    paperTradingStore.placeOrder({
      symbol: '510050', side: 'buy', type: 'market', quantity: 100, currentPrice: 2.9, market: 'cn',
    })
    const view = renderPanel()
    fireEvent.click(view.container.querySelectorAll('[role="tab"]')[1] as HTMLElement) // 汇总
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-sub-account]').length).toBe(5)
    })

    const rows = [...view.container.querySelectorAll('[data-sub-account]')]
    expect(rows.map(el => el.getAttribute('data-sub-account'))).toEqual([
      'stock:paper', 'stock:live', 'stock:imported', 'option:arbitrage', 'option:strategy',
    ])
    // 口径必须可见地区分：股票侧是持仓市值，期权账本是含现金的权益
    expect(rows.map(el => el.getAttribute('data-basis')))
      .toEqual(['holdings', 'holdings', 'holdings', 'equity', 'equity'])
    expect(view.container.querySelector('[data-sub-account-basis-note]')).not.toBeNull()

    // 核心口径：总资产 === Σ 每个子账户（读 data-amount，不解析格式化文案）
    const total = Number(view.container.querySelector('[data-sub-account-total]')?.getAttribute('data-sub-account-total'))
    const sum = rows.reduce((acc, el) => acc + Number(el.getAttribute('data-amount')), 0)
    expect(sum).toBeCloseTo(total, 6)
    // 两个期权账本各 10 万确实进了总资产（否则等于只有股票三源）
    expect(total).toBeGreaterThanOrEqual(200_000)
  })

  it('期权账户页签同时给出双账本卡与执行台（desk 已自期权总览迁入）', async () => {
    const view = renderPanel()
    await openOptionTab(view)
    await waitFor(() => {
      expect(view.container.querySelector('[data-dshtrading-paper-desk]')).not.toBeNull()
    })
    // 账本卡与执行台同处一页：卡片答「有多少钱」，执行台答「执行链有没有断」
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
