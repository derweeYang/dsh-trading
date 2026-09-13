### Task 3: TraderDirectorHost 鎺ョ嚎

**Files:**
- Create: `packages/client-ui-trading/src/trader-director-host.ts`
- Create: `packages/client-ui-trading/test/trader-director-host.test.ts`
- Modify: `packages/client-ui-trading/src/index.ts`锛坄barAgent.afterTick` 鈫?`director.afterTick`锛?
**Interfaces:**
- Consumes: `OptionBarAgentHost`銆乣createOpportunityLane`銆乣createIdleLane`銆乣routeTraderLanes`
- Produces: `TraderDirectorHost.afterTick(input)` 鈥?瀹夸富鍞竴鍏ュ彛

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
  it('lunch 鏂版《锛氬啓 session 妗╋紱risk/behavior run 涓嶈璋冪敤', async () => {
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

  it('regular launch锛氫細 launch锛涙埅鏂悗 risk run 浠嶄笉璋冪敤', async () => {
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

Expected: FAIL锛堟ā鍧椾笉瀛樺湪锛?
- [ ] **Step 3: Implement `trader-director-host.ts`**

```ts
/**
 * 浜ゆ槗鍛樻€绘帶瀹夸富锛氱粍涓夎溅閬撱€佹寜 route 鎵ц銆佸鐩樻寕鍦ㄦ満浼?Host銆? */
import type { OptionCycleLoop } from '@dshtrading/api'
import {
  createIdleLane,
  routeTraderLanes,
  type TraderLane,
} from '@dshtrading/kit-cn'
import { createOpportunityLane, OptionBarAgentHost } from './option-bar-agent.ts'

export interface TraderDirectorHostOptions {
  opportunity: OptionBarAgentHost
  /** 浠呮祴璇曪細瑕嗙洊 risk.run锛屾柇瑷€ Phase1 涓嶈璋冪敤 */
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

娉ㄦ剰锛氭祴璇曠敤 `riskRun` 瑕嗗啓鍙湪 `decide` 闈?idle 鏃舵墠浼氳璋冨埌锛汸hase 1 idle 鏁?`not.toHaveBeenCalled` 鎴愮珛銆傝嫢瑕佹祴銆宻tub 鍚?decide 琚皟鐢ㄣ€嶏紝Task 1 宸茶鐩栥€?
- [ ] **Step 4: Wire `index.ts`**

鎶婏細

```ts
const barAgent = new OptionBarAgentHost({ ... })
// ...
return barAgent.afterTick({ ... })
```

鏀逛负锛?
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

Expected: 鍏ㄩ儴 PASS

- [ ] **Step 6: Commit**锛堜粎褰撶敤鎴锋槑纭姹傛椂锛?
```bash
git add packages/client-ui-trading/src/trader-director-host.ts packages/client-ui-trading/test/trader-director-host.test.ts packages/client-ui-trading/src/index.ts packages/client-ui-trading/src/option-bar-agent.ts
git commit -m "feat(client-ui-trading): wire TraderDirectorHost over option-bar"
```

---

