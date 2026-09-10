/**
 * 5 分钟 K 智能体宿主编排：落推荐桩、事件触发 trader 会话、确定性盘后复盘。
 * 不算箱体、不下单。
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CnOptionsService, OptionBarContextPacket, OptionBarFact, OptionBarRecommendation, OptionBarSessionEvent, OptionBarSessionOutcome, OptionCycle, OptionCycleLoop } from '@dshtrading/api'
import {
  OPTION_BAR_AGENT_PROMPT,
  appendJsonlLine,
  buildBarContextPacket,
  cyclesPath,
  backfillIvDailyFromPackets,
  foldDailyReview,
  makeSkipRecommendation,
  opportunityDecide,
  optionSessionsPath,
  packetsPath,
  recommendationsPath,
  reviewsPath,
  sessionAt,
  shanghaiCalendarDate,
  shanghaiBucketStartMs,
  shouldWriteDailyReview,
  readJsonl,
  tryPaperOpen,
  type DirectorTickContext,
  type LaneDecision,
  type TraderLane,
} from '@dshtrading/kit-cn'
import { SessionLaunchError, type ExecutionInspection, type TasksRunner } from './tasks/runner.ts'

export interface OptionBarAgentOptions {
  dataRoot: () => string
  now?: () => number
  runner?: () => TasksRunner | undefined
  workspaceId?: () => string | undefined
  log?: (message: string, error?: unknown) => void
  /** 总览口径事实（includeIv=0 + 缓存 atmIv）。失败则 packet 全 unknown。 */
  loadFacts?: (underlyings: readonly string[]) => Promise<readonly OptionBarFact[]>
  getCnOptions?: () => CnOptionsService | undefined
}

export class OptionBarAgentHost {
  inFlight = false
  private openSessionId: string | undefined = undefined
  private openStartedAt = 0
  /** launch 时快照的桶与日历日，settle 写 sessions 台账用（进程内即终局，不跨日）。 */
  private openBucketStart: string | undefined = undefined
  private openDate: string | undefined = undefined
  private readonly options: OptionBarAgentOptions

  constructor(options: OptionBarAgentOptions) {
    this.options = options
  }

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
      const asOf = new Date(ctx.nowMs).toISOString()
      const packet = await this.buildPacket(ctx.loop, bucketStart, asOf)
      await this.writePacket(root, date, packet)
      const workspaceId = this.options.workspaceId?.()
      const sessionId = await runner.launch({
        id: `option-bar-${bucketStart}`,
        title: `ETF option bar ${bucketStart}`,
        prompt: `${OPTION_BAR_AGENT_PROMPT}\n\nbucketStart=${bucketStart}\nasOf=${asOf}\nContextPacket=${JSON.stringify(packet)}`,
        agentPreset: 'trader',
        ...(workspaceId === undefined ? {} : { workspaceId }),
      })
      this.openSessionId = sessionId
      this.openStartedAt = ctx.nowMs
      this.openBucketStart = bucketStart
      this.openDate = date
      await this.writeSessionEvent(date, {
        kind: 'launch',
        bucketStart,
        sessionId,
        launchedAt: asOf,
      })
    } catch (error) {
      this.inFlight = false
      this.openSessionId = undefined
      this.options.log?.('option-bar launch failed', error)
      await this.writeSessionEvent(date, {
        kind: 'settle',
        bucketStart,
        ...(error instanceof SessionLaunchError ? { sessionId: error.sessionId } : {}),
        settledAt: new Date(ctx.nowMs).toISOString(),
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
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
    try {
      await backfillIvDailyFromPackets(root)
    } catch (error) {
      this.options.log?.('option-bar iv-daily backfill failed', error)
    }
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

  settle(): void {
    this.inFlight = false
    this.openSessionId = undefined
    this.openBucketStart = undefined
    this.openDate = undefined
  }

  private async refreshInFlight(): Promise<void> {
    if (!this.inFlight || this.openSessionId === undefined) return
    const runner = this.options.runner?.()
    if (runner === undefined) return
    const sessionId = this.openSessionId
    const bucketStart = this.openBucketStart
    const date = this.openDate
    let inspection: ExecutionInspection | undefined
    try {
      inspection = await runner.inspect(sessionId, this.openStartedAt)
    } catch (error) {
      this.options.log?.('option-bar inspect failed', error)
      return
    }
    if (inspection.outcome === 'pending') return
    this.settle()
    if (bucketStart === undefined || date === undefined) return
    try {
      const outcome = await this.settleOutcome(date, bucketStart, inspection)
      await this.writeSessionEvent(date, {
        kind: 'settle',
        bucketStart,
        sessionId,
        settledAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        outcome,
        ...(inspection.outcome === 'failed' || inspection.outcome === 'cancelled'
          ? { error: inspection.error }
          : {}),
      })
    } catch (error) {
      this.options.log?.('option-bar session persist failed', error)
    }
  }

  /** runner 说 succeeded 时核对当日该桶 recommendations 是否真有行（工具调用可能被跳过）→ no_rec。 */
  private async settleOutcome(
    date: string,
    bucketStart: string,
    inspection: ExecutionInspection,
  ): Promise<OptionBarSessionOutcome> {
    if (inspection.outcome === 'failed') return 'failed'
    if (inspection.outcome === 'cancelled') return 'cancelled'
    // 剩下 succeeded（pending 在调用前已被早退过滤）：该桶无推荐行 = 会话跑完没调工具。
    const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(this.options.dataRoot(), date))
    return recs.some((row) => row.bucketStart === bucketStart) ? 'succeeded' : 'no_rec'
  }

  /** sessions 台账 append（launch/settle 事件）；失败只记 log，不阻断主流程。 */
  private async writeSessionEvent(date: string, event: OptionBarSessionEvent): Promise<void> {
    try {
      await appendJsonlLine(optionSessionsPath(this.options.dataRoot(), date), event)
    } catch (error) {
      this.options.log?.('option-bar session persist failed', error)
    }
  }

  private async buildPacket(
    loop: OptionCycleLoop,
    bucketStart: string,
    asOf: string,
  ) {
    const underlyings = loop.rows.map((row) => row.underlying)
    let factsByUnderlying: Record<string, OptionBarFact | undefined> | undefined
    if (this.options.loadFacts !== undefined && underlyings.length > 0) {
      try {
        const facts = await this.options.loadFacts(underlyings)
        factsByUnderlying = Object.fromEntries(facts.map((item) => [item.underlying, item]))
      } catch (error) {
        this.options.log?.('option-bar loadFacts failed', error)
      }
    }
    return buildBarContextPacket({
      bucketStart,
      asOf,
      loop,
      ...(factsByUnderlying === undefined ? {} : { factsByUnderlying }),
    })
  }

  private async writePacket(
    root: string,
    date: string,
    packet: OptionBarContextPacket,
  ): Promise<void> {
    try {
      await appendJsonlLine(packetsPath(root, date), packet)
      await backfillIvDailyFromPackets(root)
    } catch (error) {
      this.options.log?.('option-bar packet persist failed', error)
    }
  }

  private async writeRec(root: string, date: string, row: OptionBarRecommendation): Promise<void> {
    try {
      await appendJsonlLine(recommendationsPath(root, date), row)
      void tryPaperOpen({
        root,
        date,
        rec: row,
        forecastByUnderlying: {},
        nowIso: row.asOf,
        getChain: async (underlying) => {
          try {
            return await this.options.getCnOptions?.()?.getOptionChain({ underlying })
          } catch {
            return undefined
          }
        },
        getMargin: async (legs) => {
          try {
            const service = this.options.getCnOptions?.()
            const underlying = /^(\d{6})/.exec(legs[0]?.code ?? '')?.[1]
            if (service === undefined || underlying === undefined) return undefined
            const result = await service.getStrategy({
              underlying,
              legs: legs.map((leg) => ({
                kind: 'option',
                code: leg.code,
                side: leg.side,
                qty: leg.qty,
                premium: leg.fillPrice,
              })),
            })
            return result.margin?.totalInitial
          } catch {
            return undefined
          }
        },
      }).catch(() => {})
    } catch (error) {
      this.options.log?.('option-bar recommendation persist failed', error)
    }
  }
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
