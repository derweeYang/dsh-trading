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
