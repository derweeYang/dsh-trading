import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  OptionPrediction,
  OptionPredictionDraft,
  OptionPredictionSettle,
} from '@dshtrading/api'
import {
  PredictionStore,
  aggregateKnowledge,
  classifyMarketFromBars,
  classifyVolFromLevels,
  etfSpotSymbol,
  klinesToPredictionBars,
  previousShanghaiWeekday,
  resolvePredictionAutoAsOf,
  dayPriorOf,
  predictionId,
  predictionStatsOf,
  realizePrediction,
  scoreOutcome,
} from '../src/option-predictions.ts'
import type { PredictionMarketBar } from '../src/option-predictions.ts'

function draft(over: Partial<OptionPredictionDraft> = {}): OptionPredictionDraft {
  return {
    underlying: '510050',
    underlyingName: '50ETF',
    targetDate: '2026-09-12',
    marketExpectation: 'small_up',
    volExpectation: 'up',
    confidence: 0.7,
    factors: [{ id: 'f0', label: 'IV', bias: 'bull', evidence: 'atm iv 18%', weight: 0.5 }],
    thesis: '弱反弹',
    evaluationMethod: '收盘涨跌幅>0.5% 判小涨；IV 升判波动增',
    ...over,
  }
}

function prediction(over: Partial<OptionPrediction> = {}): OptionPrediction {
  return {
    id: '510050-2026-09-12',
    underlying: '510050',
    asOfDate: '2026-09-11',
    targetDate: '2026-09-12',
    marketExpectation: 'small_up',
    volExpectation: 'up',
    confidence: 0.7,
    factors: [],
    thesis: '弱反弹',
    evaluationMethod: '收盘>0.5%',
    createdAt: '2026-09-11T08:00:00.000Z',
    ...over,
  }
}

function settle(over: Partial<OptionPredictionSettle> = {}): OptionPredictionSettle {
  return {
    id: '510050-2026-09-12',
    realizedMarket: 'small_up',
    realizedVol: 'up',
    marketReturnPct: 0.8,
    volChange: 0.01,
    retrospect: '对了',
    knowledgeNotes: '弱反弹可续',
    ...over,
  }
}

describe('predictionId', () => {
  it('underlying + targetDate', () => {
    expect(predictionId('510050', '2026-09-12')).toBe('510050-2026-09-12')
  })
})

describe('scoreOutcome', () => {
  it('双维可判定且命中 → score=1', () => {
    const outcome = scoreOutcome(prediction(), settle(), () => new Date('2026-09-12T07:00:00.000Z'))
    expect(outcome.hitMarket).toBe(true)
    expect(outcome.hitVol).toBe(true)
    expect(outcome.score).toBe(1)
    expect(outcome.settledAt).toBe('2026-09-12T07:00:00.000Z')
  })

  it('na 不计入分母；只判盘势命中 → score=1', () => {
    const outcome = scoreOutcome(
      prediction(),
      settle({ realizedVol: 'na', volChange: 0 }),
      () => new Date('2026-09-12T07:00:00.000Z'),
    )
    expect(outcome.hitVol).toBe(false)
    expect(outcome.score).toBe(1)
  })

  it('双维 na → score=0 且两维都不命中', () => {
    const outcome = scoreOutcome(
      prediction(),
      settle({ realizedMarket: 'na', realizedVol: 'na' }),
      () => new Date('2026-09-12T07:00:00.000Z'),
    )
    expect(outcome.hitMarket).toBe(false)
    expect(outcome.hitVol).toBe(false)
    expect(outcome.score).toBe(0)
  })

  it('盘势错、波动对 → score=0.5', () => {
    const outcome = scoreOutcome(
      prediction(),
      settle({ realizedMarket: 'big_down' }),
      () => new Date('2026-09-12T07:00:00.000Z'),
    )
    expect(outcome.hitMarket).toBe(false)
    expect(outcome.hitVol).toBe(true)
    expect(outcome.score).toBe(0.5)
  })
})

describe('predictionStatsOf', () => {
  it('矩阵 predicted 计全部分类；hit 只计 realized!==na 且命中；样本不足=0', () => {
    const rows: OptionPrediction[] = [
      prediction({
        outcome: scoreOutcome(prediction(), settle(), () => new Date('2026-09-12T07:00:00.000Z')),
      }),
      prediction({
        id: '510050-2026-09-15',
        targetDate: '2026-09-15',
        marketExpectation: 'small_up',
        volExpectation: 'down',
        outcome: scoreOutcome(
          prediction({ marketExpectation: 'small_up', volExpectation: 'down' }),
          settle({ realizedMarket: 'na', realizedVol: 'down' }),
          () => new Date('2026-09-15T07:00:00.000Z'),
        ),
      }),
      prediction({ id: '510050-2026-09-16', targetDate: '2026-09-16' }),
    ]
    const stats = predictionStatsOf(rows)
    expect(stats.total).toBe(3)
    expect(stats.scored).toBe(2)
    expect(stats.marketHitRate).toBe(1)
    expect(stats.volHitRate).toBe(1)
    expect(stats.avgScore).toBe(1)
    expect(stats.marketMatrix.small_up).toEqual({ predicted: 2, hit: 1 })
    expect(stats.volMatrix.up).toEqual({ predicted: 1, hit: 1 })
    expect(stats.volMatrix.down).toEqual({ predicted: 1, hit: 1 })
    expect(predictionStatsOf([]).marketHitRate).toBe(0)
  })
})

describe('aggregateKnowledge', () => {
  it('归一化去重、usage 累加、createdAt 取 max(createdAt, settledAt)、按 usage 降序', () => {
    const a = prediction({
      id: '510050-2026-09-12',
      thesis: '条件A',
      createdAt: '2026-09-11T08:00:00.000Z',
      outcome: {
        ...scoreOutcome(prediction(), settle({ knowledgeNotes: '  Weak Rebound  ' }), () => new Date('2026-09-12T07:00:00.000Z')),
        knowledgeNotes: '  Weak Rebound  ',
        settledAt: '2026-09-12T07:00:00.000Z',
      },
    })
    const b = prediction({
      id: '510300-2026-09-12',
      underlying: '510300',
      thesis: '条件B',
      createdAt: '2026-09-13T08:00:00.000Z',
      outcome: {
        ...scoreOutcome(prediction(), settle({ knowledgeNotes: 'weak rebound' }), () => new Date('2026-09-12T06:00:00.000Z')),
        knowledgeNotes: 'weak rebound',
        settledAt: '2026-09-12T06:00:00.000Z',
      },
    })
    const skipped = prediction({
      id: '159915-2026-09-12',
      outcome: { ...a.outcome!, knowledgeNotes: '   ' },
    })
    const items = aggregateKnowledge([a, skipped, b])
    expect(items).toHaveLength(1)
    expect(items[0]?.usage).toBe(2)
    expect(items[0]?.sources).toEqual(['510050-2026-09-12', '510300-2026-09-12'])
    expect(items[0]?.condition).toBe('条件A')
    expect(items[0]?.createdAt).toBe('2026-09-13T08:00:00.000Z')
    expect(items[0]?.id).toBe(`kn-510050-2026-09-12-${'weak rebound'.length}`)
  })
})

describe('PredictionStore', () => {
  it('create 幂等覆盖同一 underlying+targetDate；settle 按 id 命中', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-pred-'))
    let now = '2026-09-11T08:00:00.000Z'
    const store = new PredictionStore({
      dataRoot: () => root,
      now: () => new Date(now),
    })
    const first = await store.create(draft())
    expect(first.id).toBe('510050-2026-09-12')
    expect(first.asOfDate).toBe('2026-09-11')
    now = '2026-09-11T09:00:00.000Z'
    const second = await store.create(draft({ thesis: '改写', confidence: 0.9 }))
    expect(second.thesis).toBe('改写')
    now = '2026-09-12T07:00:00.000Z'
    const settled = await store.settle(settle())
    expect(settled.outcome?.score).toBe(1)
    expect(settled.thesis).toBe('改写')
    const raw = await readFile(path.join(root, 'predictions.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    const track = await store.track('510050')
    expect(track.predictions).toHaveLength(1)
    expect(track.stats.scored).toBe(1)
    const board = await store.board('510050', 'as-of')
    expect(board.asOf).toBe('as-of')
    expect(board.rows[0]?.total).toBe(1)
    expect(board.rows[0]?.marketHitRate).toBe(1)
    const knowledge = await store.knowledge('510050')
    expect(knowledge[0]?.lesson).toBe('弱反弹可续')
  })

  it('settle 找不到 id 抛错', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-pred-'))
    const store = new PredictionStore({ dataRoot: () => root, now: () => new Date('2026-09-11T08:00:00.000Z') })
    await expect(store.settle(settle())).rejects.toThrow('prediction not found: 510050-2026-09-12')
  })

  it('autoSettle 用日 K + IV 权威回填；settleDue 只处理已到期未回填', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-pred-'))
    let now = '2026-09-11T08:00:00.000Z'
    const store = new PredictionStore({
      dataRoot: () => root,
      now: () => new Date(now),
    })
    await store.create(draft({ targetDate: '2026-09-12', thesis: '自动回填' }))
    await store.create(draft({ targetDate: '2026-09-15', thesis: '未到期' }))
    now = '2026-09-12T07:00:00.000Z'
    const bars: PredictionMarketBar[] = [
      { date: '2026-09-11', high: 3.01, low: 2.99, close: 3.0, volume: 100 },
      { date: '2026-09-12', high: 3.03, low: 3.0, close: 3.024, volume: 110 },
    ]
    const settled = await store.autoSettle('510050-2026-09-12', {
      bars,
      ivSeries: [
        { date: '2026-09-11', atmIv: 0.18 },
        { date: '2026-09-12', atmIv: 0.20 },
      ],
    })
    expect(settled.outcome?.realizedMarket).toBe('small_up')
    expect(settled.outcome?.marketReturnPct).toBeCloseTo(0.8, 5)
    expect(settled.outcome?.realizedVol).toBe('up')
    expect(settled.outcome?.volChange).toBeCloseTo(0.02, 8)
    expect(settled.outcome?.score).toBe(1)
    const due = await store.settleDue('2026-09-12', async () => ({ bars, ivSeries: [] }))
    expect(due.settled.map((row) => row.id)).toEqual([])
    expect(due.skipped.some((row) => row.id === '510050-2026-09-15')).toBe(true)
  })
})

describe('dayPriorOf', () => {
  it('当日精确命中优先；否则取未回填的下一目标日；过期不注入', () => {
    const today = prediction({
      id: '510050-2026-09-14', targetDate: '2026-09-14', createdAt: '2026-09-12T04:00:00.000Z', confidence: 0.7,
    })
    const older = prediction({
      id: '510050-2026-09-14b', targetDate: '2026-09-14', createdAt: '2026-09-11T04:00:00.000Z', confidence: 0.4,
    })
    const next = prediction({ id: '510050-2026-09-15', targetDate: '2026-09-15', createdAt: '2026-09-12T04:00:00.000Z' })
    const past = prediction({ id: '510050-2026-09-11', targetDate: '2026-09-11', createdAt: '2026-09-10T04:00:00.000Z' })
    expect(dayPriorOf([older, today], '510050', '2026-09-14')?.confidence).toBe(today.confidence)
    expect(dayPriorOf([next, past], '510050', '2026-09-12')?.targetDate).toBe('2026-09-15')
    expect(dayPriorOf([past], '510050', '2026-09-12')).toBeUndefined()
    expect(dayPriorOf([today], '510300', '2026-09-14')).toBeUndefined()
  })
})

describe('resolvePredictionAutoAsOf', () => {
  it('周六/周一的 T-1 都落到上周五；日 K 更早则用日 K', () => {
    expect(previousShanghaiWeekday('2026-09-12')).toBe('2026-09-11')
    expect(previousShanghaiWeekday('2026-09-14')).toBe('2026-09-11')
    expect(previousShanghaiWeekday('2026-09-15')).toBe('2026-09-14')
    expect(resolvePredictionAutoAsOf('2026-09-12')).toBe('2026-09-11')
    expect(resolvePredictionAutoAsOf('2026-09-14', '2026-09-11')).toBe('2026-09-11')
    expect(resolvePredictionAutoAsOf('2026-09-15', '2026-09-10')).toBe('2026-09-10')
    expect(resolvePredictionAutoAsOf('2026-09-15', '2026-09-15')).toBe('2026-09-14')
  })
})

function bar(date: string, close: number, over: Partial<PredictionMarketBar> = {}): PredictionMarketBar {
  return { date, high: close, low: close, close, volume: 100, ...over }
}

describe('classifyMarketFromBars', () => {
  it('缺目标日或昨收 → na', () => {
    expect(classifyMarketFromBars([bar('2026-09-11', 3)], '2026-09-12')).toEqual({
      realizedMarket: 'na',
      marketReturnPct: 0,
    })
  })

  it('|ret|<0.5 → consolidation；0.5–1.5 → small_*；≥1.5 → big_*', () => {
    const prev = bar('2026-09-11', 3)
    expect(classifyMarketFromBars([prev, bar('2026-09-12', 3.012)], '2026-09-12').realizedMarket).toBe('consolidation')
    expect(classifyMarketFromBars([prev, bar('2026-09-12', 3.024)], '2026-09-12')).toMatchObject({
      realizedMarket: 'small_up',
    })
    expect(classifyMarketFromBars([prev, bar('2026-09-12', 2.976)], '2026-09-12').realizedMarket).toBe('small_down')
    expect(classifyMarketFromBars([prev, bar('2026-09-12', 3.05)], '2026-09-12').realizedMarket).toBe('big_up')
    expect(classifyMarketFromBars([prev, bar('2026-09-12', 2.95)], '2026-09-12').realizedMarket).toBe('big_down')
  })

  it('放量突破前高优先于涨跌幅分类', () => {
    const prior = [1, 2, 3, 4, 5].map((n) => bar(`2026-09-0${n}`, 3, { high: 3.01, low: 2.99, volume: 100 }))
    const target = bar('2026-09-12', 3.02, { high: 3.05, low: 3.0, volume: 200 })
    expect(classifyMarketFromBars([...prior, target], '2026-09-12').realizedMarket).toBe('breakout')
  })
})

describe('classifyVolFromLevels', () => {
  it('缺一侧 → na；上升/下降按符号', () => {
    expect(classifyVolFromLevels(undefined, 0.2)).toEqual({ realizedVol: 'na', volChange: 0 })
    expect(classifyVolFromLevels(0.18, 0.2).realizedVol).toBe('up')
    expect(classifyVolFromLevels(0.18, 0.2).volChange).toBeCloseTo(0.02, 8)
    expect(classifyVolFromLevels(0.2, 0.18)).toMatchObject({ realizedVol: 'down' })
    expect(classifyVolFromLevels(0.2, 0.2)).toEqual({ realizedVol: 'na', volChange: 0 })
  })
})

describe('realizePrediction / helpers', () => {
  it('etfSpotSymbol 与 klines 上海日历', () => {
    expect(etfSpotSymbol('510050')).toBe('510050.SH')
    expect(etfSpotSymbol('159915')).toBe('159915.SZ')
    expect(etfSpotSymbol('600519')).toBeUndefined()
    const bars = klinesToPredictionBars([
      {
        openTime: Date.parse('2026-09-12T01:30:00.000Z'),
        open: 3,
        high: 3.02,
        low: 2.99,
        close: 3.01,
        volume: 10,
        closeTime: Date.parse('2026-09-12T07:00:00.000Z'),
      },
    ])
    expect(bars[0]?.date).toBe('2026-09-12')
  })

  it('realizePrediction 优先 ATM IV，否则 HV', () => {
    const input = realizePrediction(
      prediction(),
      [bar('2026-09-11', 3), bar('2026-09-12', 3.024)],
      { ivSeries: [{ date: '2026-09-11', hv20: 0.15 }, { date: '2026-09-12', hv20: 0.14 }] },
    )
    expect(input.realizedVol).toBe('down')
    expect(input.volChange).toBeCloseTo(-0.01, 8)
  })
})
