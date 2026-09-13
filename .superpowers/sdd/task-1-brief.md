### Task 1: kit-cn 璺敱绾嚱鏁帮紙TDD锛?
**Files:**
- Create: `packages/kit-cn/src/trader-director.ts`
- Create: `packages/kit-cn/test/trader-director.test.ts`
- Modify: `packages/kit-cn/src/index.ts`锛堝湪 `option-bar-ledger` 瀵煎嚭鏃佸姞涓€琛岋級

**Interfaces:**
- Consumes: `OptionCycleLoop`銆乣OptionIntradaySession`銆乣OptionBarSkipReason` from `@dshtrading/api`锛沗decideBarAgent`銆乣BarAgentDecision` from `./option-bar-ledger.js`
- Produces:
  - `LaneId`銆乣LaneAction`銆乣LaneDecision`銆乣DirectorTickContext`銆乣TraderLane`
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
  it('regular 鏂版《 鈫?launch', () => {
    expect(opportunityDecide(baseCtx()).action).toBe('launch')
  })

  it('llmBusy 鈫?overlap stub', () => {
    expect(opportunityDecide(baseCtx({ llmBusy: true }))).toMatchObject({
      action: 'stub',
      skipReason: 'overlap',
    })
  })
})

describe('routeTraderLanes', () => {
  it('opportunity launch 鍚庝笉鍐嶈闂?risk/behavior', () => {
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

  it('opportunity idle 鏃剁户缁棶 risk/behavior锛堜簩鑰?idle锛?, () => {
    const risk = createIdleLane('risk')
    const behavior = createIdleLane('behavior')
    const opportunity: TraderLane = {
      id: 'opportunity',
      decide: () => ({ action: 'idle' }),
    }
    const routed = routeTraderLanes(baseCtx({ ticked: false }), { opportunity, risk, behavior })
    expect(routed).toEqual([])
  })

  it('opportunity stub 浠嶈矾鐢?opportunity锛屽苟缁х画闂悗缁紙Phase1 idle锛?, () => {
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

  it('createIdleLane 浠绘剰 session 鎭?idle', () => {
    expect(createIdleLane('risk').decide(baseCtx({ session: 'close5' })).action).toBe('idle')
    expect(createIdleLane('behavior').decide(baseCtx()).action).toBe('idle')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dshtrading/kit-cn test -- trader-director`

Expected: FAIL锛堟ā鍧椾笉瀛樺湪鎴栧鍑虹己澶憋級

- [ ] **Step 3: Write minimal implementation**

Create `packages/kit-cn/src/trader-director.ts`:

```ts
/**
 * 浜ゆ槗鍛樻€绘帶锛氫笁杞﹂亾璺敱绾嚱鏁般€備笉绠楃浣撱€佷笉鍐欑洏銆佷笉璋?LLM銆? */
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

- [ ] **Step 5: Commit**锛堜粎褰撶敤鎴锋槑纭姹傛椂锛?
```bash
git add packages/kit-cn/src/trader-director.ts packages/kit-cn/test/trader-director.test.ts packages/kit-cn/src/index.ts
git commit -m "feat(kit-cn): add TraderDirector lane router"
```

---

