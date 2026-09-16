import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionBarRecommendation, OptionBarSessionEvent } from '@dshtrading/api'
import { appendJsonlLine, cyclesPath, optionSessionsPath, readJsonl, recommendationsPath, reviewsPath } from '@dshtrading/kit-cn'
import { SessionLaunchError, type ExecutionInspection } from '../src/tasks/runner.ts'
import { createOpportunityLane, OptionBarAgentHost, resolveOptionBarWorkspaceId } from '../src/option-bar-agent.ts'

const LUNCH = Date.parse('2026-09-08T03:25:00.000Z')
const CLOSE5 = Date.parse('2026-09-08T06:55:00.000Z')
const REGULAR = Date.parse('2026-09-08T01:45:12.000Z')
// 上海 2026-09-09 00:05：午夜跨日第一个 tick，session='closed' 但当日无 cycles。
const MIDNIGHT = Date.parse('2026-09-08T16:05:00.000Z')
// 上海 15:10：盘后 closed。
const AFTER_CLOSE = Date.parse('2026-09-08T07:10:00.000Z')

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

  it('盘收完（尾盘桶落盘）close5 写出复盘；午夜空档不抢写', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-rev-'))
    // 尾盘桶（上海 14:50）已进 cycles = 盘确实收完了。
    await appendJsonlLine(cyclesPath(dir, '2026-09-08'), {
      id: '510050:1',
      underlying: '510050',
      bucketStart: '2026-09-08T06:50:00.000Z',
      asOf: '2026-09-08T06:50:01.000Z',
      calibration: 'none',
    })
    const host = new OptionBarAgentHost({ dataRoot: () => dir })
    await host.afterTick({
      ticked: true,
      nowMs: CLOSE5,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    const { readFile } = await import('node:fs/promises')
    const first = await readFile(reviewsPath(dir, '2026-09-08'), 'utf8')
    expect(first).toContain('复盘')

    // 2026-09-11 事故形状：午夜跨日第一个 tick session='closed'，
    // 当日 cycles 还没有尾盘桶 → 不抢写空版复盘。
    const mid = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-mid-'))
    const host2 = new OptionBarAgentHost({ dataRoot: () => mid })
    await host2.afterTick({
      ticked: true,
      nowMs: MIDNIGHT,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T16:05:00.000Z', rows: [] },
    })
    await expect(access(reviewsPath(mid, '2026-09-09'))).rejects.toThrow()
  })

  it('复盘已存在：close5 重写吸收新数据；closed 不覆盖', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bar-agent-ovr-'))
    await appendJsonlLine(cyclesPath(dir, '2026-09-08'), {
      id: '510050:1',
      underlying: '510050',
      bucketStart: '2026-09-08T06:50:00.000Z',
      asOf: '2026-09-08T06:50:01.000Z',
      calibration: 'none',
    })
    const host = new OptionBarAgentHost({ dataRoot: () => dir })
    await host.afterTick({
      ticked: true,
      nowMs: CLOSE5,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    // close5 窗口内追加打分再 tick → 覆盖重写吸收最新 verdict。
    await appendJsonlLine(cyclesPath(dir, '2026-09-08'), {
      id: '510050:1',
      underlying: '510050',
      bucketStart: '2026-09-08T06:50:00.000Z',
      asOf: '2026-09-08T06:58:01.000Z',
      calibration: 'none',
      score: { verdict: 'hit', barCount: 5 },
    })
    await host.afterTick({
      ticked: true,
      nowMs: CLOSE5 + 2 * 60_000,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    const { readFile, writeFile } = await import('node:fs/promises')
    const rewritten = await readFile(reviewsPath(dir, '2026-09-08'), 'utf8')
    expect(rewritten).toContain('| 510050 | 1 | 0 | 0 | 0 |')

    // 盘后（closed）已存在 → 保留既有版本，不覆盖。
    await writeFile(reviewsPath(dir, '2026-09-08'), 'KEEP\n', 'utf8')
    await host.afterTick({
      ticked: true,
      nowMs: AFTER_CLOSE,
      loop: { running: true, horizonMin: 5, lastBucket: '2026-09-08T06:55:00.000Z', rows: [] },
    })
    expect(await readFile(reviewsPath(dir, '2026-09-08'), 'utf8')).toBe('KEEP\n')
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
        dayPrior: {
          targetDate: '2026-09-08',
          marketExpectation: 'small_up',
          volExpectation: 'up',
          confidence: 0.58,
        },
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
    expect(prompt).toContain('dayPrior')
    expect(prompt).toContain('small_up')
    expect(prompt).toContain('not a hard gate')
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

describe('resolveOptionBarWorkspaceId', () => {
  it('名册顺序漂移时仍按 path 匹配 deepseek-harness', () => {
    const registry = {
      list: () => [
        { id: 'ws-temp', title: 'temp', path: 'D:\\temp' },
        { id: 'ws-harness', title: 'deepseek-harness', path: 'D:\\workspace\\myquant\\projects\\trading-agent_v3\\deepseek-harness' },
      ],
    }
    expect(resolveOptionBarWorkspaceId(registry)).toBe('ws-harness')
  })

  it('无 path 时按 title 匹配（大小写不敏感）', () => {
    const registry = { list: () => [{ id: 'a', title: 'temp' }, { id: 'b', title: 'DeepSeek-Harness' }] }
    expect(resolveOptionBarWorkspaceId(registry)).toBe('b')
  })

  it('匹配不到回退名册第一个并告警', () => {
    const logs: string[] = []
    const registry = { list: () => [{ id: 'a', title: 'temp' }, { id: 'b', title: 'other' }] }
    expect(resolveOptionBarWorkspaceId(registry, (message) => { logs.push(message) })).toBe('a')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('falling back to first workspace')
  })

  it('空名册或名册缺失返回 undefined 且不告警', () => {
    const logs: string[] = []
    const log = (message: string): void => { logs.push(message) }
    expect(resolveOptionBarWorkspaceId(undefined, log)).toBeUndefined()
    expect(resolveOptionBarWorkspaceId({ list: () => [] }, log)).toBeUndefined()
    expect(logs).toHaveLength(0)
  })
})
