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
