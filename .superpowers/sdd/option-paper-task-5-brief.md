### Task 5: Tick manage + bridge routes

**Files:**
- Modify: `packages/client-ui-trading/src/bridge.ts`
  - end of `optionCycleTick` (after cycle loop, before return): `void tryPaperManage(...).catch(log)`
  - `dispatchBridgeRequest` cases:
    - `GET /options/paper/account`
    - `GET /options/paper/fills`
    - `POST /options/paper/reset`
- Modify: `packages/client-ui-trading/test/bridge.test.ts`
- Modify: `docs/options-bridge.md` — table rows
- Modify: `.gitignore` — `data/options/paper/`
- Modify: `data/options/README.md` — paper row

`equity`: `account.cash + sum(position mark)` where each sell leg marks `-qty*mark*10000` vs avg and buy `+qty*mark*10000` vs avg (or simpler: `cash + sum over legs of (mark-avg)*signedDelta` plus remaining margin still locked is already out of cash — equity = cash + marginLocked + option MTM). Spec: `equity = cash + Σ mark` with long last, short last. Implement: `equity = cash + position.marginCny + mtm` where `mtm = Σ for each leg (side==buy ? 1 : -1) * (mark - avgPrice) * qty * 10000`. If mark missing use avgPrice (mtm 0).

Fills GET: read today's jsonl, `limit` default 48, newest first.

Reset: `resetPaperState`, return account wire.

Tick `getLastClose`: reuse klines already fetched in the tick loop if possible; else `getKlines(spot, '1m', 5)` last close; `volumeRatio` from current box row if in scope.

- [ ] Bridge tests: GET account on temp `DSH_TRADING_OPTIONS_DATA` is 100000; POST reset; GET fills `ok`.
- [ ] Tick test: with a planted position and `asOf` in close5 window, positions empty after tick (inject data root).
- [ ] Confirm `placeOptionOrder` is never called from paper functions (grep + unit).

---
