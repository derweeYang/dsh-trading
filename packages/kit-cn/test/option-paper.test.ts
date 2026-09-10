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
  resetPaperState,
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

  it('completeVerticalLegs down is bear call spread', () => {
    const out = completeVerticalLegs(chain, 'down', 1)
    expect(out.skip).toBeUndefined()
    expect(out.legs.map((l) => `${l.side}:${l.code}`)).toEqual([
      'sell:588000C2609M01700',
      'buy:588000C2609M01750',
    ])
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
    await tryPaperOpen({ ...input, nowIso: '2026-09-10T05:40:24.000Z' })
    const fills = (await readFile(paperFillsPath(root, input.date), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))

    expect(fills).toHaveLength(2)
    expect(fills[1].skip).toBe('duplicate_bucket')
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
      getMark: async (_code, side) => side === 'buy' ? 0.05 : 0.03,
      getLastClose: async () => undefined,
    })
    const state = await loadPaperState(root, '2026-09-10', 'unused')

    expect(state.positions).toEqual([])
    expect(state.fills.at(-1)?.reason).toBe('close5')
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
