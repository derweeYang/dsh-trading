### Task 2: Pure paper engine (TDD)

**Files:**
- Create: `packages/kit-cn/src/option-paper.ts`
- Create: `packages/kit-cn/test/option-paper.test.ts`
- Modify: `packages/kit-cn/src/index.ts` — `export * from './option-paper.js'`

**Interfaces:**

```ts
import type {
  OptionBarRecommendation,
  OptionChain,
  OptionIntradayBoxRow,
  OptionQuoteRow,
  PaperAccount,
  PaperFill,
  PaperPosition,
} from '@dshtrading/api'

export const OPTION_PAPER_INITIAL_CASH = 100_000
export const OPTION_MULTIPLIER = 10_000

export interface PaperState {
  account: PaperAccount
  positions: PaperPosition[]
  fills: PaperFill[]
}

export function emptyPaperAccount(nowIso: string): PaperAccount
export function quoteFillPrice(row: OptionQuoteRow & { bid?: number; ask?: number }, side: 'buy' | 'sell'): number | undefined
export function completeVerticalLegs(
  chain: OptionChain,
  bias: 'up' | 'down' | 'neutral',
  qty: number,
): { legs: PaperFill['legs']; skip?: 'no_quote' }
export function premiumCny(legs: PaperFill['legs']): number
export function sizeQty(maxContracts: number | undefined, cash: number, premiumPer: number, marginPer: number): number
export function hasSuccessfulOpen(fills: readonly PaperFill[], bucketStart: string): boolean
export function applyOpen(state: PaperState, fill: Omit<PaperFill, 'cashAfter' | 'id'> & { id?: string }): PaperState
export function applyClose(state: PaperState, positionId: string, legs: PaperFill['legs'], reason: 'invalidIf' | 'close5' | 'session', asOf: string): PaperState
export function invalidIfTriggered(input: {
  invalidIf: string
  lastClose: number
  boxLow?: number
  boxHigh?: number
  volumeRatio?: number
}): boolean
export function decidePaperOpen(input: {
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  fillsToday: readonly PaperFill[]
  chainFor: (underlying: string) => OptionChain | undefined
  marginFor: (legs: PaperFill['legs']) => number
  nowIso: string
  cash: number
}): { fill: Omit<PaperFill, 'cashAfter'> } | { skip: PaperFill } | { noop: true }
```

`invalidIfTriggered`: if `invalidIf` includes `volumeRatio>=1.5` (or `BOX_VOLUME_SURGE`), require `volumeRatio >= 1.5`; break = `lastClose < boxLow || lastClose > boxHigh` when both box edges exist. If box edges missing or text has no Donchian/box cue, return `false`.

`completeVerticalLegs`: sort calls/puts by strike. ATM = strike nearest `chain.spot ??` middle. `bias=down`: sell call at ATM-or-above nearest, buy next higher call. `bias=up`: sell put at ATM-or-below, buy next lower put. `neutral` → `{ skip: 'no_quote' }`. Missing code or fill price → `no_quote`.

`premiumCny`: buy legs negative (`-price*qty*10000`), sell positive.

`sizeQty`: `qty0 = max(1, Math.floor(maxContracts ?? 1))`. While `qty > 0` and `cash + premiumPer*qty - marginPer*qty < 0`, `qty--`. Return qty.

`decidePaperOpen`:
1. `rec.skipReason` or `rec.noTrade` → `{ noop: true }`
2. `hasSuccessfulOpen` → skip fill `duplicate_bucket`, `reason=skipped`, empty legs
3. Walk `picks`: missing underlying/template → continue (last failure `bad_template`)
4. forecast missing or template not in `forecast.candidates[].template` → `no_forecast` / `bad_template`
5. Resolve legs: if pick.legs items have `code`, `side`, numeric price (`last` or `fillPrice` or `premium`) use them; else `completeVerticalLegs`
6. `sizeQty` with `pick.maxContracts`; 0 → `no_cash`
7. First success → `{ fill: { reason: 'signal', offset: 'open', ... } }`
8. If a fill already chosen, remaining picks are not returned (caller does not write `one_fill` rows unless you want debug; spec allows skip row — write one `one_fill` only if a later pick exists after success; simpler: do not write `one_fill`)
9. All picks failed → one skip fill from last skip reason

- [ ] **Step 1: Write the failing test** in `packages/kit-cn/test/option-paper.test.ts`:

```ts
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
  premiumCny,
  quoteFillPrice,
  sizeQty,
} from '../src/option-paper.js'

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
})
```

- [ ] **Step 2:** Run `pnpm --filter @dshtrading/kit-cn test -- test/option-paper.test.ts`

Expected: FAIL (module missing)

- [ ] **Step 3:** Implement `packages/kit-cn/src/option-paper.ts` to pass. `applyOpen` cash: `cash + premiumCny - marginCny` (premium already signed). Store position `id = underlying + ':' + openedBucketStart`. `applyClose` cash: add close `premiumCny` (signed for flattening: buy-to-close negative) and add back `position.marginCny`; `realizedPnl += (closePremium + openPremium)`.

- [ ] **Step 4:** Re-run the same vitest command. Expected: PASS

- [ ] **Step 5:** Export from `index.ts`. Rebuild kit-cn.

---
