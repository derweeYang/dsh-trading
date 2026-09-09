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
