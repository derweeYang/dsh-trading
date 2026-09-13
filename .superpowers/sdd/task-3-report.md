# Task 3 Report: TraderDirectorHost wiring

## Status

DONE

## What Was Implemented

Phase 1 three-lane host: `TraderDirectorHost` mounts opportunity + idle risk/behavior, and the cycle tick hook now enters via `director.afterTick`.

### New: `packages/client-ui-trading/src/trader-director-host.ts`

- `TraderDirectorHostOptions`: required `opportunity: OptionBarAgentHost`; optional test-only `riskRun` / `behaviorRun`
- Constructor:
  - `opportunity` lane = `createOpportunityLane(host)`
  - `risk` / `behavior` = `createIdleLane`; if a test hook is passed, overlay `run` only (`decide` stays idle)
- `afterTick({ ticked, loop, nowMs })`:
  1. `opportunity.buildContext`
  2. `routeTraderLanes`
  3. for each routed `launch`/`stub`, `lane.run`
  4. `opportunity.maybeWriteReview`

### Wired: `packages/client-ui-trading/src/index.ts`

- Import `TraderDirectorHost`
- After constructing `barAgent`, `const director = new TraderDirectorHost({ opportunity: barAgent })`
- Tick hook: `barAgent.afterTick(...)` → `director.afterTick(...)` (same payload)

`OptionBarAgentHost.afterTick` remains as the standalone single-lane entry (Task 2 regressions still use it).

### Tests

Created `packages/client-ui-trading/test/trader-director-host.test.ts`:

- lunch new bucket → writes `skipReason: session`; `riskRun` / `behaviorRun` not called
- regular launch → runner.launch once; launch short-circuit leaves `riskRun` uncalled

### Agent Note

Updated proposed trader-director note with Task 3 progress (`TraderDirectorHost` mounted; tick hook switched).

## TDD Evidence

### RED (Step 2)

```bash
pnpm --filter @dshtrading/client-ui-trading test -- trader-director-host
```

```
 FAIL  test/trader-director-host.test.ts [ test/trader-director-host.test.ts ]
Error: Cannot find module '../src/trader-director-host.ts'
```

Failed for the expected reason (module missing), not a typo.

### GREEN (Step 5)

```
pnpm --filter @dshtrading/kit-cn test -- trader-director
 → ✓ test/trader-director.test.ts (6 tests) 5ms

pnpm --filter @dshtrading/client-ui-trading test -- option-bar-agent
 → ✓ test/option-bar-agent.test.ts (4 tests) 27ms

pnpm --filter @dshtrading/client-ui-trading test -- trader-director-host
 → ✓ test/trader-director-host.test.ts (2 tests) 21ms
```

All three commands: Test Files 1 passed, no failures.

## Files Changed

| File | Action |
|------|--------|
| `packages/client-ui-trading/src/trader-director-host.ts` | Created |
| `packages/client-ui-trading/test/trader-director-host.test.ts` | Created |
| `packages/client-ui-trading/src/index.ts` | Tick hook → `director.afterTick` |
| `.agents/notes/proposed/architecture/2026-09-09-trader-director.md` | Task 3 progress |

Did not change `packages/client-ui-*/src/client/**`. Did not rebuild kit-cn (`lib/` already exported `createIdleLane` / `routeTraderLanes`).

## Self-Review

- **Signatures**: `TraderDirectorHost.afterTick` input matches Host (`ticked` / `loop` / `nowMs`). `createOpportunityLane` / `createIdleLane` / `routeTraderLanes` used as specified.
- **Phase 1 idle B/C**: production constructor does not pass `riskRun`/`behaviorRun`; lanes stay `createIdleLane`. Test overlays only replace `run`; they fire only if `decide` is non-idle — Phase 1 idle makes `not.toHaveBeenCalled` hold.
- **Launch truncate**: regular path returns after opportunity `launch`; risk is never routed, so `riskRun` cannot fire.
- **Behavior equivalence**: lunch still writes session stub; regular still launches once. Review still hangs on opportunity Host after routing.
- **No live orders / no master trifork**: launch still only starts a trader session via existing `TasksRunner`.
- **Compatibility**: Host `afterTick` / `inFlight` / `settle` untouched; option-bar-agent 4 tests still green.
- **Linter**: no diagnostics on the new/changed TS files.

## Concerns

None blocking.

1. Test-only `riskRun`/`behaviorRun` do not prove `decide` was consulted on the stub path; that is already covered by Task 1 `routeTraderLanes` stub-continues-to-later-lanes.
2. `index.ts` wiring is not covered by an automated test (Host tests construct `TraderDirectorHost` directly). Manual/read check only.
3. Host standalone `afterTick` and Director `afterTick` can now diverge if one is edited without the other. Phase 1 they share `buildContext` / `runOpportunity` / `maybeWriteReview`.

## Commits

None (per plan constraint).
