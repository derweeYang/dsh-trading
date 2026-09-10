import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionBarRecommendation, OptionBarSessionEvent } from '@dshtrading/api'
import { appendJsonlLine, optionSessionsPath, readJsonl, recommendationsPath, reviewsPath } from '@dshtrading/kit-cn'
import { SessionLaunchError, type ExecutionInspection } from '../src/tasks/runner.ts'
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
    await expect(access(path.join(dir, 'paper', 'fills', '2026-09-08.jsonl'))).rejects.toThrow()
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

  it('launch 成功写 sessions launch 行', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-sess-'))
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => 's1',
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    const events = await readJsonl<OptionBarSessionEvent>(optionSessionsPath(dir, '2026-09-08'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'launch',
      bucketStart: '2026-09-08T01:45:00.000Z',
      sessionId: 's1',
      launchedAt: '2026-09-08T01:45:12.000Z',
    })
  })

  it('inspect succeeded 但该桶无推荐行 → settle no_rec', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-norec-'))
    let inspection: ExecutionInspection = { outcome: 'pending' }
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => 's1',
        inspect: async () => inspection,
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    inspection = { outcome: 'succeeded' }
    await host.afterTick({
      ticked: true,
      nowMs: LUNCH,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    const events = await readJsonl<OptionBarSessionEvent>(optionSessionsPath(dir, '2026-09-08'))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'launch', sessionId: 's1' })
    expect(events[1]).toMatchObject({
      kind: 'settle',
      bucketStart: '2026-09-08T01:45:00.000Z',
      sessionId: 's1',
      outcome: 'no_rec',
    })
    expect(typeof events[1]?.settledAt).toBe('string')
    expect(host.inFlight).toBe(false)
  })

  it('该桶已有推荐行 → settle succeeded', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-succ-'))
    let inspection: ExecutionInspection = { outcome: 'pending' }
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => 's1',
        inspect: async () => inspection,
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    // 模拟 LLM 工具调用已写入该桶推荐行（写入时序先于 inspect 非 pending）。
    await appendJsonlLine(recommendationsPath(dir, '2026-09-08'), {
      bucketStart: '2026-09-08T01:45:00.000Z',
      asOf: '2026-09-08T01:45:50.000Z',
      session: 'regular',
      opportunity: 'no_edge',
      edge: 'x',
      logic: '',
      playbook: '',
      invalidIf: '',
      picks: [],
      noTrade: true,
    })
    inspection = { outcome: 'succeeded' }
    await host.afterTick({
      ticked: true,
      nowMs: LUNCH,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    const events = await readJsonl<OptionBarSessionEvent>(optionSessionsPath(dir, '2026-09-08'))
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ kind: 'settle', outcome: 'succeeded' })
  })

  it('inspect failed → settle failed 且带 error', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-fail-'))
    let inspection: ExecutionInspection = { outcome: 'pending' }
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => 's1',
        inspect: async () => inspection,
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    inspection = { outcome: 'failed', error: 'turn crashed' }
    await host.afterTick({
      ticked: true,
      nowMs: LUNCH,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    const events = await readJsonl<OptionBarSessionEvent>(optionSessionsPath(dir, '2026-09-08'))
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      kind: 'settle',
      sessionId: 's1',
      outcome: 'failed',
      error: 'turn crashed',
    })
    expect(host.inFlight).toBe(false)
  })

  it('launch 抛普通错误 → settle failed 无 sessionId，另写 launch_failed 桩', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-thr-'))
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => {
          throw new Error('gateway down')
        },
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    const events = await readJsonl<OptionBarSessionEvent>(optionSessionsPath(dir, '2026-09-08'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'settle', bucketStart: '2026-09-08T01:45:00.000Z', outcome: 'failed' })
    expect(events[0]?.error).toContain('gateway down')
    expect('sessionId' in (events[0]!)).toBe(false)
    const recs = await readJsonl<OptionBarRecommendation>(recommendationsPath(dir, '2026-09-08'))
    expect(recs[0]?.skipReason).toBe('launch_failed')
    expect('sessionId' in (recs[0]!)).toBe(false)
  })

  it('SessionLaunchError → settle 回填 sessionId', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-sle-'))
    const host = new OptionBarAgentHost({
      dataRoot: () => dir,
      runner: () => ({
        launch: async () => {
          throw new SessionLaunchError('s-9', new Error('turn crashed'))
        },
        inspect: async () => ({ outcome: 'pending' as const }),
      } as never),
    })
    await host.afterTick({
      ticked: true,
      nowMs: REGULAR,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T01:45:00.000Z', rows: [] },
    })
    const events = await readJsonl<OptionBarSessionEvent>(optionSessionsPath(dir, '2026-09-08'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'settle',
      bucketStart: '2026-09-08T01:45:00.000Z',
      sessionId: 's-9',
      outcome: 'failed',
    })
  })
})
