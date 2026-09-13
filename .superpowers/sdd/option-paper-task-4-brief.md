### Task 4: Hook recommendation write

**Files:**
- Modify: `packages/kit-cn/src/options-tools.ts` — after `appendJsonlLine` in `createPutOptionBarRecommendationTool`
- Modify: `packages/kit-cn/src/options-tools.ts` `OptionToolOptions` to accept optional `getChain` / `getMargin` (if absent, tryPaperOpen noops chain → skip `no_quote` or skip hook)
- Modify: `packages/client-ui-trading/src/option-bar-agent.ts` `writeRec`
- Modify: `packages/kit-cn/test/options-tools.test.ts`
- Modify: `packages/client-ui-trading/test/option-bar-agent.test.ts`

After successful append:

```ts
void tryPaperOpen({
  root,
  date,
  rec: row,
  forecastByUnderlying,
  nowIso: new Date(nowMs).toISOString(),
  getChain: options.getChain ?? (async () => undefined),
  getMargin: options.getMargin ?? (async () => 0),
}).catch(() => {})
```

Host `writeRec`: same, using `this.options.getCnOptions?.().getOptionChain` and `getStrategy` for margin (`result.margin?.totalInitial ?? 0`). If `getCnOptions` missing, still call tryPaperOpen with undefined chain.

Add test: put tool with live rec + injected chain writes `paper/fills/*.jsonl`. Existing no_edge test still has no paper fill.

- [ ] Write failing test on put-tool paper fill
- [ ] Wire hooks
- [ ] `pnpm --filter @dshtrading/kit-cn test` and `pnpm --filter @dshtrading/client-ui-trading test -- test/option-bar-agent.test.ts` PASS

---
