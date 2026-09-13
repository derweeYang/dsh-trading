# Task 1 Report: kit-cn TraderDirector Lane Router (TDD)

## Status

DONE

## What Was Implemented

Phase 1 TraderDirector thin orchestration over option-bar: pure routing functions in `@dshtrading/kit-cn`.

### New module: `packages/kit-cn/src/trader-director.ts`

- **Types**: `LaneId`, `LaneAction`, `LaneDecision`, `DirectorTickContext`, `TraderLane`
- **`createIdleLane(id)`**: returns a risk/behavior lane that always decides `idle` (Phase 1 stub)
- **`opportunityDecide(ctx)`**: delegates to existing `decideBarAgent` from `option-bar-ledger.js`, mapping `llmBusy → inFlight`
- **`routeTraderLanes(ctx, lanes)`**: three-lane router with short-circuit on `launch`:
  - `opportunity` non-idle → push; if `launch`, return immediately (skip risk/behavior)
  - `opportunity` idle → consult risk, then behavior; only non-idle decisions included in output
  - `opportunity` stub → push opportunity, continue to risk/behavior (Phase 1 all idle)

### Export

Added `export * from './trader-director.js'` to `packages/kit-cn/src/index.ts` alongside `option-bar-ledger`.

### Tests

Created `packages/kit-cn/test/trader-director.test.ts` with 6 cases covering:
- `opportunityDecide`: regular → launch, llmBusy → overlap stub
- `routeTraderLanes`: launch short-circuit, idle cascade (empty output), stub continues to later lanes, `createIdleLane` always idle

## TDD Evidence

### RED (Step 2)

```bash
pnpm --filter @dshtrading/kit-cn test -- trader-director
```

```
 FAIL  test/trader-director.test.ts
Error: Cannot find module '../src/trader-director.ts' imported from '.../packages/kit-cn/test/trader-director.test.ts'
 Test Files  1 failed (1)
      Tests  no tests
Exit status 1
```

### GREEN (Step 4)

```bash
pnpm --filter @dshtrading/kit-cn test -- trader-director
```

```
 ✓ test/trader-director.test.ts (6 tests) 4ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## Files Changed

| File | Action |
|------|--------|
| `packages/kit-cn/src/trader-director.ts` | Created |
| `packages/kit-cn/test/trader-director.test.ts` | Created |
| `packages/kit-cn/src/index.ts` | Modified (one export line) |

## Self-Review

- **Scope**: Only kit-cn routing; no client-ui-trading, no host wiring, no event bus, no ledger — matches task constraints.
- **Delegation**: `opportunityDecide` reuses `decideBarAgent` rather than duplicating bar-agent rules; single source of truth preserved.
- **Short-circuit semantics**: `launch` returns early before risk/behavior `decide` is called — verified by vi.fn spy test.
- **Stub path**: Non-launch non-idle (stub) still routes opportunity and continues to risk/behavior — correct for Phase 1 where those lanes are idle stubs.
- **Types**: Consumes `@dshtrading/api` session/skip types and `BarAgentDecision` from option-bar-ledger; no invented market data.
- **Linter**: No diagnostics on changed files.
- **Commit**: Skipped per global constraint (user did not request commit).

## Concerns

None blocking. Minor notes for later tasks:

1. **`run?` hook** on `TraderLane` is declared but unused in Phase 1 — intentional per brief; host wiring (Task 2+) will invoke it.
2. **`DirectorTickContext.loop`** is carried but not read by router — expected; future lanes may consume cycle rows.
3. Full kit-cn test suite not re-run; only `trader-director` filter executed. Recommend full `pnpm --filter @dshtrading/kit-cn test` before merge.

## Commits

None (per plan constraint).
