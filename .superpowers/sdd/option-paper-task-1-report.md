# Task 1 Report: API types for ETF option paper account

**Status:** DONE  
**Branch:** `etf-options`  
**Commit:** `95e3dd3` — `feat(api): add option paper account types`

## Scope

Type-only changes in `@dshtrading/api` per task brief. No client UI, no kit-cn engine, no HTTP routes.

## Changes

### `packages/api/src/index.ts`

1. **`OptionBarPick`** — added optional `maxContracts?: number`.
2. **After `OptionBarRecommendation`** — added:
   - `OPTION_PAPER_INITIAL_CASH = 100_000`
   - `OPTION_MULTIPLIER = 10_000`
   - `PaperFillSkip`, `PaperFillReason`
   - `PaperLegFill`, `PaperFill`, `PaperPosition`, `PaperAccount`
   - `OptionPaperAccountWire`, `OptionPaperFillsWire`

Field names, union literals, and placement match the task brief exactly.

## Build

```text
pnpm --filter @dshtrading/api build  →  PASS (1418ms)
```

Numeric const exports compile cleanly; no fallback to comment-only literals was needed. Generated `lib/index.d.ts` exports all new symbols.

## Self-review

| Check | Result |
|-------|--------|
| Exact type names from brief | ✓ |
| `maxContracts` on `OptionBarPick` | ✓ |
| Types inserted after `OptionBarRecommendation` | ✓ |
| No client UI edits | ✓ |
| No paper engine / HTTP | ✓ |
| Only `packages/api/src/index.ts` committed | ✓ |
| Conventional Commits message | ✓ |

**Notes for Task 2 (kit-cn):**

- Wire shapes are ready for `GET /dshtrading/api/options/paper/account` and `.../fills`.
- Constants are importable from `@dshtrading/api`; kit-cn may re-export or consume directly.
- `PaperFill.skip` pairs with `reason: 'skipped'`; open/close fills use the other reason literals.

## Concerns

None. Task 1 is complete and unblocked for Task 2.
