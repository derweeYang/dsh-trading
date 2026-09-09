# ETF 期权 5 分钟 K 智能体 Implementation Plan

> **For agentic workers:** 本会话按 inline 执行（用户已说「继续」）。规格：[2026-09-08-option-bar-agent.md](./2026-09-08-option-bar-agent.md)。

**Goal:** regular 时段每根 5 分钟 K 开一轮 trader，把推荐（含赚哪类钱）落到本仓 `data/options/`；盘后确定性汇总，不开 LLM。

**Architecture:** L0 打分仍是 `kit-cn` 纯函数。新增文件账本与「是否开会话」决策。宿主 tick 落盘并事件触发 `TasksRunner.launch`。LLM 用 `cn_put_option_bar_recommendation` 写有效推荐；跳过/重叠由宿主写桩。不改 `src/client/**`。

**Tech Stack:** TypeScript、vitest、`@dshtrading/api`、`@dshtrading/kit-cn`、client-ui-trading node 半、`TasksRunner`。

## Global Constraints

- 数字只来自工具 JSON；禁止自编箱体或 1 分钟 K。
- `sessionFlag === 'regular'` 才开会话；一根 K 全市场一次。
- 预填 ≠ 下单；禁止 `POST /options/order`。
- Cursor 不改 `packages/client-ui-*/src/client/**`。
- 不写 `knowledge-stock` L5；不写 `~/.dsh/` 流水账。
- 用户未要求则不 git commit。

## 文件地图

| 文件 | 职责 |
|---|---|
| `packages/api/src/index.ts` | `OptionBarRecommendation` 等契约 |
| `packages/kit-cn/src/option-bar-ledger.ts` | 路径、jsonl、校验、决策、复盘折叠、prompt |
| `packages/kit-cn/src/options-tools.ts` | `cn_put_option_bar_recommendation` |
| `packages/kit-cn/src/index.ts` | 导出 + 注册工具 |
| `packages/client-ui-trading/src/option-bar-agent.ts` | 宿主：桩 / launch / 复盘 |
| `packages/client-ui-trading/src/bridge.ts` | tick 落 cycles；回放 |
| `packages/client-ui-trading/src/index.ts` | 启动回放 + tick 后 hook |
| `packages/base/src/presets.ts` | trader 白名单加 skill |
| `.agents/skills/option-intraday-workflow/SKILL.md` + kit 副本 | 六段输出 + 写工具 |
| `data/options/README.md` | 目录契约 |
| `knowledge-stock/L3_methodology/option_intraday_review.md` | 初始化长文 |
| `data/options/seed-cards.json` | 10 张卡片草稿 |

---

### Task 1: API 推荐契约

**Files:**
- Modify: `packages/api/src/index.ts`（`OptionCycleLoop` 之后）
- Test: 类型由 Task 2 运行时校验消费

**Interfaces:**
- Produces: `OptionBarOpportunity`、`OptionBarSkipReason`、`OptionBarPick`、`OptionBarRecommendation`

- [ ] **Step 1: 在 `OptionCycleLoop` 后追加类型**

```ts
export type OptionBarOpportunity =
  | 'theta_rent' | 'rv_vs_iv' | 'direction_delta'
  | 'mean_reversion' | 'covered_yield' | 'no_edge'

export type OptionBarSkipReason = 'session' | 'calibrated' | 'overlap' | 'launch_failed'

export interface OptionBarPick {
  readonly underlying: string
  readonly regime: OptionIntradayRegime
  readonly template: OptionIntradayCandidate['template']
  readonly cycleId: string
  readonly legs?: readonly unknown[]
}

export interface OptionBarRecommendation {
  readonly bucketStart: string
  readonly asOf: string
  readonly session: OptionIntradaySession
  readonly opportunity: OptionBarOpportunity
  readonly edge: string
  readonly logic: string
  readonly playbook: string
  readonly invalidIf: string
  readonly picks: readonly OptionBarPick[]
  readonly noTrade: boolean
  readonly skipReason?: OptionBarSkipReason
  readonly previousScore?: { readonly cycleId: string; readonly verdict: OptionCycleVerdict }
}
```

- [ ] **Step 2: 重建 api** — `pnpm --filter @dshtrading/api build`

---

### Task 2: 账本纯函数（TDD）

**Files:**
- Create: `packages/kit-cn/src/option-bar-ledger.ts`
- Create: `packages/kit-cn/test/option-bar-ledger.test.ts`
- Modify: `packages/kit-cn/src/index.ts`（`export * from './option-bar-ledger.js'`）

**Interfaces:**
- Consumes: Task 1 类型、`sessionFlag`、`OptionCycle`、`OptionCycleBook`
- Produces: `optionsDataRoot`、`shanghaiCalendarDate`、`appendJsonlLine`、`readJsonl`、`latestByKey`、`replayCyclesIntoBook`、`opportunityAllowed`、`normalizeRecommendation`、`decideBarAgent`、`shouldWriteDailyReview`、`foldDailyReview`、`OPTION_BAR_AGENT_PROMPT`、`makeSkipRecommendation`

- [ ] **Step 1: 写失败测** — 见实现时的 `option-bar-ledger.test.ts`（session 边界、opportunity 校验、overlap、复盘不覆盖、jsonl last-wins）

- [ ] **Step 2: 实现 `option-bar-ledger.ts`**

决策表：`!ticked` 或已有同行 → `idle`；`session !== 'regular'` → stub `session`；全 `calibrated` → stub `calibrated`；`inFlight` → stub `overlap`；否则 `launch`。

opportunity 表与规格 §5 一致。`covered_yield` 另需 `heldQty >= 10000` 且模板在该行 `candidates`。

- [ ] **Step 3:** `pnpm --filter @dshtrading/kit-cn test`

---

### Task 3: tick 落盘 + 启动回放

**Files:**
- Modify: `packages/client-ui-trading/src/bridge.ts`（`optionCycleTick`、构造可注入 `dataRoot` / `persist`）
- Modify: `packages/client-ui-trading/src/index.ts`（启动 `replayCyclesIntoBook`）
- Test: `packages/client-ui-trading/test/bridge.test.ts` 增补回放/落盘（有则扩；无则只测 ledger）

- [ ] 每次 `upsert` 后 `appendJsonlLine(cycles/YYYY-MM-DD.jsonl, cycle)`
- [ ] `apply()` 里 `await replayCyclesIntoBook(book, readJsonl(today))`
- [ ] 目录不可写：catch 打日志，内存继续

---

### Task 4: 宿主决策 + 桩 + 复盘 + launch

**Files:**
- Create: `packages/client-ui-trading/src/option-bar-agent.ts`
- Modify: `packages/client-ui-trading/src/index.ts`（tick 成功后 `void runOptionBarAgentAfterTick(...)`）
- Test: `packages/kit-cn/test/option-bar-ledger.test.ts` 已覆盖决策；host 测可用内存 fs

`runOptionBarAgentAfterTick`：

1. `decideBarAgent(...)`
2. `idle` 返回
3. `stub` → `appendJsonlLine(recommendations/...)`
4. `launch` → `inFlight=true`，`TasksRunner.launch({ title, prompt: OPTION_BAR_AGENT_PROMPT + bucket 段, agentPreset: 'trader' })`；失败写 `launch_failed`
5. `inspect` 稍后把 `inFlight=false`（5s 轮询，终局即清）
6. `shouldWriteDailyReview(session, exists)` 为真则写 `reviews/YYYY-MM-DD.md`

Prompt 禁止 klines / 下单；要求先调 `cn_put_option_bar_recommendation`。

---

### Task 5: 写入工具

**Files:**
- Modify: `packages/kit-cn/src/options-tools.ts`
- Modify: `packages/kit-cn/src/index.ts` 注册
- Test: `packages/kit-cn/test/options-tools.test.ts`

`cn_put_option_bar_recommendation`：参数为推荐 JSON 字符串；`normalizeRecommendation` 失败抛错；成功 append。`getDataRoot` 可注入。

---

### Task 6: skill + trader 白名单

**Files:**
- Modify: `.agents/skills/option-intraday-workflow/SKILL.md`
- Modify: `packages/kit-cn/assets/skills/option-intraday-workflow.md`（或 `node scripts/sync-skills.mjs`）
- Modify: `packages/kit-cn/test/options-tools.test.ts`（skill 正文断言）
- Modify: `packages/base/src/presets.ts` trader 数组加 `'option-intraday-workflow'`
- Modify: `packages/base/test/presets.test.ts` 期望字符串

输出改为六段；L0 写明 regular 才开会话、用 `cn_put_option_bar_recommendation`。

---

### Task 7: 目录 README、gitignore、桥文档、种子

**Files:**
- Create: `data/options/README.md`
- Modify: `.gitignore` 加 `data/options/cycles/`、`recommendations/`、`reviews/`
- Modify: `docs/options-bridge.md` 补 bar-agent 段
- Create: `knowledge-stock/L3_methodology/option_intraday_review.md`
- Modify: `knowledge-stock/L3_methodology/README.md`、`meta/changelog.md`
- Create: `data/options/seed-cards.json`（10 张 `manual` 草稿）

---

### Task 8: 门禁

- [ ] `pnpm --filter @dshtrading/api build`
- [ ] `pnpm --filter @dshtrading/kit-cn test`
- [ ] `pnpm --filter @dshtrading/base test`
- [ ] `pnpm --filter @dshtrading/client-ui-trading test`

---

## Spec coverage

| 规格 | 任务 |
|---|---|
| §3 时钟 / regular | 2、4 |
| §4 数据目录 | 2、3、7 |
| §4.3 复盘无 LLM | 2、4 |
| §5 机会闭集 | 2、5 |
| §6 LLM / trader / 禁 klines | 4、5、6 |
| §7 种子卡片 | 7 |
| §9 测试 | 2、8 |
