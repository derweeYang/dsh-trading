# TraderDirector（交易员总控）Implementation Plan

> **状态（2026-09-10）：** Phase 1 已落地，决策记录改为 [implemented](../../.agents/notes/implemented/architecture/2026-09-09-trader-director.md)。Risk/Behavior 仍 idle。下文勾选是执行当时的清单，不再当未开工。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地薄编排层 `TraderDirector`：三车道端口（opportunity / risk / behavior），Phase 1 只实现机会车道且对外行为与现 `OptionBarAgentHost` 等价。

**Architecture:** 纯函数路由在 `kit-cn`；机会副作用仍在 `client-ui-trading` 的 Host。Director 先组 `DirectorTickContext`（含机会决策所需布尔量），再 `routeTraderLanes`；仅对 `launch`/`stub` 调 `run`；`launch` 后本 tick 不再调后续车道。Risk/Behavior 为恒 `idle` 的 no-op。

**Tech Stack:** TypeScript、vitest、`@dshtrading/api`、`@dshtrading/kit-cn`、`@dshtrading/client-ui-trading` node 半。

**Spec:** [2026-09-09-trader-director-design.md](./2026-09-09-trader-director-design.md)

## Global Constraints

- 数字只来自工具 JSON；禁止自编箱体或 1 分钟 K。
- `sessionFlag === 'regular'` 才开会话；一根 K 全市场一次。
- 预填 ≠ 下单；禁止自动实盘。
- 不启 master 三叉。
- Cursor 不改 `packages/client-ui-*/src/client/**`。
- 不新建事件总线 / `data/trader/` 账本。
- Phase 1 关闭风险抢占；Risk/Behavior 不启 LLM、不写盘。
- 用户未要求则不 git commit。

## 文件地图

| 文件 | 职责 |
|---|---|
| `packages/kit-cn/src/trader-director.ts` | `DirectorTickContext`、`TraderLane`、`createIdleLane`、`routeTraderLanes`、`opportunityDecide` |
| `packages/kit-cn/test/trader-director.test.ts` | 路由 / idle / launch 截断单测 |
| `packages/kit-cn/src/index.ts` | `export * from './trader-director.js'` |
| `packages/client-ui-trading/src/option-bar-agent.ts` | Host 改为「组 ctx → route → run」；抽出 `OpportunityLane` |
| `packages/client-ui-trading/src/trader-director-host.ts` | 组装三车道 + `afterTick` 入口 |
| `packages/client-ui-trading/src/index.ts` | tick 钩子改挂 `TraderDirectorHost` |
| `packages/client-ui-trading/test/option-bar-agent.test.ts` | 行为回归（lunch 桩 / close5 复盘） |
| `packages/client-ui-trading/test/trader-director-host.test.ts` | Director 挂载后仍等价 + B/C 不 run |
| `docs/specs/2026-09-09-trader-director-design.md` | 状态改为 plan-ready（实现后改 implemented 记在 Note） |

**澄清（相对规格 §2.1）：** `run` 在 `launch` **与** `stub` 时都会调用（机会车道写桩或启会话）；仅 `idle` 跳过 `run`。`launch` 之后截断后续车道。

---

### Task 1: kit-cn 路由纯函数（TDD）

**Files:**
- Create: `packages/kit-cn/src/trader-director.ts`
- Create: `packages/kit-cn/test/trader-director.test.ts`
- Modify: `packages/kit-cn/src/index.ts`（在 `option-bar-ledger` 导出旁加一行）

**Interfaces:**
- Consumes: `OptionCycleLoop`、`OptionIntradaySession`、`OptionBarSkipReason` from `@dshtrading/api`；`decideBarAgent`、`BarAgentDecision` from `./option-bar-ledger.js`
- Produces:
  - `LaneId`、`LaneAction`、`LaneDecision`、`DirectorTickContext`、`TraderLane`
  - `createIdleLane(id: 'risk' | 'behavior'): TraderLane`
  - `opportunityDecide(ctx: DirectorTickContext): LaneDecision`
  - `routeTraderLanes(ctx, lanes): readonly { id: LaneId; decision: LaneDecision }[]`

- [ ] **Step 1: Write the failing test**

Create `packages/kit-cn/test/trader-director.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { OptionCycleLoop } from '@dshtrading/api'
import {
  createIdleLane,
  opportunityDecide,
  routeTraderLanes,
  type DirectorTickContext,
  type TraderLane,
} from '../src/trader-director.ts'

const emptyLoop: OptionCycleLoop = {
  running: true,
  horizonMin: 5,
  lastBucket: '2026-09-08T01:45:00.000Z',
  rows: [],
}

function baseCtx(over: Partial<DirectorTickContext> = {}): DirectorTickContext {
  return {
    ticked: true,
    loop: emptyLoop,
    nowMs: Date.parse('2026-09-08T01:45:12.000Z'),
    session: 'regular',
    llmBusy: false,
    bucketStart: '2026-09-08T01:45:00.000Z',
    alreadyRecommended: false,
    allCalibrated: false,
    ...over,
  }
}

describe('opportunityDecide', () => {
  it('regular 新桶 → launch', () => {
    expect(opportunityDecide(baseCtx()).action).toBe('launch')
  })

  it('llmBusy → overlap stub', () => {
    expect(opportunityDecide(baseCtx({ llmBusy: true }))).toMatchObject({
      action: 'stub',
      skipReason: 'overlap',
    })
  })
})

describe('routeTraderLanes', () => {
  it('opportunity launch 后不再询问 risk/behavior', () => {
    const riskDecide = vi.fn(() => ({ action: 'idle' as const }))
    const behaviorDecide = vi.fn(() => ({ action: 'idle' as const }))
    const opportunity: TraderLane = {
      id: 'opportunity',
      decide: (ctx) => opportunityDecide(ctx),
    }
    const risk: TraderLane = { id: 'risk', decide: riskDecide }
    const behavior: TraderLane = { id: 'behavior', decide: behaviorDecide }
    const routed = routeTraderLanes(baseCtx(), { opportunity, risk, behavior })
    expect(routed).toEqual([{ id: 'opportunity', decision: expect.objectContaining({ action: 'launch' }) }])
    expect(riskDecide).not.toHaveBeenCalled()
    expect(behaviorDecide).not.toHaveBeenCalled()
  })

  it('opportunity idle 时继续问 risk/behavior（二者 idle）', () => {
    const risk = createIdleLane('risk')
    const behavior = createIdleLane('behavior')
    const opportunity: TraderLane = {
      id: 'opportunity',
      decide: () => ({ action: 'idle' }),
    }
    const routed = routeTraderLanes(baseCtx({ ticked: false }), { opportunity, risk, behavior })
    expect(routed).toEqual([])
  })

  it('opportunity stub 仍路由 opportunity，并继续问后续（Phase1 idle）', () => {
    const riskDecide = vi.fn(() => ({ action: 'idle' as const }))
    const behaviorDecide = vi.fn(() => ({ action: 'idle' as const }))
    const opportunity: TraderLane = {
      id: 'opportunity',
      decide: (ctx) => opportunityDecide(ctx),
    }
    const routed = routeTraderLanes(
      baseCtx({ session: 'lunch' }),
      {
        opportunity,
        risk: { id: 'risk', decide: riskDecide },
        behavior: { id: 'behavior', decide: behaviorDecide },
      },
    )
    expect(routed[0]).toMatchObject({ id: 'opportunity', decision: { action: 'stub', skipReason: 'session' } })
    expect(riskDecide).toHaveBeenCalled()
    expect(behaviorDecide).toHaveBeenCalled()
  })

  it('createIdleLane 任意 session 恒 idle', () => {
    expect(createIdleLane('risk').decide(baseCtx({ session: 'close5' })).action).toBe('idle')
    expect(createIdleLane('behavior').decide(baseCtx()).action).toBe('idle')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dshtrading/kit-cn test -- trader-director`

Expected: FAIL（模块不存在或导出缺失）

- [ ] **Step 3: Write minimal implementation**

Create `packages/kit-cn/src/trader-director.ts`:

```ts
/**
 * 交易员总控：三车道路由纯函数。不算箱体、不写盘、不调 LLM。
 */
import type { OptionCycleLoop, OptionIntradaySession, OptionBarSkipReason } from '@dshtrading/api'
import { decideBarAgent, type BarAgentDecision } from './option-bar-ledger.js'

export type LaneId = 'opportunity' | 'risk' | 'behavior'
export type LaneAction = 'idle' | 'launch' | 'stub'

export interface LaneDecision {
  readonly action: LaneAction
  readonly skipReason?: OptionBarSkipReason
  readonly bucketStart?: string
}

export interface DirectorTickContext {
  readonly ticked: boolean
  readonly loop: OptionCycleLoop
  readonly nowMs: number
  readonly session: OptionIntradaySession
  readonly llmBusy: boolean
  readonly bucketStart: string
  readonly alreadyRecommended: boolean
  readonly allCalibrated: boolean
}

export interface TraderLane {
  readonly id: LaneId
  decide(ctx: DirectorTickContext): LaneDecision
  run?(ctx: DirectorTickContext, decision: LaneDecision): Promise<void>
}

export function createIdleLane(id: 'risk' | 'behavior'): TraderLane {
  return {
    id,
    decide: () => ({ action: 'idle' }),
  }
}

export function opportunityDecide(ctx: DirectorTickContext): LaneDecision {
  const d: BarAgentDecision = decideBarAgent({
    ticked: ctx.ticked,
    session: ctx.session,
    inFlight: ctx.llmBusy,
    allCalibrated: ctx.allCalibrated,
    alreadyRecommended: ctx.alreadyRecommended,
    bucketStart: ctx.bucketStart,
  })
  return {
    action: d.action,
    ...(d.skipReason === undefined ? {} : { skipReason: d.skipReason }),
    bucketStart: d.bucketStart,
  }
}

export function routeTraderLanes(
  ctx: DirectorTickContext,
  lanes: {
    readonly opportunity: TraderLane
    readonly risk: TraderLane
    readonly behavior: TraderLane
  },
): readonly { id: LaneId; decision: LaneDecision }[] {
  const out: { id: LaneId; decision: LaneDecision }[] = []
  const o = lanes.opportunity.decide(ctx)
  if (o.action !== 'idle') {
    out.push({ id: 'opportunity', decision: o })
    if (o.action === 'launch') return out
  }
  const r = lanes.risk.decide(ctx)
  if (r.action !== 'idle') out.push({ id: 'risk', decision: r })
  const b = lanes.behavior.decide(ctx)
  if (b.action !== 'idle') out.push({ id: 'behavior', decision: b })
  return out
}
```

Add to `packages/kit-cn/src/index.ts`:

```ts
export * from './trader-director.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dshtrading/kit-cn test -- trader-director`

Expected: PASS

- [ ] **Step 5: Commit**（仅当用户明确要求时）

```bash
git add packages/kit-cn/src/trader-director.ts packages/kit-cn/test/trader-director.test.ts packages/kit-cn/src/index.ts
git commit -m "feat(kit-cn): add TraderDirector lane router"
```

---

### Task 2: OpportunityLane + Host 改为 route 驱动

**Files:**
- Modify: `packages/client-ui-trading/src/option-bar-agent.ts`
- Modify: `packages/client-ui-trading/test/option-bar-agent.test.ts`（保持现有两测全绿；必要时补 launch 测）

**Interfaces:**
- Consumes: Task 1 的 `DirectorTickContext`、`LaneDecision`、`TraderLane`、`opportunityDecide`、`routeTraderLanes`、`createIdleLane`
- Produces:
  - `OptionBarAgentHost` 仍暴露 `afterTick` / `inFlight` / `settle`（回归兼容）
  - `createOpportunityLane(host: OptionBarAgentHost): TraderLane` — `decide`→`opportunityDecide`；`run`→写桩或 launch（从现 `afterTick` 抽出）

- [ ] **Step 1: 重构 `option-bar-agent.ts`**

保留 `OptionBarAgentHost` 的 `inFlight` / `refreshInFlight` / `writeRec` / 复盘逻辑。将「决策 + launch/stub」抽成可被 Lane 调用的方法：

```ts
import {
  OPTION_BAR_AGENT_PROMPT,
  appendJsonlLine,
  cyclesPath,
  foldDailyReview,
  makeSkipRecommendation,
  opportunityDecide,
  recommendationsPath,
  reviewsPath,
  sessionAt,
  shanghaiCalendarDate,
  shanghaiBucketStartMs,
  shouldWriteDailyReview,
  readJsonl,
  type DirectorTickContext,
  type LaneDecision,
  type TraderLane,
} from '@dshtrading/kit-cn'

// ... OptionBarAgentOptions / class fields 不变 ...

/** 组 Director 上下文（读盘 + inFlight）。 */
async buildContext(input: {
  ticked: boolean
  loop: OptionCycleLoop
  nowMs: number
}): Promise<DirectorTickContext> {
  await this.refreshInFlight()
  const nowMs = input.nowMs
  const session = sessionAt(nowMs)
  const date = shanghaiCalendarDate(nowMs)
  const root = this.options.dataRoot()
  const bucketStart = input.loop.lastBucket ?? new Date(shanghaiBucketStartMs(nowMs)).toISOString()
  const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(root, date))
  const alreadyRecommended = recs.some((row) => row.bucketStart === bucketStart)
  const allCalibrated = input.loop.rows.length > 0
    && input.loop.rows.every((row) => row.latest?.forecast.noTradeReason === 'calibrated')
  return {
    ticked: input.ticked,
    loop: input.loop,
    nowMs,
    session,
    llmBusy: this.inFlight,
    bucketStart,
    alreadyRecommended,
    allCalibrated,
  }
}

/** 执行 opportunity 的 launch/stub 副作用（不含复盘）。 */
async runOpportunity(ctx: DirectorTickContext, decision: LaneDecision): Promise<void> {
  const root = this.options.dataRoot()
  const date = shanghaiCalendarDate(ctx.nowMs)
  const session = ctx.session
  const bucketStart = ctx.bucketStart

  if (decision.action === 'stub' && decision.skipReason !== undefined) {
    await this.writeRec(root, date, makeSkipRecommendation({
      bucketStart,
      asOf: new Date(ctx.nowMs).toISOString(),
      session,
      skipReason: decision.skipReason,
    }))
    return
  }

  if (decision.action !== 'launch') return

  const runner = this.options.runner?.()
  if (runner === undefined) {
    await this.writeRec(root, date, makeSkipRecommendation({
      bucketStart,
      asOf: new Date(ctx.nowMs).toISOString(),
      session,
      skipReason: 'launch_failed',
    }))
    return
  }

  this.inFlight = true
  try {
    const workspaceId = this.options.workspaceId?.()
    const sessionId = await runner.launch({
      id: `option-bar-${bucketStart}`,
      title: `ETF option bar ${bucketStart}`,
      prompt: `${OPTION_BAR_AGENT_PROMPT}\n\nbucketStart=${bucketStart}\nasOf=${new Date(ctx.nowMs).toISOString()}`,
      agentPreset: 'trader',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
    this.openSessionId = sessionId
    this.openStartedAt = ctx.nowMs
  } catch (error) {
    this.inFlight = false
    this.openSessionId = undefined
    this.options.log?.('option-bar launch failed', error)
    await this.writeRec(root, date, makeSkipRecommendation({
      bucketStart,
      asOf: new Date(ctx.nowMs).toISOString(),
      session,
      skipReason: 'launch_failed',
    }))
  }
}

async maybeWriteReview(nowMs: number): Promise<void> {
  const session = sessionAt(nowMs)
  const date = shanghaiCalendarDate(nowMs)
  const root = this.options.dataRoot()
  const reviewFile = reviewsPath(root, date)
  const exists = await fileExists(reviewFile)
  if (!shouldWriteDailyReview(session, exists)) return
  const cycles = await readJsonl<OptionCycle>(cyclesPath(root, date))
  const recommendations = await readJsonl<OptionBarRecommendation>(recommendationsPath(root, date))
  const md = foldDailyReview({ date, cycles, recommendations })
  await mkdir(path.dirname(reviewFile), { recursive: true })
  await writeFile(reviewFile, md, 'utf8')
}

/** 兼容旧入口：单车道机会路径（无 Director）。 */
async afterTick(input: { ticked: boolean; loop: OptionCycleLoop; nowMs: number }): Promise<void> {
  const ctx = await this.buildContext(input)
  const decision = opportunityDecide(ctx)
  if (decision.action === 'launch' || decision.action === 'stub') {
    await this.runOpportunity(ctx, decision)
  }
  await this.maybeWriteReview(input.nowMs)
}

export function createOpportunityLane(host: OptionBarAgentHost): TraderLane {
  return {
    id: 'opportunity',
    decide: (ctx) => opportunityDecide(ctx),
    run: async (ctx, decision) => {
      await host.runOpportunity(ctx, decision)
    },
  }
}
```

删除 Host 内对 `decideBarAgent` 的直接调用（改走 `opportunityDecide`）。`refreshInFlight` / `writeRec` / `settle` / `fileExists` 保持原样。

- [ ] **Step 2: Run existing Host tests**

Run: `pnpm --filter @dshtrading/client-ui-trading test -- option-bar-agent`

Expected: PASS（lunch 桩、close5 复盘不覆盖）

- [ ] **Step 3: Commit**（仅当用户明确要求时）

```bash
git add packages/client-ui-trading/src/option-bar-agent.ts packages/client-ui-trading/test/option-bar-agent.test.ts
git commit -m "refactor(client-ui-trading): split option-bar host for director lanes"
```

---

### Task 3: TraderDirectorHost 接线

**Files:**
- Create: `packages/client-ui-trading/src/trader-director-host.ts`
- Create: `packages/client-ui-trading/test/trader-director-host.test.ts`
- Modify: `packages/client-ui-trading/src/index.ts`（`barAgent.afterTick` → `director.afterTick`）

**Interfaces:**
- Consumes: `OptionBarAgentHost`、`createOpportunityLane`、`createIdleLane`、`routeTraderLanes`
- Produces: `TraderDirectorHost.afterTick(input)` — 宿主唯一入口

- [ ] **Step 1: Write the failing test**

Create `packages/client-ui-trading/test/trader-director-host.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { OptionBarRecommendation } from '@dshtrading/api'
import { readJsonl, recommendationsPath } from '@dshtrading/kit-cn'
import { OptionBarAgentHost } from '../src/option-bar-agent.ts'
import { TraderDirectorHost } from '../src/trader-director-host.ts'

const LUNCH = Date.parse('2026-09-08T03:25:00.000Z')
const REGULAR = Date.parse('2026-09-08T01:45:00.000Z')

describe('TraderDirectorHost', () => {
  it('lunch 新桶：写 session 桩；risk/behavior run 不被调用', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'director-'))
    const riskRun = vi.fn(async () => {})
    const behaviorRun = vi.fn(async () => {})
    const opportunity = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => 's1',
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    const director = new TraderDirectorHost({
      opportunity,
      riskRun,
      behaviorRun,
    })
    await director.afterTick({
      ticked: true,
      nowMs: LUNCH,
      loop: {
        running: true,
        horizonMin: 5,
        lastBucket: '2026-09-08T03:25:00.000Z',
        rows: [],
      },
    })
    const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(dir, '2026-09-08'))
    expect(recs[0]?.skipReason).toBe('session')
    expect(riskRun).not.toHaveBeenCalled()
    expect(behaviorRun).not.toHaveBeenCalled()
  })

  it('regular launch：会 launch；截断后 risk run 仍不调用', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'director-'))
    let launched = 0
    const riskRun = vi.fn(async () => {})
    const opportunity = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => {
          launched += 1
          return 's1'
        },
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    const director = new TraderDirectorHost({ opportunity, riskRun })
    await director.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: {
        running: true,
        horizonMin: 5,
        lastBucket: '2026-09-08T01:45:00.000Z',
        rows: [],
      },
    })
    expect(launched).toBe(1)
    expect(riskRun).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dshtrading/client-ui-trading test -- trader-director-host`

Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement `trader-director-host.ts`**

```ts
/**
 * 交易员总控宿主：组三车道、按 route 执行、复盘挂在机会 Host。
 */
import type { OptionCycleLoop } from '@dshtrading/api'
import {
  createIdleLane,
  routeTraderLanes,
  type TraderLane,
} from '@dshtrading/kit-cn'
import { createOpportunityLane, OptionBarAgentHost } from './option-bar-agent.ts'

export interface TraderDirectorHostOptions {
  opportunity: OptionBarAgentHost
  /** 仅测试：覆盖 risk.run，断言 Phase1 不被调用 */
  riskRun?: () => Promise<void>
  behaviorRun?: () => Promise<void>
}

export class TraderDirectorHost {
  private readonly opportunity: OptionBarAgentHost
  private readonly lanes: {
    opportunity: TraderLane
    risk: TraderLane
    behavior: TraderLane
  }

  constructor(options: TraderDirectorHostOptions) {
    this.opportunity = options.opportunity
    const risk = createIdleLane('risk')
    const behavior = createIdleLane('behavior')
    this.lanes = {
      opportunity: createOpportunityLane(options.opportunity),
      risk: options.riskRun === undefined
        ? risk
        : { ...risk, run: async () => { await options.riskRun!() } },
      behavior: options.behaviorRun === undefined
        ? behavior
        : { ...behavior, run: async () => { await options.behaviorRun!() } },
    }
  }

  async afterTick(input: {
    ticked: boolean
    loop: OptionCycleLoop
    nowMs: number
  }): Promise<void> {
    const ctx = await this.opportunity.buildContext(input)
    const routed = routeTraderLanes(ctx, this.lanes)
    for (const { id, decision } of routed) {
      const lane = this.lanes[id]
      if (decision.action === 'launch' || decision.action === 'stub') {
        await lane.run?.(ctx, decision)
      }
    }
    await this.opportunity.maybeWriteReview(input.nowMs)
  }
}
```

注意：测试用 `riskRun` 覆写只在 `decide` 非 idle 时才会被调到；Phase 1 idle 故 `not.toHaveBeenCalled` 成立。若要测「stub 后 decide 被调用」，Task 1 已覆盖。

- [ ] **Step 4: Wire `index.ts`**

把：

```ts
const barAgent = new OptionBarAgentHost({ ... })
// ...
return barAgent.afterTick({ ... })
```

改为：

```ts
import { TraderDirectorHost } from './trader-director-host.ts'

const barAgent = new OptionBarAgentHost({ ... })
const director = new TraderDirectorHost({ opportunity: barAgent })
// ...
return director.afterTick({
  ticked: result.ticked,
  loop: result.loop,
  nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
})
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @dshtrading/kit-cn test -- trader-director
pnpm --filter @dshtrading/client-ui-trading test -- option-bar-agent
pnpm --filter @dshtrading/client-ui-trading test -- trader-director-host
```

Expected: 全部 PASS

- [ ] **Step 6: Commit**（仅当用户明确要求时）

```bash
git add packages/client-ui-trading/src/trader-director-host.ts packages/client-ui-trading/test/trader-director-host.test.ts packages/client-ui-trading/src/index.ts packages/client-ui-trading/src/option-bar-agent.ts
git commit -m "feat(client-ui-trading): wire TraderDirectorHost over option-bar"
```

---

### Task 4: 文档收口

**Files:**
- Modify: `docs/specs/2026-09-09-trader-director-design.md` — 状态行改为 `proposed（计划已就绪）`；§2.1 旁注 `run` 含 stub
- Modify: `.agents/notes/proposed/architecture/2026-09-09-trader-director.md` — Proposal 末加计划链接

- [ ] **Step 1: 规格状态与 stub 澄清**

在设计文档头部状态改为：

```markdown
- 状态：proposed（计划已就绪 → [plan](./2026-09-09-trader-director-plan.md)）
```

在 §2.1「仅对 `launch` 调 `run`」改为：

```markdown
- 对 `launch` 与 `stub` 调 `run`（机会写桩或启会话）；`idle` 不调；`launch` 后截断后续车道
```

- [ ] **Step 2: Note 加计划链接**

在 Proposal 末追加：

```markdown
实现计划：[docs/specs/2026-09-09-trader-director-plan.md](../../../../docs/specs/2026-09-09-trader-director-plan.md)。
```

- [ ] **Step 3: Commit**（仅当用户明确要求时）

```bash
git add docs/specs/2026-09-09-trader-director-design.md docs/specs/2026-09-09-trader-director-plan.md .agents/notes/proposed/architecture/2026-09-09-trader-director.md
git commit -m "docs: add TraderDirector implementation plan"
```

---

## Spec coverage（自检）

| 规格要求 | 任务 |
|---|---|
| TraderDirector + 三端口 | Task 1–3 |
| Opportunity = option-bar | Task 2–3 |
| Risk/Behavior no-op | Task 1 `createIdleLane` + Task 3 |
| 行为等价（时段/桩/复盘） | Task 2–3 回归测 |
| 无事件总线 / 无下单 / 无 master | Global Constraints |
| launch 截断后续车道 | Task 1 单测 |
| llmBusy → overlap | Task 1 |
| 文档写清 B/C 边界 | Task 4 + 已有 design §9 |

## Placeholder scan

无 TBD /「稍后实现」步骤；B/C 的 Phase 2/3 仅在 design §9，本计划不实现。
