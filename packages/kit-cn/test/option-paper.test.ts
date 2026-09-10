import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionBarRecommendation, OptionChain, OptionIntradayBoxRow } from '@dshtrading/api'
import {
  OPTION_PAPER_INITIAL_CASH,
  applyClose,
  applyOpen,
  completeVerticalLegs,
  decidePaperOpen,
  emptyPaperAccount,
  hasSuccessfulOpen,
  invalidIfTriggered,
  loadPaperState,
  premiumCny,
  quoteFillPrice,
  quoteFillPriceWithSource,
  resetPaperState,
  savePaperState,
  sizeQty,
  tryPaperManage,
  tryPaperOpen,
} from '../src/option-paper.js'
import {
  paperAccountPath,
  paperFillsPath,
  paperPositionsPath,
} from '../src/option-bar-ledger.js'

const chain: OptionChain = {
  underlying: '588000',
  expiryMonth: '2609',
  source: 'iquant',
  spot: 1.668,
  calls: [
    { code: '588000C2609M01650', strike: 1.65, last: 0.08 },
    { code: '588000C2609M01700', strike: 1.7, last: 0.0566 },
    { code: '588000C2609M01750', strike: 1.75, last: 0.0348 },
  ],
  puts: [],
}

const box: OptionIntradayBoxRow = {
  underlying: '588000',
  name: '科创50',
  exchange: 'SSE',
  horizonMin: 5,
  regime: 'mean_revert',
  session: 'regular',
  boxLow: 1.66,
  boxHigh: 1.67,
  candidates: [{ template: 'vertical', bias: 'down', invalidIf: '1-minute close breaks Donchian on volumeRatio>=1.5', reason: 'x' }],
}

function liveRec(over: Partial<OptionBarRecommendation> = {}): OptionBarRecommendation {
  return {
    bucketStart: '2026-09-10T05:40:00.000Z',
    asOf: '2026-09-10T05:40:23.000Z',
    session: 'regular',
    opportunity: 'mean_reversion',
    edge: 'x',
    logic: 'x',
    playbook: 'x',
    invalidIf: '1-minute close breaks Donchian on volumeRatio>=1.5',
    picks: [{ underlying: '588000', regime: 'mean_revert', template: 'vertical', cycleId: '588000:1' }],
    noTrade: false,
    ...over,
  }
}

describe('option-paper', () => {
  it('empty account is 100000 CNY', () => {
    expect(emptyPaperAccount('t').cash).toBe(OPTION_PAPER_INITIAL_CASH)
    expect(emptyPaperAccount('t').initialCash).toBe(100_000)
  })

  it('quoteFillPrice prefers last then prevSettle', () => {
    expect(quoteFillPrice({ code: 'x', strike: 1, last: 0.05 }, 'buy')).toBe(0.05)
    expect(quoteFillPrice({ code: 'x', strike: 1, prevSettle: 0.04 }, 'sell')).toBe(0.04)
    expect(quoteFillPrice({ code: 'x', strike: 1 }, 'buy')).toBeUndefined()
  })

  it('quoteFillPriceWithSource marks last / prev_settle and rejects bad rows', () => {
    expect(quoteFillPriceWithSource({ code: 'x', strike: 1, last: 0.05 })).toEqual({ price: 0.05, source: 'last' })
    expect(quoteFillPriceWithSource({ code: 'x', strike: 1, prevSettle: 0.04 })).toEqual({ price: 0.04, source: 'prev_settle' })
    expect(quoteFillPriceWithSource({ code: 'x', strike: 1, last: 0.05, prevSettle: 0.04 })?.source).toBe('last')
    expect(quoteFillPriceWithSource({ code: 'x', strike: 1, last: -1, prevSettle: 0.04 })?.source).toBe('prev_settle')
    expect(quoteFillPriceWithSource({ code: 'x', strike: 1 })).toBeUndefined()
  })

  it('completeVerticalLegs down is bear call spread', () => {
    const out = completeVerticalLegs(chain, 'down', 1)
    expect(out.skip).toBeUndefined()
    expect(out.legs.map((l) => `${l.side}:${l.code}`)).toEqual([
      'sell:588000C2609M01700',
      'buy:588000C2609M01750',
    ])
    expect(out.legs.every((leg) => leg.priceSource === 'last')).toBe(true)
  })

  it('sizeQty respects maxContracts and cash', () => {
    expect(sizeQty(10, 100_000, 218, 282)).toBe(10)
    expect(sizeQty(10, 400, 218, 282)).toBe(0)
    expect(sizeQty(undefined, 100_000, 218, 282)).toBe(1)
  })

  it('decidePaperOpen stubs are noop', () => {
    const r = decidePaperOpen({
      rec: liveRec({ noTrade: true, opportunity: 'no_edge', picks: [] }),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
    })
    expect('noop' in r).toBe(true)
  })

  it.each(['close5', 'closed'] as const)('decidePaperOpen %s session is noop', (session) => {
    const r = decidePaperOpen({
      rec: liveRec({ session }),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
    })
    expect('noop' in r).toBe(true)
  })

  it('duplicate_bucket after successful open', () => {
    const first = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
    })
    expect('fill' in first).toBe(true)
    const opened = applyOpen(
      { account: emptyPaperAccount('t'), positions: [], fills: [] },
      { ...first.fill, id: '1' } as never,
    )
    const second = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: opened.fills,
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: opened.account.cash,
    })
    expect('skip' in second && second.skip.skip === 'duplicate_bucket').toBe(true)
  })

  it('no_quote when chain missing', () => {
    const r = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => undefined,
      marginFor: () => 0,
      nowIso: 't',
      cash: 100_000,
    })
    expect('skip' in r && r.skip.skip === 'no_quote').toBe(true)
  })

  it('butterfly without explicit priced legs is no_quote', () => {
    const butterflyBox = {
      ...box,
      candidates: [{ ...box.candidates[0]!, template: 'butterfly' as const, bias: 'neutral' as const }],
    }
    const r = decidePaperOpen({
      rec: liveRec({
        opportunity: 'theta_rent',
        picks: [{ underlying: '588000', regime: 'mean_revert', template: 'butterfly', cycleId: '588000:1' }],
      }),
      forecastByUnderlying: { '588000': butterflyBox },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
    })
    expect('skip' in r && r.skip.skip === 'no_quote').toBe(true)
  })

  it('explicit leg ratios are multiplied by combo size', () => {
    const butterflyBox = {
      ...box,
      candidates: [{ ...box.candidates[0]!, template: 'butterfly' as const, bias: 'neutral' as const }],
    }
    const r = decidePaperOpen({
      rec: liveRec({
        opportunity: 'theta_rent',
        picks: [{
          underlying: '588000',
          regime: 'mean_revert',
          template: 'butterfly',
          cycleId: '588000:1',
          maxContracts: 2,
          legs: [
            { code: 'L1', side: 'buy', qty: 1, last: 0.01 },
            { code: 'L2', side: 'sell', qty: 2, last: 0.02 },
            { code: 'L3', side: 'buy', qty: 1, last: 0.01 },
          ],
        }],
      }),
      forecastByUnderlying: { '588000': butterflyBox },
      fillsToday: [],
      chainFor: () => undefined,
      marginFor: () => 100,
      nowIso: 't',
      cash: 100_000,
    })
    expect('fill' in r && r.fill.qty).toBe(2)
    expect('fill' in r ? r.fill.legs.map((leg) => leg.qty) : []).toEqual([2, 4, 2])
    // fee 按每腿张数合计：1.7 × (2+4+2) = 13.6；模型自报价腿标 pick。
    expect('fill' in r && r.fill.feeCny).toBeCloseTo(13.6, 10)
    expect('fill' in r ? r.fill.legs.every((leg) => leg.priceSource === 'pick') : false).toBe(true)
  })

  it('decidePaperOpen fee defaults to 1.7 per contract across legs', () => {
    const r = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
    })
    // vertical qty=1 → 2 张 × 1.7 = 3.4；链补腿标 last。
    expect('fill' in r && r.fill.feeCny).toBeCloseTo(3.4, 10)
    expect('fill' in r ? r.fill.legs.every((leg) => leg.priceSource === 'last') : false).toBe(true)
  })

  it('decidePaperOpen feePerContract 0 omits feeCny', () => {
    const r = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
      feePerContract: 0,
    })
    expect('fill' in r && 'feeCny' in r.fill).toBe(false)
  })

  it('failed margin lookup is no_quote', () => {
    const r = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => chain,
      marginFor: () => undefined,
      nowIso: 't',
      cash: 100_000,
    })
    expect('skip' in r && r.skip.skip === 'no_quote').toBe(true)
  })

  it('a live no_quote attempt consumes its bucket', () => {
    const first = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: [],
      chainFor: () => undefined,
      marginFor: () => 282,
      nowIso: 't',
      cash: 100_000,
    })
    expect('skip' in first && first.skip.skip).toBe('no_quote')
    const second = decidePaperOpen({
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      fillsToday: 'skip' in first ? [first.skip] : [],
      chainFor: () => chain,
      marginFor: () => 282,
      nowIso: 't2',
      cash: 100_000,
    })
    expect('skip' in second && second.skip.skip).toBe('duplicate_bucket')
  })

  it('invalidIf needs box break and volume surge', () => {
    const text = '1-minute close breaks Donchian on volumeRatio>=1.5'
    expect(invalidIfTriggered({ invalidIf: text, lastClose: 1.68, boxLow: 1.66, boxHigh: 1.67, volumeRatio: 1.6 })).toBe(true)
    expect(invalidIfTriggered({ invalidIf: text, lastClose: 1.68, boxLow: 1.66, boxHigh: 1.67, volumeRatio: 1.0 })).toBe(false)
    expect(invalidIfTriggered({ invalidIf: text, lastClose: 1.665, boxLow: 1.66, boxHigh: 1.67, volumeRatio: 2 })).toBe(false)
  })

  it('applyClose releases margin and books pnl', () => {
    const opened = applyOpen(
      { account: emptyPaperAccount('t'), positions: [], fills: [] },
      {
        id: 'o',
        bucketStart: 'b',
        asOf: 't',
        underlying: '588000',
        template: 'vertical',
        offset: 'open',
        qty: 1,
        legs: [
          { code: '588000C2609M01700', side: 'sell', qty: 1, fillPrice: 0.0566 },
          { code: '588000C2609M01750', side: 'buy', qty: 1, fillPrice: 0.0348 },
        ],
        premiumCny: 218,
        marginCny: 282,
        reason: 'signal',
      },
    )
    expect(opened.account.cash).toBe(100_000 + 218 - 282)
    const closed = applyClose(
      opened,
      opened.positions[0]!.id,
      [
        { code: '588000C2609M01700', side: 'buy', qty: 1, fillPrice: 0.05 },
        { code: '588000C2609M01750', side: 'sell', qty: 1, fillPrice: 0.03 },
      ],
      'close5',
      't2',
    )
    expect(closed.positions).toHaveLength(0)
    expect(closed.account.cash).toBeGreaterThan(opened.account.cash - 1)
  })

  it('applyOpen deducts feeCny and records openFeeCny; legacy fills stay fee-free', () => {
    const base = { account: emptyPaperAccount('t'), positions: [], fills: [] } as const
    const legacy = applyOpen(base, {
      id: 'o1', bucketStart: 'b', asOf: 't', underlying: '588000', template: 'vertical',
      offset: 'open', qty: 1, legs: [], premiumCny: 218, marginCny: 282, reason: 'signal',
    } as never)
    expect(legacy.account.cash).toBe(100_000 + 218 - 282)
    expect(legacy.positions[0]?.openFeeCny).toBeUndefined()

    const priced = applyOpen(base, {
      id: 'o2', bucketStart: 'b', asOf: 't', underlying: '588000', template: 'vertical',
      offset: 'open', qty: 1, legs: [], premiumCny: 218, marginCny: 282, reason: 'signal',
      feeCny: 3.4,
    } as never)
    expect(priced.account.cash).toBe(100_000 + 218 - 282 - 3.4)
    expect(priced.positions[0]?.openFeeCny).toBe(3.4)
    expect(priced.fills[0]?.feeCny).toBe(3.4)
  })

  it('applyClose books both-side fees into realizedPnl; legacy positions only pay close fee', () => {
    const base = { account: emptyPaperAccount('t'), positions: [], fills: [] } as const
    const openLegs = [
      { code: '588000C2609M01700', side: 'sell' as const, qty: 1, fillPrice: 0.0566 },
      { code: '588000C2609M01750', side: 'buy' as const, qty: 1, fillPrice: 0.0348 },
    ]
    const closeLegs = [
      { code: '588000C2609M01700', side: 'buy' as const, qty: 1, fillPrice: 0.05 },
      { code: '588000C2609M01750', side: 'sell' as const, qty: 1, fillPrice: 0.03 },
    ]
    // openPremium = +218（sell 566 − buy 348）；closePremium = −200（buy 500 − sell 300）。
    expect(premiumCny(openLegs)).toBeCloseTo(218, 6)
    expect(premiumCny(closeLegs)).toBeCloseTo(-200, 6)

    const withOpenFee = applyOpen(base, {
      id: 'p1', bucketStart: 'b', asOf: 't', underlying: '588000', template: 'vertical',
      offset: 'open', qty: 1, legs: openLegs, premiumCny: 218, marginCny: 282,
      reason: 'signal', feeCny: 3.4,
    } as never)
    const closedPriced = applyClose(withOpenFee, '588000:b', closeLegs, 'close5', 't2')
    // closeFee = 1.7×2 = 3.4；realizedPnl = (218−200) − 3.4 − 3.4 = 11.2。
    expect(closedPriced.fills.at(-1)?.feeCny).toBeCloseTo(3.4, 10)
    expect(closedPriced.account.realizedPnl).toBeCloseTo(18 - 3.4 - 3.4, 10)

    const legacy = applyOpen(base, {
      id: 'p2', bucketStart: 'b', asOf: 't', underlying: '588000', template: 'vertical',
      offset: 'open', qty: 1, legs: openLegs, premiumCny: 218, marginCny: 282,
      reason: 'signal',
    } as never)
    const closedLegacy = applyClose(legacy, '588000:b', closeLegs, 'close5', 't2')
    // 旧持仓 openFeeCny 缺省 → 只扣 closeFee。
    expect(closedLegacy.account.realizedPnl).toBeCloseTo(18 - 3.4, 10)

    const closedFree = applyClose(legacy, '588000:b', closeLegs, 'close5', 't2', 0)
    expect(closedFree.account.realizedPnl).toBeCloseTo(18, 10)
    expect(closedFree.fills.at(-1) && 'feeCny' in closedFree.fills.at(-1)!).toBe(false)
  })

  it('hasSuccessfulOpen ignores skipped fills', () => {
    expect(hasSuccessfulOpen([{
      id: 's', bucketStart: 'b', asOf: 't', offset: 'open', qty: 0, legs: [],
      premiumCny: 0, marginCny: 0, cashAfter: 0, reason: 'skipped', skip: 'no_quote',
    }], 'b')).toBe(false)
  })

  it('reset persists a fresh 100000 CNY account and empty positions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    const state = await resetPaperState(root, '2026-09-10T05:00:00.000Z')

    expect(state.account.cash).toBe(100_000)
    expect(JSON.parse(await readFile(paperAccountPath(root), 'utf8'))).toEqual(state.account)
    expect(JSON.parse(await readFile(paperPositionsPath(root), 'utf8'))).toEqual([])
  })

  it('tryPaperOpen persists one position with recommendation invalidation context', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    const input = {
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => chain,
      getMargin: async () => 282,
    }

    await tryPaperOpen(input)
    const state = await loadPaperState(root, input.date, input.nowIso)

    expect(state.fills).toHaveLength(1)
    expect(state.positions).toEqual([
      expect.objectContaining({
        invalidIf: input.rec.invalidIf,
        boxLow: box.boxLow,
        boxHigh: box.boxHigh,
      }),
    ])
  })

  it('tryPaperOpen honors an injected feePerContract of 0', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    await tryPaperOpen({
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => chain,
      getMargin: async () => 282,
      feePerContract: 0,
    })
    const state = await loadPaperState(root, '2026-09-10', 'unused')

    expect(state.fills).toHaveLength(1)
    expect('feeCny' in (state.fills[0] ?? {})).toBe(false)
    expect(state.positions[0]?.openFeeCny).toBeUndefined()
    expect(state.account.cash).toBeCloseTo(
      100_000 + premiumCny(state.fills[0]!.legs) - state.positions[0]!.marginCny,
      6,
    )
  })

  it('tryPaperOpen persists duplicate_bucket on a second call', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    const input = {
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => chain,
      getMargin: async () => 282,
    }

    await tryPaperOpen(input)
    await tryPaperOpen({
      ...input,
      nowIso: '2026-09-10T05:40:24.000Z',
      getChain: async () => { throw new Error('duplicate must not fetch chain') },
      getMargin: async () => { throw new Error('duplicate must not fetch margin') },
    })
    const fills = (await readFile(paperFillsPath(root, input.date), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))

    expect(fills).toHaveLength(2)
    expect(fills[1].skip).toBe('duplicate_bucket')
  })

  it('tryPaperOpen opens the first pick without fetching a failing second pick', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    const secondBox = { ...box, underlying: '510050' }
    const requested: string[] = []

    await tryPaperOpen({
      root,
      date: '2026-09-10',
      rec: liveRec({
        picks: [
          { underlying: '588000', regime: 'mean_revert', template: 'vertical', cycleId: '588000:1' },
          { underlying: '510050', regime: 'mean_revert', template: 'vertical', cycleId: '510050:1' },
        ],
      }),
      forecastByUnderlying: { '588000': box, '510050': secondBox },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async (underlying) => {
        requested.push(underlying)
        if (underlying === '510050') throw new Error('second chain failed')
        return chain
      },
      getMargin: async () => 282,
    })
    const state = await loadPaperState(root, '2026-09-10', 'unused')

    expect(requested).toEqual(['588000'])
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0]?.underlying).toBe('588000')
  })

  it('tryPaperOpen persists no_quote when margin lookup throws', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    await tryPaperOpen({
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => chain,
      getMargin: async () => { throw new Error('margin unavailable') },
    })
    const state = await loadPaperState(root, '2026-09-10', 'unused')

    expect(state.positions).toEqual([])
    expect(state.fills).toEqual([expect.objectContaining({ skip: 'no_quote' })])
  })

  it('serializes concurrent opens for the same bucket', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    let chainCalls = 0
    const input = {
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => {
        chainCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return chain
      },
      getMargin: async () => 282,
    }

    await Promise.all([tryPaperOpen(input), tryPaperOpen({ ...input, nowIso: '2026-09-10T05:40:24.000Z' })])
    const state = await loadPaperState(root, '2026-09-10', 'unused')

    expect(chainCalls).toBe(1)
    expect(state.positions).toHaveLength(1)
    expect(state.fills.map((fill) => fill.skip ?? fill.reason)).toEqual(['signal', 'duplicate_bucket'])
  })

  it('tryPaperManage close5 flattens persisted positions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    await tryPaperOpen({
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => chain,
      getMargin: async () => 282,
    })

    await tryPaperManage({
      root,
      date: '2026-09-10',
      nowMs: Date.parse('2026-09-10T06:56:00.000Z'),
      nowIso: '2026-09-10T06:56:00.000Z',
      session: 'close5',
      calendarDate: '2026-09-10',
      getMark: async (_code, side) => side === 'buy'
        ? { price: 0.05, source: 'last' }
        : { price: 0.03, source: 'last' },
      getLastClose: async () => undefined,
    })
    const state = await loadPaperState(root, '2026-09-10', 'unused')

    expect(state.positions).toEqual([])
    expect(state.fills.at(-1)?.reason).toBe('close5')
    // 平仓双边费：2 张 × 1.7 = 3.4；开仓 fill 同样带费。
    expect(state.fills.at(-1)?.feeCny).toBeCloseTo(3.4, 10)
    expect(state.fills[0]?.feeCny).toBeCloseTo(3.4, 10)
    expect(state.fills.at(-1)?.legs.every((leg) => leg.priceSource === 'last')).toBe(true)
  })

  it('tryPaperManage skips one rejected mark and closes the other position', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    const first = applyOpen(
      { account: emptyPaperAccount('t'), positions: [], fills: [] },
      {
        bucketStart: '2026-09-10T05:40:00.000Z',
        asOf: '2026-09-10T05:40:23.000Z',
        underlying: '588000',
        template: 'vertical',
        offset: 'open',
        qty: 1,
        legs: [{ code: 'BAD', side: 'buy', qty: 1, fillPrice: 0.05 }],
        premiumCny: -500,
        marginCny: 0,
        reason: 'signal',
      },
    )
    const state = applyOpen(first, {
      bucketStart: '2026-09-10T05:45:00.000Z',
      asOf: '2026-09-10T05:45:23.000Z',
      underlying: '510050',
      template: 'vertical',
      offset: 'open',
      qty: 1,
      legs: [{ code: 'GOOD', side: 'buy', qty: 1, fillPrice: 0.04 }],
      premiumCny: -400,
      marginCny: 0,
      reason: 'signal',
    })
    await savePaperState(root, '2026-09-10', state)

    await tryPaperManage({
      root,
      date: '2026-09-10',
      nowMs: Date.parse('2026-09-10T06:56:00.000Z'),
      nowIso: '2026-09-10T06:56:00.000Z',
      session: 'close5',
      calendarDate: '2026-09-10',
      getMark: async (code) => {
        if (code === 'BAD') throw new Error('mark failed')
        return { price: 0.03, source: 'last' }
      },
      getLastClose: async () => undefined,
    })
    const managed = await loadPaperState(root, '2026-09-10', 'unused')

    expect(managed.positions.map((position) => position.underlying)).toEqual(['588000'])
    expect(managed.fills.at(-1)).toEqual(expect.objectContaining({
      underlying: '510050',
      offset: 'close',
      reason: 'close5',
    }))
  })

  it('paper try operations swallow dependency failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-option-paper-'))
    await expect(tryPaperOpen({
      root,
      date: '2026-09-10',
      rec: liveRec(),
      forecastByUnderlying: { '588000': box },
      nowIso: '2026-09-10T05:40:23.000Z',
      getChain: async () => { throw new Error('chain failed') },
      getMargin: async () => 282,
    })).resolves.toBeUndefined()
  })
})
