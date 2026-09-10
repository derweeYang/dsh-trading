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

  it('close5 把当天 packet 折进 iv-daily', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-'))
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(path.join(dir, 'packets'), { recursive: true })
    await writeFile(path.join(dir, 'packets', '2026-09-08.jsonl'), `${JSON.stringify({
      bucketStart: '2026-09-08T01:45:00.000Z',
      asOf: 't',
      rows: [{ underlying: '510050', ivRegime: 'rich', regime: 'range_hold', candidates: [], atmIv: 0.28, hv20: 0.18 }],
    })}\n`, 'utf8')
    const host = new OptionBarAgentHost({ dataRoot: () => dir })
    await host.afterTick({
      ticked: true,
      nowMs: CLOSE5,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    const daily = await readJsonl<{ underlying: string; atmIv?: number }>(path.join(dir, 'iv-daily.jsonl'))
    expect(daily[0]).toMatchObject({ date: '2026-09-08', underlying: '510050', atmIv: 0.28, hv20: 0.18 })
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
    let prompt = ''
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      loadFacts: async () => [{
        underlying: '510050',
        return5d: 1.1,
        volumeRatio: 0.8,
        divergence: 'weak_rally',
        atmIv: 0.21,
      }],
      runner: () => ({
        launch: async (input: { prompt: string }) => {
          launched += 1
          prompt = input.prompt
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
        rows: [{
          underlying: '510050',
          stats: { n: 0, hits: 0, misses: 0, partials: 0, skipped: 0 },
          latest: {
            id: '510050:1',
            underlying: '510050',
            bucketStart: '2026-09-08T01:45:00.000Z',
            asOf: '2026-09-08T01:45:12.000Z',
            calibration: 'none',
            forecast: {
              underlying: '510050',
              name: '50ETF',
              exchange: 'SSE',
              horizonMin: 5,
              regime: 'range_hold',
              session: 'regular',
              volumeRatio: 2.2,
              candidates: [{
                template: 'butterfly',
                bias: 'neutral',
                invalidIf: '1-minute close outside box',
                reason: 'tight',
              }],
            },
          },
        }],
      },
    })
    expect(launched).toBe(1)
    expect(host.inFlight).toBe(true)
    expect(prompt).toContain('ContextPacket=')
    expect(prompt).toContain('"ivRegime":"unknown"')
    expect(prompt).toContain('"volumeRatio":0.8')
    expect(prompt).not.toContain('"volumeRatio":2.2')
    const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(dir, '2026-09-08'))
    expect(recs).toEqual([])
    const packets = await readJsonl(path.join(dir, 'packets', '2026-09-08.jsonl'))
    expect(packets[0]).toMatchObject({ bucketStart: '2026-09-08T01:45:00.000Z' })
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
