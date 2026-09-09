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
