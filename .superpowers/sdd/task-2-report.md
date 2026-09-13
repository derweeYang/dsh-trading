# Task 2 Report: OpportunityLane + Host refactor

## Status

DONE

## What Was Implemented

Refactored `OptionBarAgentHost` so opportunity decide/run is lane-callable, while `afterTick` stays a compatible single-lane entry (no Director yet).

### `packages/client-ui-trading/src/option-bar-agent.ts`

- Stopped calling `decideBarAgent` directly; Host now uses `opportunityDecide` from `@dshtrading/kit-cn`.
- New public methods (signatures per brief):
  - `buildContext({ ticked, loop, nowMs })` — `refreshInFlight` + session/date/recs/calibrated → `DirectorTickContext`
  - `runOpportunity(ctx, decision)` — stub write or trader launch; no review
  - `maybeWriteReview(nowMs)` — close5/closed deterministic review, skip if file exists
- `afterTick` remains: `buildContext` → `opportunityDecide` → `runOpportunity` on launch/stub → `maybeWriteReview`
- `createOpportunityLane(host)` — `id: 'opportunity'`, `decide` → `opportunityDecide`, `run` → `host.runOpportunity`
- Unchanged: `inFlight` / `settle` / private `refreshInFlight` / `writeRec` / `fileExists`

### Tests

Kept the original two regressions and added two launch-path locks:

- lunch stub, no launch
- close5 review, second tick does not overwrite
- regular new bucket launches, writes no skip row
- `createOpportunityLane` delegates decide/run

### Agent Note

Updated proposed trader-director note with Task 2 progress (Host split landed; three-lane mount still later).

## Test Evidence

Command:

```bash
pnpm --filter @dshtrading/client-ui-trading test -- option-bar-agent
```

First run failed: `opportunityDecide is not a function` because Task 1 source was not in `@dshtrading/kit-cn` `lib/` (client-ui-trading resolves the built package).

After `pnpm --filter @dshtrading/kit-cn build`:

```
 ✓ test/option-bar-agent.test.ts (4 tests) 29ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

## Files Changed

| File | Action |
|------|--------|
| `packages/client-ui-trading/src/option-bar-agent.ts` | Refactored Host + `createOpportunityLane` |
| `packages/client-ui-trading/test/option-bar-agent.test.ts` | Kept 2 regressions; added launch + lane tests |
| `.agents/notes/proposed/architecture/2026-09-09-trader-director.md` | Progress note |

Did not change `packages/client-ui-*/src/client/**` or `packages/client-ui-trading/src/index.ts` (still hooks `afterTick`).

## Self-Review

- **Behavior equivalence**: lunch still writes `skipReason: session` and does not launch; close5 still writes review once. Launch path is the same runner.launch payload (`option-bar-${bucketStart}`, trader preset, static prompt + bucket/asOf).
- **Signatures**: `buildContext` / `runOpportunity` / `maybeWriteReview` / `createOpportunityLane` match the brief verbatim.
- **Compatibility**: `afterTick` / `inFlight` / `settle` still public; `index.ts` tick hook needs no change this task.
- **No Director yet**: `afterTick` does not call `routeTraderLanes` — matches brief “单车道机会路径（无 Director）”.
- **No live orders / no master trifork**: launch still only starts a trader session; no order path.
- **Linter**: no diagnostics on changed TS files.

## Concerns

None blocking.

1. Consuming Task 1 required a local `kit-cn` rebuild (`lib/` is gitignored). Later tasks that import `opportunityDecide` from `@dshtrading/kit-cn` must rebuild kit-cn first on a clean tree.
2. `routeTraderLanes` / `createIdleLane` are not wired in this Host — deferred to the Director host task by design.

## Commits

None (per plan constraint).
