### Task 1: API types

**Files:**
- Modify: `packages/api/src/index.ts` (after `OptionBarRecommendation`)
- Test: `packages/kit-cn/test/option-paper.test.ts` (types consumed in Task 2; this task is type-only — run `pnpm --filter @dshtrading/api build`)

**Interfaces:**

Add to `OptionBarPick`:

```ts
readonly maxContracts?: number
```

Add after `OptionBarRecommendation`:

```ts
export const OPTION_PAPER_INITIAL_CASH = 100_000
export const OPTION_MULTIPLIER = 10_000

export type PaperFillSkip =
  | 'duplicate_bucket'
  | 'no_quote'
  | 'no_forecast'
  | 'no_cash'
  | 'bad_template'
  | 'one_fill'

export type PaperFillReason = 'signal' | 'invalidIf' | 'close5' | 'session' | 'skipped'

export interface PaperLegFill {
  readonly code: string
  readonly side: 'buy' | 'sell'
  readonly qty: number
  readonly fillPrice: number
}

export interface PaperFill {
  readonly id: string
  readonly bucketStart: string
  readonly asOf: string
  readonly underlying?: string
  readonly template?: string
  readonly offset: 'open' | 'close'
  readonly qty: number
  readonly legs: readonly PaperLegFill[]
  readonly premiumCny: number
  readonly marginCny: number
  readonly cashAfter: number
  readonly reason: PaperFillReason
  readonly skip?: PaperFillSkip
}

export interface PaperPosition {
  readonly id: string
  readonly underlying: string
  readonly template: string
  readonly openedBucketStart: string
  readonly invalidIf: string
  readonly qty: number
  readonly marginCny: number
  readonly boxLow?: number
  readonly boxHigh?: number
  readonly legs: readonly PaperLegFill[]
}

export interface PaperAccount {
  readonly currency: 'CNY'
  readonly initialCash: number
  readonly cash: number
  readonly realizedPnl: number
  readonly updatedAt: string
}

export interface OptionPaperAccountWire {
  readonly ok: true
  readonly account: PaperAccount
  readonly equity: number
  readonly positions: readonly PaperPosition[]
}

export interface OptionPaperFillsWire {
  readonly ok: true
  readonly fills: readonly PaperFill[]
}
```

- [ ] **Step 1:** Insert the types above. Do not add runtime code in api (package is types-only except `const` numbers — if api forbids values, put constants only in kit-cn and duplicate the numeric literals `100000` / `10000` in api as comments; prefer exporting consts from kit-cn `OPTION_PAPER_INITIAL_CASH` if api build fails on values).

- [ ] **Step 2:** Run `pnpm --filter @dshtrading/api build`

Expected: PASS

- [ ] **Step 3:** Commit only if the user asked for commits. Otherwise leave staged-uncommitted.

---
