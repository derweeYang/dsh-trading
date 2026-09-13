/**
 * 期权虚拟账户分区渲染冒烟（2026-09-13 WB-15）。
 *
 * @vitest-environment jsdom
 *
 * 这个分区的风险不是「崩」，而是**看着有数、其实是错的或旧的**：
 * - 桥缺席（本机没起宿主）时若画「权益 0」，等于把故障说成资产没了；
 * - 单账本重置若顺手把两个账本一起清，用户会丢掉没打算动的那个账本；
 * - 现货腿按「张」显示会被读成 20000 张合约（实为 20000 份 ETF）。
 * 这里用 jsdom 真挂载 + fetch 桩，把这三类锁住。
 *
 * 翻译函数与既有冒烟不同：此处带上 params（`key(a,b)`），因为
 * 「重置哪一本」「错误码是哪个」正是参数携带的信息，key 直出会把它们吃掉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { PaperFill, PaperPosition } from '@dshtrading/api'
import { OptionPaperBooks } from '../src/client/OptionPaperBooks.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

const BASE_ACCOUNT = {
  currency: 'CNY' as const, initialCash: 100_000, cash: 72_755.4, realizedPnl: 154.8,
  updatedAt: '2026-09-08T06:56:00.000Z',
}

const PARITY_POSITION: PaperPosition = {
  id: 'arb:parity:510050:2609:2850',
  underlying: '510050',
  template: 'parity',
  openedBucketStart: '2026-09-08T03:00:00.000Z',
  invalidIf: '',
  qty: 2,
  marginCny: 30_000,
  legs: [
    { code: '510050C2609M02850', side: 'buy', qty: 2, fillPrice: 0.05, priceSource: 'ask' },
    { code: '510050P2609M02850', side: 'sell', qty: 2, fillPrice: 0.0184, priceSource: 'bid' },
    { code: '510050', side: 'sell', qty: 20_000, fillPrice: 2.9, priceSource: 'spot', asset: 'spot', spotSymbol: '510050.SH' },
  ],
  book: 'arbitrage',
  expiryMonth: '2609',
  expiryDate: '2026-09-23',
  direction: 'buy_synthetic_sell_spot',
  strikes: [2.85],
  openEdgePerShare: 0.02072,
}

const ARB_FILL: PaperFill = {
  id: 'arb:parity:510050:2609:2850:close:2026-09-08T06:56:00.000Z',
  bucketStart: '2026-09-08T03:00:00.000Z',
  asOf: '2026-09-08T06:56:00.000Z',
  underlying: '510050',
  template: 'parity',
  offset: 'close',
  qty: 2,
  legs: [{ code: '510050C2609M02850', side: 'sell', qty: 2, fillPrice: 0.055, priceSource: 'bid' }],
  premiumCny: -57_188,
  marginCny: 0,
  cashAfter: 100_154.8,
  reason: 'arb_converge',
  feeCny: 12.6,
  book: 'arbitrage',
}

interface Harness {
  accounts: unknown
  fillsByBook: Record<'strategy' | 'arbitrage', unknown>
  resetResponse: unknown
  resetStatus: number
  calls: string[]
  confirms: string[]
  confirmAnswer: boolean
}

function stubFetch(h: Harness): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    h.calls.push(`${init?.method ?? 'GET'} ${url}`)
    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/options/paper/accounts')) return json(h.accounts)
    if (url.includes('/options/paper/fills')) {
      const book = url.includes('book=arbitrage') ? 'arbitrage' : 'strategy'
      return json(h.fillsByBook[book])
    }
    if (url.includes('/options/paper/reset')) return json(h.resetResponse, h.resetStatus)
    return json({ ok: false, code: 'TRADING_PROTOCOL', message: `unexpected ${url}` }, 404)
  }) as unknown as typeof globalThis.fetch
  vi.stubGlobal('confirm', (message: string) => {
    h.confirms.push(message)
    return h.confirmAnswer
  })
}

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    accounts: {
      ok: true,
      books: [
        { ok: true, book: 'arbitrage', account: { ...BASE_ACCOUNT, id: 'arbitrage' }, equity: 105_000, positions: [PARITY_POSITION] },
        { ok: true, book: 'strategy', account: { ...BASE_ACCOUNT, id: 'strategy', cash: 100_000, realizedPnl: 0 }, equity: 100_000, positions: [] },
      ],
    },
    fillsByBook: { strategy: { ok: true, fills: [] }, arbitrage: { ok: true, fills: [ARB_FILL] } },
    resetResponse: {
      ok: true, book: 'arbitrage',
      account: { ...BASE_ACCOUNT, id: 'arbitrage', cash: 100_000, realizedPnl: 0 }, equity: 100_000, positions: [],
    },
    resetStatus: 200,
    calls: [],
    confirms: [],
    confirmAnswer: true,
    ...overrides,
  }
}

async function renderBooks(h: Harness): Promise<ReturnType<typeof render>> {
  stubFetch(h)
  const view = render(<OptionPaperBooks t={t} />)
  await waitFor(() => { expect(view.container.querySelector('[data-opt-paper-book="arbitrage"]')).not.toBeNull() })
  return view
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('OptionPaperBooks —— 双账本卡', () => {
  it('两账本各出一卡，arbitrage 在前；权益/现金/初始资金/已实现/收益率五项齐全', async () => {
    const h = harness()
    const { container } = await renderBooks(h)
    // 分区标题与口径提示常驻（页签标签短，这里给全称）
    expect(container.textContent).toContain('trade.optPaper.title')
    expect(container.textContent).toContain('trade.optPaper.hint')
    const cards = Array.from(container.querySelectorAll('[data-opt-paper-book]'))
    expect(cards.map(c => c.getAttribute('data-opt-paper-book'))).toEqual(['arbitrage', 'strategy'])
    const arb = container.querySelector('[data-opt-paper-book="arbitrage"]') as HTMLElement
    expect(arb.textContent).toContain('trade.optPaper.cash')
    expect(arb.textContent).toContain('trade.optPaper.equity')
    expect(arb.textContent).toContain('trade.optPaper.initialCash')
    expect(arb.textContent).toContain('trade.optPaper.realized')
    expect(arb.textContent).toContain('trade.optPaper.returnRate')
    // 收益率 = (105000 − 100000)/100000 落到 data 钩子（确定性断言，不看文案格式）
    expect(arb.querySelector('[data-opt-paper-return]')?.getAttribute('data-opt-paper-return')).toBe('0.05')
    expect(arb.querySelector('[data-opt-paper-realized]')?.getAttribute('data-opt-paper-realized')).toBe('154.8')
    // 空账本出空态，不出假持仓
    const strat = container.querySelector('[data-opt-paper-book="strategy"]') as HTMLElement
    expect(strat.textContent).toContain('trade.optPaper.empty')
  })

  it('持仓卡带方向/结构/行权价/到期日/开仓边/保证金；临期 ≤3 天贴徽标', async () => {
    const h = harness({
      accounts: {
        ok: true,
        books: [{
          ok: true, book: 'arbitrage', account: { ...BASE_ACCOUNT, id: 'arbitrage' }, equity: 100_154.8,
          positions: [{ ...PARITY_POSITION, expiryDate: '2099-01-01', direction: undefined, openEdgePerShare: undefined, strikes: [2.8, 3.0] }],
        }],
      },
    })
    const { container } = await renderBooks(h)
    const row = container.querySelector('[data-opt-paper-position]') as HTMLElement
    expect(row.getAttribute('data-template')).toBe('parity')
    expect(row.textContent).toContain('trade.optPaper.template.parity')
    expect(row.textContent).toContain('trade.optPaper.col.strikes')
    expect(row.textContent).toContain('2.8–3')
    expect(row.textContent).toContain('trade.optPaper.col.openEdge')
    expect(row.textContent).toContain('trade.optPaper.col.margin')
    // 方向缺席 → 不出方向徽章（不编「方向不明」）
    expect(row.textContent).not.toContain('trade.optPaper.direction.')
    // 远月 → 无临期徽标；到期天数为正的大数（不写死具体天数，跨日跑也不脆）
    const days = Number(row.querySelector('[data-opt-paper-expiry-days]')?.getAttribute('data-opt-paper-expiry-days'))
    expect(days).toBeGreaterThan(1000)
    expect(row.textContent).not.toContain('trade.optPaper.expiring')
  })

  it('临期（≤3 天）持仓贴「临期」徽标', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000)
    const iso = `${String(soon.getFullYear())}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
    const h = harness({
      accounts: {
        ok: true,
        books: [{ ok: true, book: 'arbitrage', account: { ...BASE_ACCOUNT, id: 'arbitrage' }, equity: 100_000, positions: [{ ...PARITY_POSITION, expiryDate: iso }] }],
      },
    })
    const { container } = await renderBooks(h)
    const row = container.querySelector('[data-opt-paper-position]') as HTMLElement
    expect(row.textContent).toContain('trade.optPaper.expiring')
  })

  it('腿明细默认收起；展开后现货腿标「份」+ 现货全符号，期权腿标「张」+ 对手价来源', async () => {
    const h = harness()
    const { container } = await renderBooks(h)
    const row = container.querySelector('[data-opt-paper-position]') as HTMLElement
    expect(row.querySelectorAll('[data-leg-asset]').length).toBe(0)
    fireEvent.click(row.querySelector('[data-opt-paper-legs-toggle]') as HTMLElement)
    const legs = Array.from(row.querySelectorAll('[data-leg-asset]'))
    expect(legs.map(l => l.getAttribute('data-leg-asset'))).toEqual(['option', 'option', 'spot'])
    const spot = legs[2] as HTMLElement
    // 关键口径：现货腿单位是「份」，不乘乘数、不显示成张
    expect(spot.textContent).toContain('trade.optPaper.unit.share')
    expect(spot.textContent).toContain('510050.SH')
    expect(spot.textContent).toContain('20000')
    expect(legs[0]?.textContent).toContain('trade.optPaper.unit.contract')
    expect(legs[0]?.textContent).toContain('trade.optPaper.price.ask')
    expect(legs[1]?.textContent).toContain('trade.optPaper.price.bid')
    expect(legs[0]?.textContent).toContain('trade.buy')
  })
})

describe('OptionPaperBooks —— 成交流水', () => {
  it('默认策略账本；切套利账本重拉并按原因分档着色（收敛平 ≠ 破位平）', async () => {
    const h = harness()
    const { container } = await renderBooks(h)
    expect(container.querySelector('[data-opt-paper-fills-book="strategy"]')?.getAttribute('data-active')).toBe('true')
    expect(container.textContent).toContain('trade.optPaper.fills.empty')

    fireEvent.click(container.querySelector('[data-opt-paper-fills-book="arbitrage"]') as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-opt-paper-fill]')).not.toBeNull() })
    expect(h.calls.some(c => c.includes('fills?limit=') && c.includes('book=arbitrage'))).toBe(true)
    const fill = container.querySelector('[data-opt-paper-fill]') as HTMLElement
    expect(fill.getAttribute('data-fill-reason')).toBe('arb_converge')
    const badge = fill.querySelector('[data-reason-kind]') as HTMLElement
    expect(badge.getAttribute('data-reason-kind')).toBe('converge')
    expect(badge.textContent).toBe('trade.optPaper.reason.arb_converge')
    // 金额字段直接展示后端值（前端不换算）
    expect(fill.textContent).toContain('trade.optPaper.col.cashAfter')
    expect(fill.textContent).toContain('100154.80')
    expect(fill.textContent).toContain('trade.optPaper.col.fee')
  })

  it('成交腿可展开；无腿的成交按钮置灰（不给死按钮）', async () => {
    const noLegFill: PaperFill = { ...ARB_FILL, id: 'arb:stub:no-leg', legs: [], reason: 'arb_open', offset: 'open' }
    const h = harness({ fillsByBook: { strategy: { ok: true, fills: [] }, arbitrage: { ok: true, fills: [ARB_FILL, noLegFill] } } })
    const { container } = await renderBooks(h)
    fireEvent.click(container.querySelector('[data-opt-paper-fills-book="arbitrage"]') as HTMLElement)
    await waitFor(() => { expect(container.querySelectorAll('[data-opt-paper-fill]').length).toBe(2) })
    const fills = Array.from(container.querySelectorAll('[data-opt-paper-fill]')) as HTMLElement[]
    expect(fills[1]?.querySelector('[data-opt-paper-fill-toggle]')?.hasAttribute('disabled')).toBe(true)
    fireEvent.click(fills[0]?.querySelector('[data-opt-paper-fill-toggle]') as HTMLElement)
    expect(fills[0]?.querySelectorAll('[data-leg-asset]').length).toBe(1)
    expect(fills[0]?.querySelector('[data-reason-kind]')?.getAttribute('data-reason-kind')).toBe('converge')
    expect(fills[1]?.querySelector('[data-reason-kind]')?.getAttribute('data-reason-kind')).toBe('open')
  })
})

describe('OptionPaperBooks —— 重置与失败诚实', () => {
  it('二次确认取消 → 不发 POST；确认 → 只重置该账本，卡片就地换新快照', async () => {
    const h = harness({ confirmAnswer: false })
    const { container } = await renderBooks(h)
    fireEvent.click(container.querySelector('[data-opt-paper-reset="arbitrage"]') as HTMLElement)
    await Promise.resolve()
    expect(h.confirms.length).toBe(1)
    // 确认文案带上账本名（防止「重置」按错账本还不自知）
    expect(h.confirms[0]).toBe('trade.optPaper.resetConfirm(trade.optPaper.book.arbitrage)')
    expect(h.calls.some(c => c.startsWith('POST'))).toBe(false)

    h.confirmAnswer = true
    fireEvent.click(container.querySelector('[data-opt-paper-reset="arbitrage"]') as HTMLElement)
    await waitFor(() => {
      expect(container.querySelector('[data-opt-paper-book="arbitrage"] [data-opt-paper-return]')?.getAttribute('data-opt-paper-return')).toBe('0')
    })
    const posts = h.calls.filter(c => c.startsWith('POST'))
    expect(posts).toEqual(['POST /dshtrading/api/options/paper/reset?book=arbitrage'])
    // 另一个账本不被牵连（策略卡仍在）
    expect(container.querySelector('[data-opt-paper-book="strategy"]')).not.toBeNull()
  })

  it('重置失败 → 出重置失败提示，不假装已归零', async () => {
    const h = harness({
      resetResponse: { ok: false, code: 'TRADING_PAPER_RESET_FAILED', message: 'disk full' },
    })
    const { container } = await renderBooks(h)
    fireEvent.click(container.querySelector('[data-opt-paper-reset="arbitrage"]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('trade.optPaper.resetFailed') })
    expect(container.querySelector('[data-opt-paper-return]')?.getAttribute('data-opt-paper-return')).toBe('0.05')
  })

  it('桥缺席 → 错误码原文上台，不画「权益 0」', async () => {
    const h = harness({
      accounts: { ok: false, code: 'TRADING_NETWORK', message: 'gateway down' },
    })
    stubFetch(h)
    const { container } = render(<OptionPaperBooks t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-opt-paper-failure]')).not.toBeNull() })
    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.getAttribute('data-opt-paper-failure')).toBe('TRADING_NETWORK')
    expect(alert.textContent).toContain('TRADING_NETWORK')
    expect(container.querySelector('[data-opt-paper-book]')).toBeNull()
  })

  it('免责声明常驻分区底部', async () => {
    const h = harness()
    const { container } = await renderBooks(h)
    expect(container.textContent).toContain('trade.optPaper.disclaimer')
    expect(container.querySelector('[data-dshtrading-option-paper-books]')).not.toBeNull()
  })
})
