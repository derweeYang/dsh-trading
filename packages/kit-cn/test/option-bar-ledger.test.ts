import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionCycle, OptionIntradayBoxRow } from '@dshtrading/api'
import { OptionCycleBook } from '../src/option-cycles.ts'
import {
  appendJsonlLine,
  attachOverviewStrategies,
  buildBarContextPacket,
  decideBarAgent,
  latestRecommendation,
  loadLatestRecommendation,
  foldDailyReview,
  latestByKey,
  latestPacketForBucket,
  atmIvPercentile,
  foldIvDaily,
  backfillIvDailyFromPackets,
  applyReplayIvDaily,
  makeSkipRecommendation,
  normalizeRecommendation,
  opportunityAllowed,
  optionsDataRoot,
  packetsPath,
  readJsonl,
  tagIvRegime,
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

  it('有 packet 时 theta_rent 要求 ivRegime=rich|event_front', () => {
    const packet = {
      '510050': { underlying: '510050', ivRegime: 'unknown' as const, regime: 'range_hold' as const },
    }
    expect(opportunityAllowed({
      opportunity: 'theta_rent',
      picks: [{ underlying: '510050', regime: 'range_hold', template: 'butterfly', cycleId: '1' }],
      forecastByUnderlying: forecasts,
      packetByUnderlying: packet,
    })).toMatch(/ivRegime/)
    expect(opportunityAllowed({
      opportunity: 'theta_rent',
      picks: [{ underlying: '510050', regime: 'range_hold', template: 'butterfly', cycleId: '1' }],
      forecastByUnderlying: forecasts,
      packetByUnderlying: { '510050': { ...packet['510050'], ivRegime: 'rich' } },
    })).toBeUndefined()
  })

  it('有 packet 时 rv_vs_iv 拒绝 rich；covered_yield 拒绝 weak_rally', () => {
    const expand = forecast({
      regime: 'vol_expand',
      candidates: [{ template: 'straddle', bias: 'neutral', invalidIf: 'out', reason: 'x' }],
    })
    expect(opportunityAllowed({
      opportunity: 'rv_vs_iv',
      picks: [{ underlying: '510050', regime: 'vol_expand', template: 'straddle', cycleId: '1' }],
      forecastByUnderlying: { '510050': expand },
      packetByUnderlying: { '510050': { underlying: '510050', ivRegime: 'rich', regime: 'vol_expand' } },
    })).toMatch(/ivRegime/)
    expect(opportunityAllowed({
      opportunity: 'covered_yield',
      picks: [{ underlying: '510050', regime: 'range_hold', template: 'covered_call', cycleId: '1' }],
      forecastByUnderlying: {
        '510050': forecast({
          candidates: [{ template: 'covered_call', bias: 'up', invalidIf: 'out', reason: 'x' }],
        }),
      },
      heldQtyByUnderlying: { '510050': 10_000 },
      packetByUnderlying: {
        '510050': { underlying: '510050', ivRegime: 'unknown', regime: 'range_hold', divergence: 'weak_rally' },
      },
    })).toMatch(/weak_rally/)
  })

  it('模型改写 packet 的 ivRegime → 拒绝', () => {
    expect(opportunityAllowed({
      opportunity: 'theta_rent',
      picks: [{
        underlying: '510050',
        regime: 'range_hold',
        template: 'butterfly',
        cycleId: '1',
        ivRegime: 'rich',
      }],
      forecastByUnderlying: forecasts,
      packetByUnderlying: { '510050': { underlying: '510050', ivRegime: 'cheap', regime: 'range_hold' } },
    })).toMatch(/ivRegime/)
  })
})

describe('tagIvRegime / buildBarContextPacket', () => {
  it('分位与 IV/HV 打标；只有 atmIv 则为 unknown', () => {
    expect(tagIvRegime({ ivPercentile: 0.85 })).toBe('rich')
    expect(tagIvRegime({ ivPercentile: 15 })).toBe('cheap')
    expect(tagIvRegime({ atmIv: 0.28, hv20: 0.18 })).toBe('rich')
    expect(tagIvRegime({ atmIv: 0.12, hv20: 0.2 })).toBe('cheap')
    expect(tagIvRegime({ atmIv: 0.22 })).toBe('unknown')
    expect(tagIvRegime({ atmIv: 0.25, nextAtmIv: 0.2 })).toBe('event_front')
    expect(tagIvRegime({ atmIv: 0.22, nextAtmIv: 0.21, hv20: 0.12 })).toBe('rich')
  })

  it('packet 从 loop + facts 组装；量比只取 facts 的 5d/20d，不抄箱体 1m 量比', () => {
    const packet = buildBarContextPacket({
      bucketStart: '2026-09-08T01:45:00.000Z',
      asOf: '2026-09-08T01:45:12.000Z',
      loop: {
        rows: [{
          underlying: '510050',
          latest: {
            id: '510050:1',
            forecast: forecast({ volumeRatio: 2.2 }),
          },
        }],
      },
      factsByUnderlying: {
        '510050': { underlying: '510050', return5d: 1.2, volumeRatio: 0.8, divergence: 'weak_rally', atmIv: 0.21 },
      },
    })
    expect(packet.rows[0]).toMatchObject({
      underlying: '510050',
      cycleId: '510050:1',
      regime: 'range_hold',
      ivRegime: 'unknown',
      volumeRatio: 0.8,
      divergence: 'weak_rally',
      atmIv: 0.21,
    })
    expect(packet.rows[0]?.volumeRatio).not.toBe(2.2)
  })
})

describe('packets jsonl', () => {
  it('按 bucketStart 取最后一包', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-pkt-'))
    const file = packetsPath(dir, '2026-09-08')
    await appendJsonlLine(file, { bucketStart: 'a', asOf: 't', rows: [] })
    await appendJsonlLine(file, { bucketStart: 'b', asOf: 't', rows: [{ underlying: '510050', ivRegime: 'rich', regime: 'range_hold' }] })
    await appendJsonlLine(file, { bucketStart: 'b', asOf: 't2', rows: [{ underlying: '510050', ivRegime: 'cheap', regime: 'range_hold' }] })
    const latest = latestPacketForBucket(await readJsonl(file), 'b')
    expect(latest?.asOf).toBe('t2')
    expect(latest?.rows[0]?.ivRegime).toBe('cheap')
  })
})

describe('atmIvPercentile / foldIvDaily', () => {
  it('窗口不足不打分位；满窗用平均秩 0–1', () => {
    const hist = Array.from({ length: 58 }, (_, i) => ({ date: `d${String(i + 1).padStart(2, '0')}`, atmIv: 0.1 + i * 0.001 }))
    expect(atmIvPercentile(hist, 0.2, 60)).toBeUndefined()
    const full = [...hist, { date: 'd59', atmIv: 0.16 }]
    const pct = atmIvPercentile(full, 0.2, 60)
    expect(pct).toBeGreaterThan(0.9)
    expect(pct).toBeLessThanOrEqual(1)
  })

  it('同一日同一标的后写覆盖；缺 atmIv 的行不进序列', () => {
    const rows = foldIvDaily({
      date: '2026-09-10',
      existing: [
        { date: '2026-09-10', underlying: '510050', atmIv: 0.1 },
        { date: '2026-09-09', underlying: '510050', atmIv: 0.18 },
      ],
      packet: {
        bucketStart: 't',
        asOf: 't',
        rows: [
          { underlying: '510050', ivRegime: 'unknown', regime: 'range_hold', candidates: [], atmIv: 0.22, hv20: 0.16 },
          { underlying: '159915', ivRegime: 'unknown', regime: 'no_trade', candidates: [] },
        ],
      },
    })
    expect(rows.filter((row) => row.underlying === '510050')).toEqual([
      { date: '2026-09-09', underlying: '510050', atmIv: 0.18 },
      { date: '2026-09-10', underlying: '510050', atmIv: 0.22, hv20: 0.16 },
    ])
    expect(rows.some((row) => row.underlying === '159915')).toBe(false)
  })

  it('从 packets 目录回填 iv-daily（每文件取最新一包）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-ivbf-'))
    const packetsDir = path.join(dir, 'packets')
    await mkdir(packetsDir, { recursive: true })
    await writeFile(path.join(packetsDir, '2026-09-09.jsonl'), `${JSON.stringify({
      bucketStart: 'a',
      asOf: 't',
      rows: [{ underlying: '510050', ivRegime: 'unknown', regime: 'range_hold', candidates: [], atmIv: 0.19 }],
    })}\n`, 'utf8')
    await writeFile(path.join(packetsDir, '2026-09-10.jsonl'), `${JSON.stringify({
      bucketStart: 'b',
      asOf: 't',
      rows: [{ underlying: '510050', ivRegime: 'rich', regime: 'range_hold', candidates: [], atmIv: 0.22, nextAtmIv: 0.18 }],
    })}\n${JSON.stringify({
      bucketStart: 'c',
      asOf: 't2',
      rows: [{ underlying: '510050', ivRegime: 'event_front', regime: 'range_hold', candidates: [], atmIv: 0.24, nextAtmIv: 0.18 }],
    })}\n`, 'utf8')
    const rows = await backfillIvDailyFromPackets(dir)
    expect(rows).toEqual([
      { date: '2026-09-09', underlying: '510050', atmIv: 0.19 },
      { date: '2026-09-10', underlying: '510050', atmIv: 0.24 },
    ])
    const again = await backfillIvDailyFromPackets(dir)
    expect(again).toHaveLength(2)
  })

  it('回放种子不覆盖已有 packet 行', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opt-ivreplay-'))
    await writeFile(path.join(dir, 'iv-daily.jsonl'), `${JSON.stringify({
      date: '2026-09-10', underlying: '510050', atmIv: 0.14, hv20: 0.13,
    })}\n`, 'utf8')
    const rows = await applyReplayIvDaily(dir, [
      { date: '2026-09-10', underlying: '510050', atmIv: 0.99 },
      { date: '2026-08-20', underlying: '510050', atmIv: 0.17, hv20: 0.15 },
    ])
    expect(rows).toEqual([
      { date: '2026-08-20', underlying: '510050', atmIv: 0.17, hv20: 0.15 },
      { date: '2026-09-10', underlying: '510050', atmIv: 0.14, hv20: 0.13 },
    ])
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
    const [withIv] = attachOverviewStrategies(
      [{ underlying: '510050' }],
      rec,
      {
        bucketStart: rec.bucketStart,
        asOf: 't',
        rows: [{ underlying: '510050', ivRegime: 'rich', regime: 'range_hold', candidates: ['butterfly'] }],
      },
    )
    expect(withIv?.strategy?.ivRegime).toBe('rich')
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
