# ETF 期权虚拟账户 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a valid bar recommendation, open at most one ETF-option combo on a 100_000 CNY host paper book at chain last/prevSettle, flatten on `invalidIf` or `close5`, and expose read/reset HTTP — never live orders.

**Architecture:** Pure engine in `@dshtrading/kit-cn` (`option-paper.ts`) mutates an in-memory `PaperState`. File helpers persist `data/options/paper/`. `cn_put_option_bar_recommendation` and `OptionBarAgentHost.writeRec` call `tryPaperOpen` after jsonl append. `TradingBridge.optionCycleTick` calls `tryPaperManage` after cycle writes. Bridge GET/POST only read or reset the files.

**Tech Stack:** TypeScript, vitest, `@dshtrading/api` types, `@dshtrading/kit-cn`, `@dshtrading/client-ui-trading` node bridge. No Python kernel changes. No `src/client/**`.

## Global Constraints

- Initial cash is exactly `100000` CNY; currency `CNY`.
- Multiplier is `10000`.
- Do not call `placeOptionOrder` or set `liveTrading`.
- Do not edit `packages/client-ui-*/src/client/**`.
- `OptionQuoteRow` today has `last` / `prevSettle` only: `fillPrice = last ?? prevSettle`. If both missing → `no_quote`. When bid/ask exist later, buy uses ask and sell uses bid.
- One successful `offset=open` per `bucketStart`. First live recommendation only; first pick that fills.
- Stub recs (`skipReason` set or `noTrade`) do not write fills.
- Paper failures must not throw out of tick or recommendation persist.
- Path root: `optionsDataRoot()`; gitignore `data/options/paper/`.

## File map

- Create: `packages/kit-cn/src/option-paper.ts` — engine + persist + tryOpen/tryManage
- Create: `packages/kit-cn/test/option-paper.test.ts`
- Modify: `packages/api/src/index.ts` — paper + pick `maxContracts` types
- Modify: `packages/kit-cn/src/option-bar-ledger.ts` — `paperAccountPath`, `paperPositionsPath`, `paperFillsPath`
- Modify: `packages/kit-cn/src/options-tools.ts` — hook after append
- Modify: `packages/kit-cn/src/index.ts` — re-export paper
- Modify: `packages/client-ui-trading/src/option-bar-agent.ts` — hook `writeRec`
- Modify: `packages/client-ui-trading/src/bridge.ts` — manage on tick + 3 routes
- Modify: `packages/client-ui-trading/test/bridge.test.ts` — paper routes
- Modify: `packages/client-ui-trading/test/option-bar-agent.test.ts` — open hook does not throw
- Modify: `.gitignore`, `data/options/README.md`, `docs/options-bridge.md`
- Modify: `.agents/notes/proposed/feature/2026-09-10-option-paper-account.md` → implemented on last task

---

### Task 1: API types

**Files:**
- Modify: `packages/api/src/index.ts` (after `OptionBarRecommendation`)
- Test: `packages/kit-cn/test/option-paper.test.ts` (types consumed in Task 2; this task is type-only — run `pnpm --filter @dshtrading/api build`)

**Interfaces:**

Add to `OptionBarPick`:

```ts
readonly maxContracts?: number
```

Add after `OptionBarRecommendation`:

```ts
export const OPTION_PAPER_INITIAL_CASH = 100_000
export const OPTION_MULTIPLIER = 10_000

export type PaperFillSkip =
  | 'duplicate_bucket'
  | 'no_quote'
  | 'no_forecast'
  | 'no_cash'
  | 'bad_template'
  | 'one_fill'

export type PaperFillReason = 'signal' | 'invalidIf' | 'close5' | 'session' | 'skipped'

export interface PaperLegFill {
  readonly code: string
  readonly side: 'buy' | 'sell'
  readonly qty: number
  readonly fillPrice: number
}

export interface PaperFill {
  readonly id: string
  readonly bucketStart: string
  readonly asOf: string
  readonly underlying?: string
  readonly template?: string
  readonly offset: 'open' | 'close'
  readonly qty: number
  readonly legs: readonly PaperLegFill[]
  readonly premiumCny: number
  readonly marginCny: number
  readonly cashAfter: number
  readonly reason: PaperFillReason
  readonly skip?: PaperFillSkip
}

export interface PaperPosition {
  readonly id: string
  readonly underlying: string
  readonly template: string
  readonly openedBucketStart: string
  readonly invalidIf: string
  readonly qty: number
  readonly marginCny: number
  readonly boxLow?: number
  readonly boxHigh?: number
  readonly legs: readonly PaperLegFill[]
}

export interface PaperAccount {
  readonly currency: 'CNY'
  readonly initialCash: number
  readonly cash: number
  readonly realizedPnl: number
  readonly updatedAt: string
}

export interface OptionPaperAccountWire {
  readonly ok: true
  readonly account: PaperAccount
  readonly equity: number
  readonly positions: readonly PaperPosition[]
}

export interface OptionPaperFillsWire {
  readonly ok: true
  readonly fills: readonly PaperFill[]
}
```

- [ ] **Step 1:** Insert the types above. Do not add runtime code in api (package is types-only except `const` numbers — if api forbids values, put constants only in kit-cn and duplicate the numeric literals `100000` / `10000` in api as comments; prefer exporting consts from kit-cn `OPTION_PAPER_INITIAL_CASH` if api build fails on values).

- [ ] **Step 2:** Run `pnpm --filter @dshtrading/api build`

Expected: PASS

- [ ] **Step 3:** Commit only if the user asked for commits. Otherwise leave staged-uncommitted.

---

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

### Task 3: Persist paper files

**Files:**
- Modify: `packages/kit-cn/src/option-bar-ledger.ts`
- Modify: `packages/kit-cn/src/option-paper.ts` — `loadPaperState`, `savePaperState`, `tryPaperOpen`, `tryPaperManage`
- Modify: `packages/kit-cn/test/option-paper.test.ts`

**Path helpers** (with existing `cyclesPath` style):

```ts
export function paperAccountPath(root: string): string {
  return path.join(root, 'paper', 'account.json')
}
export function paperPositionsPath(root: string): string {
  return path.join(root, 'paper', 'positions.json')
}
export function paperFillsPath(root: string, date: string): string {
  return path.join(root, 'paper', 'fills', `${date}.jsonl`)
}
```

```ts
export async function loadPaperState(root: string, date: string, nowIso: string): Promise<PaperState>
export async function savePaperState(root: string, date: string, state: PaperState): Promise<void>
export async function resetPaperState(root: string, nowIso: string): Promise<PaperState>
```

`loadPaperState`: missing account → `emptyPaperAccount`. Read fills jsonl if present. Positions from `positions.json`.

`savePaperState`: mkdir, write account + positions, append only **new** fills (track by `id`; if rewriting whole day is easier, write the day's fills file in full from `state.fills` filtered to that date — prefer rewrite of that date's jsonl from `state.fills` to stay simple in tests).

`resetPaperState`: write empty account 100000, `positions: []`, do not delete historical fills files.

`tryPaperOpen(deps)`:

```ts
export async function tryPaperOpen(input: {
  root: string
  date: string
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  nowIso: string
  getChain: (underlying: string) => Promise<OptionChain | undefined>
  getMargin: (legs: PaperFill['legs']) => Promise<number>
}): Promise<void>
```

Load state, `decidePaperOpen` with cached chain map, `applyOpen` or append skip, `savePaperState`. Catch all errors and return.

`tryPaperManage`:

```ts
export async function tryPaperManage(input: {
  root: string
  date: string
  nowMs: number
  nowIso: string
  session: OptionIntradaySession
  calendarDate: string
  getMark: (code: string, side: 'buy' | 'sell') => Promise<number | undefined>
  getLastClose: (underlying: string) => Promise<{ lastClose: number; volumeRatio?: number } | undefined>
}): Promise<void>
```

If `shanghaiCalendarDate(nowMs) !==` date of `openedBucketStart` for any position → close with `reason=session` using `getMark`.
Else for each position: if `invalidIfTriggered` using `getLastClose` + stored box → close `invalidIf`.
Else if `session === 'close5'` → close all remaining `close5`.
Mark for flatten: invert side (sell→buy at fill price from `getMark`). Missing mark → skip that position this tick (do not throw).

- [ ] **Step 1:** Add persist tests using `mkdtemp`: reset creates 100000; tryPaperOpen live rec writes one fill; second call same bucket is duplicate; tryPaperManage close5 empties positions.

- [ ] **Step 2:** Run tests — FAIL on missing functions

- [ ] **Step 3:** Implement persist + try* 

- [ ] **Step 4:** Tests PASS

---

### Task 4: Hook recommendation write

**Files:**
- Modify: `packages/kit-cn/src/options-tools.ts` — after `appendJsonlLine` in `createPutOptionBarRecommendationTool`
- Modify: `packages/kit-cn/src/options-tools.ts` `OptionToolOptions` to accept optional `getChain` / `getMargin` (if absent, tryPaperOpen noops chain → skip `no_quote` or skip hook)
- Modify: `packages/client-ui-trading/src/option-bar-agent.ts` `writeRec`
- Modify: `packages/kit-cn/test/options-tools.test.ts`
- Modify: `packages/client-ui-trading/test/option-bar-agent.test.ts`

After successful append:

```ts
void tryPaperOpen({
  root,
  date,
  rec: row,
  forecastByUnderlying,
  nowIso: new Date(nowMs).toISOString(),
  getChain: options.getChain ?? (async () => undefined),
  getMargin: options.getMargin ?? (async () => 0),
}).catch(() => {})
```

Host `writeRec`: same, using `this.options.getCnOptions?.().getOptionChain` and `getStrategy` for margin (`result.margin?.totalInitial ?? 0`). If `getCnOptions` missing, still call tryPaperOpen with undefined chain.

Add test: put tool with live rec + injected chain writes `paper/fills/*.jsonl`. Existing no_edge test still has no paper fill.

- [ ] Write failing test on put-tool paper fill
- [ ] Wire hooks
- [ ] `pnpm --filter @dshtrading/kit-cn test` and `pnpm --filter @dshtrading/client-ui-trading test -- test/option-bar-agent.test.ts` PASS

---

### Task 5: Tick manage + bridge routes

**Files:**
- Modify: `packages/client-ui-trading/src/bridge.ts`
  - end of `optionCycleTick` (after cycle loop, before return): `void tryPaperManage(...).catch(log)`
  - `dispatchBridgeRequest` cases:
    - `GET /options/paper/account`
    - `GET /options/paper/fills`
    - `POST /options/paper/reset`
- Modify: `packages/client-ui-trading/test/bridge.test.ts`
- Modify: `docs/options-bridge.md` — table rows
- Modify: `.gitignore` — `data/options/paper/`
- Modify: `data/options/README.md` — paper row

`equity`: `account.cash + sum(position mark)` where each sell leg marks `-qty*mark*10000` vs avg and buy `+qty*mark*10000` vs avg (or simpler: `cash + sum over legs of (mark-avg)*signedDelta` plus remaining margin still locked is already out of cash — equity = cash + marginLocked + option MTM). Spec: `equity = cash + Σ mark` with long last, short last. Implement: `equity = cash + position.marginCny + mtm` where `mtm = Σ for each leg (side==buy ? 1 : -1) * (mark - avgPrice) * qty * 10000`. If mark missing use avgPrice (mtm 0).

Fills GET: read today's jsonl, `limit` default 48, newest first.

Reset: `resetPaperState`, return account wire.

Tick `getLastClose`: reuse klines already fetched in the tick loop if possible; else `getKlines(spot, '1m', 5)` last close; `volumeRatio` from current box row if in scope.

- [ ] Bridge tests: GET account on temp `DSH_TRADING_OPTIONS_DATA` is 100000; POST reset; GET fills `ok`.
- [ ] Tick test: with a planted position and `asOf` in close5 window, positions empty after tick (inject data root).
- [ ] Confirm `placeOptionOrder` is never called from paper functions (grep + unit).

---

### Task 6: Agent note + spec status

**Files:**
- Move/update `.agents/notes/proposed/feature/2026-09-10-option-paper-account.md` to `implemented/feature/` with Status implemented, Proposal → Decision (present tense), merge Verification into Consequences
- Spec header `状态：implemented`
- Do not change archived notes

- [ ] `pnpm --filter @dshtrading/api build && pnpm --filter @dshtrading/kit-cn test && pnpm --filter @dshtrading/client-ui-trading test`
- [ ] Manual replay optional: point `DSH_TRADING_OPTIONS_DATA` at a copy of `data/options` and call `tryPaperOpen` on first 13:40 rec

---

## Spec coverage

| Spec § | Task |
|---|---|
| §3 gates / one fill / duplicate | 2, 4 |
| §4 complete legs / size / last price | 2 |
| §5 invalidIf / close5 / stale session | 2, 3, 5 |
| §6 files | 3 |
| §7 API | 5 |
| §8 errors swallowed | 3, 4, 5 |
| §9 tests | 2–5 |
| No live / no client UI | Global |

## Self-review

- No TBD. `one_fill` skip rows optional (engine skips writing them).
- Fill price uses last/prevSettle because chain wire has no bid/ask.
- `maxContracts` lives on `OptionBarPick`.
- Constants named `OPTION_PAPER_INITIAL_CASH` / `OPTION_MULTIPLIER` in kit-cn.
