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
