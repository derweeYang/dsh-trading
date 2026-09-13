### Task 2: OpportunityLane + Host 鏀逛负 route 椹卞姩

**Files:**
- Modify: `packages/client-ui-trading/src/option-bar-agent.ts`
- Modify: `packages/client-ui-trading/test/option-bar-agent.test.ts`锛堜繚鎸佺幇鏈変袱娴嬪叏缁匡紱蹇呰鏃惰ˉ launch 娴嬶級

**Interfaces:**
- Consumes: Task 1 鐨?`DirectorTickContext`銆乣LaneDecision`銆乣TraderLane`銆乣opportunityDecide`銆乣routeTraderLanes`銆乣createIdleLane`
- Produces:
  - `OptionBarAgentHost` 浠嶆毚闇?`afterTick` / `inFlight` / `settle`锛堝洖褰掑吋瀹癸級
  - `createOpportunityLane(host: OptionBarAgentHost): TraderLane` 鈥?`decide`鈫抈opportunityDecide`锛沗run`鈫掑啓妗╂垨 launch锛堜粠鐜?`afterTick` 鎶藉嚭锛?
- [ ] **Step 1: 閲嶆瀯 `option-bar-agent.ts`**

淇濈暀 `OptionBarAgentHost` 鐨?`inFlight` / `refreshInFlight` / `writeRec` / 澶嶇洏閫昏緫銆傚皢銆屽喅绛?+ launch/stub銆嶆娊鎴愬彲琚?Lane 璋冪敤鐨勬柟娉曪細

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

// ... OptionBarAgentOptions / class fields 涓嶅彉 ...

/** 缁?Director 涓婁笅鏂囷紙璇荤洏 + inFlight锛夈€?*/
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

/** 鎵ц opportunity 鐨?launch/stub 鍓綔鐢紙涓嶅惈澶嶇洏锛夈€?*/
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

/** 鍏煎鏃у叆鍙ｏ細鍗曡溅閬撴満浼氳矾寰勶紙鏃?Director锛夈€?*/
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

鍒犻櫎 Host 鍐呭 `decideBarAgent` 鐨勭洿鎺ヨ皟鐢紙鏀硅蛋 `opportunityDecide`锛夈€俙refreshInFlight` / `writeRec` / `settle` / `fileExists` 淇濇寔鍘熸牱銆?
- [ ] **Step 2: Run existing Host tests**

Run: `pnpm --filter @dshtrading/client-ui-trading test -- option-bar-agent`

Expected: PASS锛坙unch 妗┿€乧lose5 澶嶇洏涓嶈鐩栵級

- [ ] **Step 3: Commit**锛堜粎褰撶敤鎴锋槑纭姹傛椂锛?
```bash
git add packages/client-ui-trading/src/option-bar-agent.ts packages/client-ui-trading/test/option-bar-agent.test.ts
git commit -m "refactor(client-ui-trading): split option-bar host for director lanes"
```

---

