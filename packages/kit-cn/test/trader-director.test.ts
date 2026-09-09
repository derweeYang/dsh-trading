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
  it('regular 新顶 → launch', () => {
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

  it('createIdleLane 任意 session 均 idle', () => {
    expect(createIdleLane('risk').decide(baseCtx({ session: 'close5' })).action).toBe('idle')
    expect(createIdleLane('behavior').decide(baseCtx()).action).toBe('idle')
  })
})
