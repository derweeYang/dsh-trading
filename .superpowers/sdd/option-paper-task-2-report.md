# Task 2 Report: Pure option paper engine

Status: implemented and verified on branch `etf-options`.

## Changes

- Added the pure ETF option paper-account engine in `packages/kit-cn/src/option-paper.ts`.
- Added the brief's verbatim 10-test suite in `packages/kit-cn/test/option-paper.test.ts`.
- Re-exported the engine from `packages/kit-cn/src/index.ts`.
- The engine only computes in-memory state; it does not persist files, expose HTTP, call `placeOptionOrder`, or enable `liveTrading`.

## RED evidence

Command:

`pnpm --filter @dshtrading/kit-cn test -- test/option-paper.test.ts`

Result before implementation: exit code 1. Vitest reported one failed suite because `../src/option-paper.js` did not exist:

`Error: Cannot find module '../src/option-paper.js'`

## GREEN evidence

The same command after implementation and again after the public export:

`Test Files  1 passed (1)`

`Tests  10 passed (10)`

The package build also passed:

`pnpm --filter @dshtrading/kit-cn build`

`20 files, total: 160.48 kB`

`Build complete`

`git diff --check` exited successfully with no output.

## Concern

The brief's `sizeQty` prose says to test net cash with `cash + premiumPer * qty - marginPer * qty`, which would return 6 for `(10, 400, 218, 282)`. Its required verbatim test expects 0. The implementation treats the test as authoritative and reserves gross `abs(premiumPer) + marginPer` capital when sizing; open-account settlement still uses the separately specified signed-premium formula `cash + premiumCny - marginCny`.
