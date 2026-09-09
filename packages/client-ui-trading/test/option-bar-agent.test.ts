import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionBarRecommendation } from '@dshtrading/api'
import { readJsonl, recommendationsPath, reviewsPath } from '@dshtrading/kit-cn'
import { createOpportunityLane, OptionBarAgentHost } from '../src/option-bar-agent.ts'

const LUNCH = Date.parse('2026-09-08T03:25:00.000Z')
const CLOSE5 = Date.parse('2026-09-08T06:55:00.000Z')
const REGULAR = Date.parse('2026-09-08T01:45:12.000Z')

describe('OptionBarAgentHost', () => {
  it('lunch 新桶写 session 桩且不 launch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-'))
    let launched = 0
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => {
          launched += 1
          return 's1'
        },
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: LUNCH,
      loop: {
        running: true,
        horizonMin: 5,
        lastBucket: '2026-09-08T03:25:00.000Z',
        rows: [],
      },
    })
    expect(launched).toBe(0)
    const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(dir, '2026-09-08'))
    expect(recs[0]?.skipReason).toBe('session')
    expect(recs[0]?.opportunity).toBe('no_edge')
  })

  it('close5 写出复盘且第二次不覆盖', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-'))
    const host = new OptionBarAgentHost({ dataRoot: () => dir })
    await host.afterTick({
      ticked: true,
      nowMs: CLOSE5,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    const first = reviewsPath(dir, '2026-09-08')
    const { readFile, writeFile } = await import('node:fs/promises')
    await writeFile(first, 'KEEP\n', 'utf8')
    await host.afterTick({
      ticked: true,
      nowMs: CLOSE5,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    expect(await readFile(first, 'utf8')).toBe('KEEP\n')
  })

  it('regular 新桶 launch 且不写桩', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-'))
    let launched = 0
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => {
          launched += 1
          return 's1'
        },
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    await host.afterTick({
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
    expect(host.inFlight).toBe(true)
    const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(dir, '2026-09-08'))
    expect(recs).toEqual([])
  })

  it('createOpportunityLane 委托 decide/run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-'))
    let launched = 0
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => {
          launched += 1
          return 's1'
        },
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    const lane = createOpportunityLane(host)
    const ctx = await host.buildContext({
      ticked: true,
      nowMs: REGULAR,
      loop: {
        running: true,
        horizonMin: 5,
        lastBucket: '2026-09-08T01:45:00.000Z',
        rows: [],
      },
    })
    expect(lane.id).toBe('opportunity')
    const decision = lane.decide(ctx)
    expect(decision.action).toBe('launch')
    await lane.run?.(ctx, decision)
    expect(launched).toBe(1)
    expect(host.inFlight).toBe(true)
  })
})
