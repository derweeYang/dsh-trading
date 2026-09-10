# Task 5 Report: Tick manage + bridge routes

**Status:** DONE  
**Branch:** `etf-options`  
**Commit:** `b7abcd6` — `feat(client-ui-trading): expose option paper account bridge`

## Delivered

- Added node-half routes:
  - `GET /options/paper/account`
  - `GET /options/paper/fills?limit=`
  - `POST /options/paper/reset`
- Account equity is `cash + locked margin + leg MTM`; missing marks fall back to each leg's fill price.
- `optionCycleTick` launches fail-safe paper position management after cycle processing, reusing current box values and fetching a short 1-minute fallback when needed.
- Paper management only reads option chains/spot bars and never calls `placeOptionOrder`.
- Added temp-root bridge/reset/fills tests and a close5 tick test that asserts positions flatten without invoking the order service.
- Ignored `data/options/paper/` and documented only the paper data/route rows.

## Verification

```text
pnpm --filter @dshtrading/client-ui-trading test -- test/bridge.test.ts
PASS — 68 tests

pnpm --filter @dshtrading/client-ui-trading build
PASS

git diff --cached --check
PASS

rg placeOptionOrder packages/kit-cn/src/option-paper.ts
PASS — no matches
```

## Scope control

Only `.gitignore`, the paper rows in `data/options/README.md` and
`docs/options-bridge.md`, and the node bridge/test files were committed.
Existing Python/IV replay and other local changes remain untouched and uncommitted.

## Concerns

None.

## Fix: invalidIf uses 1m close (Important finding)

**Problem:** `tryPaperManage` `getLastClose` preferred box row `last` (ticker price). `invalidIf` must judge against the latest completed 1-minute K-line close.

**Change:** Always fetch `market.getKlines(spot, '1m', 5)` for `lastClose`; return `undefined` on failure/empty (skip position). `volumeRatio` still from box row when in scope.

**Test:** `POST /options/cycles/tick：invalidIf 用 1m K 线 close，不用 ticker last` — ticker 3.2 outside planted box [2.95, 3.05], 1m close 3.0 inside → position kept; asserts `getKlines(..., '1m', 5)` called.

```text
pnpm --filter @dshtrading/client-ui-trading test -- test/bridge.test.ts
PASS — 69 tests
```
