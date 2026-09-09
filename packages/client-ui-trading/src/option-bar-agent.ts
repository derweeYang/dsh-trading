/**
 * 5 分钟 K 智能体宿主编排：落推荐桩、事件触发 trader 会话、确定性盘后复盘。
 * 不算箱体、不下单。
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OptionBarRecommendation, OptionCycle, OptionCycleLoop } from '@dshtrading/api'
import {
  OPTION_BAR_AGENT_PROMPT,
  appendJsonlLine,
  cyclesPath,
  decideBarAgent,
  foldDailyReview,
  makeSkipRecommendation,
  recommendationsPath,
  reviewsPath,
  sessionAt,
  shanghaiCalendarDate,
  shouldWriteDailyReview,
  shanghaiBucketStartMs,
  readJsonl,
} from '@dshtrading/kit-cn'
import type { TasksRunner } from './tasks/runner.ts'

export interface OptionBarAgentOptions {
  dataRoot: () => string
  now?: () => number
  runner?: () => TasksRunner | undefined
  workspaceId?: () => string | undefined
  log?: (message: string, error?: unknown) => void
}

export class OptionBarAgentHost {
  inFlight = false
  private openSessionId?: string
  private openStartedAt = 0
  private readonly options: OptionBarAgentOptions

  constructor(options: OptionBarAgentOptions) {
    this.options = options
  }

  async afterTick(input: { ticked: boolean; loop: OptionCycleLoop; nowMs: number }): Promise<void> {
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
    const decision = decideBarAgent({
      ticked: input.ticked,
      session,
      inFlight: this.inFlight,
      allCalibrated,
      alreadyRecommended,
      bucketStart,
    })

    if (decision.action === 'stub' && decision.skipReason !== undefined) {
      await this.writeRec(root, date, makeSkipRecommendation({
        bucketStart,
        asOf: new Date(nowMs).toISOString(),
        session,
        skipReason: decision.skipReason,
      }))
    }

    if (decision.action === 'launch') {
      const runner = this.options.runner?.()
      if (runner === undefined) {
        await this.writeRec(root, date, makeSkipRecommendation({
          bucketStart,
          asOf: new Date(nowMs).toISOString(),
          session,
          skipReason: 'launch_failed',
        }))
      } else {
        this.inFlight = true
        try {
          const workspaceId = this.options.workspaceId?.()
          const sessionId = await runner.launch({
            id: `option-bar-${bucketStart}`,
            title: `ETF option bar ${bucketStart}`,
            prompt: `${OPTION_BAR_AGENT_PROMPT}\n\nbucketStart=${bucketStart}\nasOf=${new Date(nowMs).toISOString()}`,
            agentPreset: 'trader',
            ...(workspaceId === undefined ? {} : { workspaceId }),
          })
          this.openSessionId = sessionId
          this.openStartedAt = nowMs
        } catch (error) {
          this.inFlight = false
          this.openSessionId = undefined
          this.options.log?.('option-bar launch failed', error)
          await this.writeRec(root, date, makeSkipRecommendation({
            bucketStart,
            asOf: new Date(nowMs).toISOString(),
            session,
            skipReason: 'launch_failed',
          }))
        }
      }
    }

    const reviewFile = reviewsPath(root, date)
    const exists = await fileExists(reviewFile)
    if (shouldWriteDailyReview(session, exists)) {
      const cycles = await readJsonl<OptionCycle>(cyclesPath(root, date))
      const recommendations = await readJsonl<OptionBarRecommendation>(recommendationsPath(root, date))
      const md = foldDailyReview({ date, cycles, recommendations })
      await mkdir(path.dirname(reviewFile), { recursive: true })
      await writeFile(reviewFile, md, 'utf8')
    }
  }

  settle(): void {
    this.inFlight = false
    this.openSessionId = undefined
  }

  private async refreshInFlight(): Promise<void> {
    if (!this.inFlight || this.openSessionId === undefined) return
    const runner = this.options.runner?.()
    if (runner === undefined) return
    try {
      const inspection = await runner.inspect(this.openSessionId, this.openStartedAt)
      if (inspection.outcome !== 'pending') this.settle()
    } catch (error) {
      this.options.log?.('option-bar inspect failed', error)
    }
  }

  private async writeRec(root: string, date: string, row: OptionBarRecommendation): Promise<void> {
    try {
      await appendJsonlLine(recommendationsPath(root, date), row)
    } catch (error) {
      this.options.log?.('option-bar recommendation persist failed', error)
    }
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
