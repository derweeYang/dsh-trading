# Task 6 Report: Agent note + spec status

**Status:** DONE
**Branch:** `etf-options`

## Scope

Documentation-only closure for ETF option paper account feature. No code changes.

## Changes

### Agent Note lifecycle

- **Moved** `.agents/notes/proposed/feature/2026-09-10-option-paper-account.md` → `.agents/notes/implemented/feature/2026-09-10-option-paper-account.md`
- **Status:** `implemented`
- **Proposal → Decision** (present tense): documents live behavior — `fillPrice` via `last ?? prevSettle`, `sizeQty` via `abs(premiumPer) + marginPer`, one open per `bucketStart`, no client UI
- **Verification & Gates + Risks → Consequences**
- **Deleted** proposed file

### Spec

- `docs/superpowers/specs/2026-09-10-option-paper-account-design.md`: `状态：implemented`, decision link updated to implemented path

## Verification

```text
pnpm --filter @dshtrading/api build              → PASS (797ms)
pnpm --filter @dshtrading/kit-cn test             → PASS (118 tests, incl. option-paper.test.ts 17)
pnpm --filter @dshtrading/client-ui-trading test  → PASS (417 tests, incl. bridge.test.ts)
```

## Self-review

| Check | Result |
|-------|--------|
| implemented/ AGENTS.md skeleton (Decision present, no Proposal) | ✓ |
| Consequences include fillPrice, sizeQty, one_fill, no client UI | ✓ |
| Spec status implemented | ✓ |
| Proposed file deleted | ✓ |
| No archived notes touched | ✓ |
| No client UI edits | ✓ |

## Commit

**SHA:** `176b18c` — `docs: mark option paper account implemented`

---

## Whole-branch Important findings follow-up

**Status:** DONE

### Fixes

- Equity now uses `cash + lockedMargin + signed current leg market value`; an unchanged credit spread remains at the initial CNY 100,000 equity.
- Chain-based leg completion is limited to `vertical`; other templates without explicit priced legs persist `no_quote`.
- Explicit leg quantity ratios are preserved and multiplied by the selected combo quantity.
- Missing, throwing, absent, or invalid margin results persist `no_quote`; adapters no longer turn failures into zero-margin success.
- Paper open, manage, and reset load-modify-save operations share an in-process lock keyed by data root.
- `close5` and `closed` recommendations do not open. The first live attempt, including a `no_quote` skip, consumes the bucket.

### Verification

```text
pnpm --filter @dshtrading/kit-cn build                         → PASS
pnpm --filter @dshtrading/client-ui-trading build              → PASS
pnpm --filter @dshtrading/kit-cn test                          → PASS (127 tests)
pnpm --filter @dshtrading/client-ui-trading test -- bridge.test.ts
                                                               → PASS (84 tests)
```

The bridge run emits expected task-ledger lock warnings from isolated test fixtures; all test files pass.
