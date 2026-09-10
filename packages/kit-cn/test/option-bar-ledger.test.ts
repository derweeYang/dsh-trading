import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionCycle, OptionIntradayBoxRow } from '@dshtrading/api'
import { OptionCycleBook } from '../src/option-cycles.ts'
import {
  appendJsonlLine,
  attachOverviewStrategies,
  decideBarAgent,
  latestRecommendation,
  loadLatestRecommendation,
  foldDailyReview,
  latestByKey,
  makeSkipRecommendation,
  normalizeRecommendation,
  opportunityAllowed,
  optionsDataRoot,
  readJsonl,
  replayCyclesIntoBook,
  sessionAt,
  shanghaiCalendarDate,
  shouldWriteDailyReview,
} from '../src/option-bar-ledger.ts'

const TUE_0944 = Date.parse('2026-09-08T01:44:00.000Z')
const TUE_0945 = Date.parse('2026-09-08T01:45:00.000Z')
const TUE_1125 = Date.parse('2026-09-08T03:25:00.000Z')
const TUE_1305 = Date.parse('2026-09-08T05:05:00.000Z')
const TUE_1455 = Date.parse('2026-09-08T06:55:00.000Z')

function forecast(partial: Partial<OptionIntradayBoxRow> = {}): OptionIntradayBoxRow {
  return {
    underlying: '510050',
    name: '华夏上证50ETF',
    exchange: 'SSE',
    horizonMin: 5,
    last: 3,
    boxLow: 2.99,
    boxHigh: 3.01,
    regime: 'range_hold',
    bias: 'neutral',
    session: 'regular',
    candidates: [{
      template: 'butterfly',
      bias: 'neutral',
      invalidIf: '1-minute close outside [2.9900, 3.0100]',
      reason: 'Tight range',
    }],
    ...partial,
  }
}

describe('sessionAt / shanghaiCalendarDate', () => {
  it('09:44 不开、09:45 regular、11:25 lunch、13:05 regular、14:55 close5', () => {
    expect(sessionAt(TUE_0944)).toBe('open15')
    expect(sessionAt(TUE_0945)).toBe('regular')
    expect(sessionAt(TUE_1125)).toBe('lunch')
    expect(sessionAt(TUE_1305)).toBe('regular')
    expect(sessionAt(TUE_1455)).toBe('close5')
  })

  it('上海日历日跨 UTC 零点仍是 2026-09-08', () => {
    expect(shanghaiCalendarDate(TUE_0945)).toBe('2026-09-08')
  })
})

describe('optionsDataRoot', () => {
  it('默认仓库 data/options；环境变量覆盖', () => {
    expect(optionsDataRoot({}, '/repo')).toBe(path.resolve('/repo', 'data', 'options'))
    expect(optionsDataRoot({ DSH_TRADING_OPTIONS_DATA: 'D:/tmp/opt' }, '/repo')).toBe(path.resolve('D:/tmp/opt'))
  })
})

describe('jsonl last-wins + replay', () => {
  it('同一 id 后写覆盖，回放进 book', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-bar-'))
    const file = path.join(dir, 'cycles.jsonl')
    const first: OptionCycle = {
      id: '510050:1',
      underlying: '510050',
      bucketStart: '2026-09-08T01:45:00.000Z',
      asOf: '2026-09-08T01:45:01.000Z',
      forecast: forecast(),
      calibration: 'none',
    }
    const scored: OptionCycle = {
      ...first,
      asOf: '2026-09-08T01:50:01.000Z',
      score: { verdict: 'hit', barCount: 5 },
    }
    await appendJsonlLine(file, first)
    await appendJsonlLine(file, scored)
    const rows = await readJsonl<OptionCycle>(file)
    expect(rows).toHaveLength(2)
    const latest = latestByKey(rows, (row) => row.id)
    expect(latest).toHaveLength(1)
    expect(latest[0]?.score?.verdict).toBe('hit')
    const book = replayCyclesIntoBook(new OptionCycleBook(), rows)
    expect(book.latest('510050')?.score?.verdict).toBe('hit')
  })
})

describe('opportunityAllowed / normalizeRecommendation', () => {
  const forecasts = { '510050': forecast() }

  it('theta_rent + butterfly + range_hold 通过', () => {
    expect(opportunityAllowed({
      opportunity: 'theta_rent',
      picks: [{ underlying: '510050', regime: 'range_hold', template: 'butterfly', cycleId: '510050:1' }],
      forecastByUnderlying: forecasts,
    })).toBeUndefined()
  })

  it('模板不在 candidates → 拒绝', () => {
    expect(() => normalizeRecommendation({
      bucketStart: 't',
      asOf: 't',
      session: 'regular',
      opportunity: 'direction_delta',
      edge: 'x',
      logic: 'x',
      playbook: 'x',
      invalidIf: 'x',
      picks: [{ underlying: '510050', regime: 'breakout', template: 'vertical', cycleId: '1' }],
      noTrade: false,
    }, forecasts)).toThrow(/not in candidates/)
  })

  it('no_edge 带 picks → 拒绝', () => {
    expect(opportunityAllowed({
      opportunity: 'no_edge',
      picks: [{ underlying: '510050', regime: 'range_hold', template: 'butterfly', cycleId: '1' }],
      forecastByUnderlying: forecasts,
    })).toMatch(/forbids picks/)
  })
})

describe('decideBarAgent', () => {
  const base = {
    ticked: true,
    session: 'regular' as const,
    inFlight: false,
    allCalibrated: false,
    alreadyRecommended: false,
    bucketStart: '2026-09-08T01:45:00.000Z',
  }

  it('regular 新桶 → launch', () => {
    expect(decideBarAgent(base).action).toBe('launch')
  })

  it('未 ticked 或已有推荐 → idle', () => {
    expect(decideBarAgent({ ...base, ticked: false }).action).toBe('idle')
    expect(decideBarAgent({ ...base, alreadyRecommended: true }).action).toBe('idle')
  })

  it('open15 / lunch / close5 → stub session', () => {
    expect(decideBarAgent({ ...base, session: 'open15' })).toMatchObject({ action: 'stub', skipReason: 'session' })
    expect(decideBarAgent({ ...base, session: 'lunch' }).skipReason).toBe('session')
    expect(decideBarAgent({ ...base, session: 'close5' }).skipReason).toBe('session')
  })

  it('inFlight → overlap；全 calibrated → calibrated', () => {
    expect(decideBarAgent({ ...base, inFlight: true }).skipReason).toBe('overlap')
    expect(decideBarAgent({ ...base, allCalibrated: true }).skipReason).toBe('calibrated')
  })
})

describe('shouldWriteDailyReview / foldDailyReview', () => {
  it('close5 且文件不存在才写；第二次不写', () => {
    expect(shouldWriteDailyReview('close5', false)).toBe(true)
    expect(shouldWriteDailyReview('close5', true)).toBe(false)
    expect(shouldWriteDailyReview('regular', false)).toBe(false)
    expect(shouldWriteDailyReview('closed', false)).toBe(true)
  })

  it('折叠含打分表与 overlap 计数，样本不足', () => {
    const md = foldDailyReview({
      date: '2026-09-08',
      cycles: [{
        id: '510050:1',
        underlying: '510050',
        bucketStart: '2026-09-08T01:45:00.000Z',
        asOf: '2026-09-08T01:45:01.000Z',
        forecast: forecast(),
        score: { verdict: 'hit', barCount: 5 },
        calibration: 'none',
      }],
      recommendations: [
        makeSkipRecommendation({
          bucketStart: '2026-09-08T01:50:00.000Z',
          asOf: 't',
          session: 'regular',
          skipReason: 'overlap',
        }),
      ],
    })
    expect(md).toContain('| 510050 | 1 | 0 | 0 | 0 |')
    expect(md).toContain('overlap: 1')
    expect(md).toContain('样本不足')
    expect(md).toContain('不构成投资建议')
  })
})

describe('attachOverviewStrategies', () => {
  it('无账本不写 strategy；有 pick 的行带 template；其余行 no_edge；logic/playbook 两分支都投影', () => {
    const rec = {
      bucketStart: '2026-09-09T05:45:00.000Z',
      asOf: 't',
      session: 'regular' as const,
      opportunity: 'theta_rent' as const,
      edge: 'range_hold 收时间价值',
      logic: '箱体收窄，卖方占优',
      playbook: '取箱体 → butterfly → 记失效条件',
      invalidIf: '1-minute close outside box',
      picks: [{ underlying: '510050', regime: 'range_hold' as const, template: 'butterfly' as const, cycleId: '510050:1' }],
      noTrade: false,
    }
    expect(attachOverviewStrategies([{ underlying: '510050' }], undefined)[0]).not.toHaveProperty('strategy')
    const [picked, other] = attachOverviewStrategies(
      [{ underlying: '510050' }, { underlying: '159915' }],
      rec,
    )
    expect(picked?.strategy).toMatchObject({
      opportunity: 'theta_rent',
      template: 'butterfly',
      noTrade: false,
      logic: '箱体收窄，卖方占优',
      playbook: '取箱体 → butterfly → 记失效条件',
    })
    expect(other?.strategy).toMatchObject({
      opportunity: 'no_edge',
      noTrade: true,
      logic: '箱体收窄，卖方占优',
      playbook: '取箱体 → butterfly → 记失效条件',
    })
    expect(latestRecommendation([rec, { ...rec, bucketStart: '2026-09-09T05:50:00.000Z' }])?.bucketStart)
      .toBe('2026-09-09T05:50:00.000Z')
  })

  it('logic/playbook 空串不写键', () => {
    const rec = {
      bucketStart: '2026-09-09T05:45:00.000Z',
      asOf: 't',
      session: 'regular' as const,
      opportunity: 'theta_rent' as const,
      edge: 'e',
      logic: '',
      playbook: '',
      invalidIf: '',
      picks: [{ underlying: '510050', regime: 'range_hold' as const, template: 'butterfly' as const, cycleId: '510050:1' }],
      noTrade: false,
    }
    const [picked] = attachOverviewStrategies([{ underlying: '510050' }], rec)
    expect(picked?.strategy).not.toHaveProperty('logic')
    expect(picked?.strategy).not.toHaveProperty('playbook')
    expect(picked?.strategy).not.toHaveProperty('invalidIf')
  })

  it('loadLatestRecommendation 跳过坏行，取当天最新 bucket', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-ov-'))
    const file = path.join(dir, 'recommendations', '2026-09-09.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, [
      '{not json}',
      JSON.stringify({ bucketStart: '2026-09-09T05:45:00.000Z', opportunity: 'no_edge', picks: [], noTrade: true }),
      JSON.stringify({
        bucketStart: '2026-09-09T05:50:00.000Z',
        opportunity: 'theta_rent',
        picks: [{ underlying: '510050', template: 'butterfly' }],
        noTrade: false,
        edge: 'ok',
      }),
      '',
    ].join('\n'), 'utf8')
    const latest = await loadLatestRecommendation(dir, Date.parse('2026-09-09T06:00:00.000Z'))
    expect(latest?.bucketStart).toBe('2026-09-09T05:50:00.000Z')
    expect(await loadLatestRecommendation(path.join(dir, 'missing'), Date.parse('2026-09-09T06:00:00.000Z')))
      .toBeUndefined()
  })
})

describe('appendJsonlLine 建目录', () => {
  it('父目录不存在也能写', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-bar-'))
    const file = path.join(dir, 'nested', 'a.jsonl')
    await appendJsonlLine(file, { ok: true })
    expect(await readFile(file, 'utf8')).toBe('{"ok":true}\n')
    await mkdir(path.join(dir, 'reviews'), { recursive: true })
    await writeFile(path.join(dir, 'reviews', 'x.md'), 'kept', 'utf8')
  })
})
