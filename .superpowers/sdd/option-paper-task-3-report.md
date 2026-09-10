# Task 3 Report: Persist paper files

Status: implemented and verified on branch `etf-options`.

## Changes

- Added paper account, positions, and dated fills path helpers.
- Added load, save, and reset persistence for the paper account.
- Added fail-safe open and manage wrappers with duplicate-bucket, close5, session-rollover, and invalidation handling.
- Open positions persist the recommendation `invalidIf` and forecast box bounds.
- Added temporary-directory persistence tests; no tool, HTTP, UI, or live-order hooks were added.

## RED evidence

Command:

`pnpm --filter @dshtrading/kit-cn test -- test/option-paper.test.ts`

Result before implementation: exit code 1. Vitest ran 15 tests and reported 5 failures caused by the missing persistence functions:

`TypeError: (0 , resetPaperState) is not a function`

`TypeError: (0 , tryPaperOpen) is not a function`

## GREEN evidence

Focused command:

`pnpm --filter @dshtrading/kit-cn test -- test/option-paper.test.ts`

Result: `15 passed (15)`.

Full package command:

`pnpm --filter @dshtrading/kit-cn test`

Result: `10 passed (10)` test files and `115 passed (115)` tests.

Build command:

`pnpm --filter @dshtrading/kit-cn build`

Result: exit code 0, `Build complete`.

`git diff --check` also exited successfully with no output.

## Concerns

- File persistence uses whole-file rewrites and is not protected by a cross-process lock; concurrent writers could race. Current Task 4–5 callers are expected to serialize through the host process.
- The pre-existing unrelated IV replay edits in `option-bar-ledger.ts` were left untouched and excluded from this task's commit.

## Important findings follow-up

- `tryPaperOpen` now resolves chain and margin data only for the current eligible pick and stops after the first successful open. Duplicate-bucket decisions persist without calling either dependency.
- Chain or margin failures are isolated to their pick; mark or last-close failures are isolated to their position.
- Added regressions proving a failing second chain cannot prevent the first pick from opening and one rejected mark cannot prevent another position from closing during `close5`.

Required command:

`pnpm --filter @dshtrading/kit-cn test -- test/option-paper.test.ts`

Result: exit code 0; `1 passed (1)` test file and `17 passed (17)` tests.
