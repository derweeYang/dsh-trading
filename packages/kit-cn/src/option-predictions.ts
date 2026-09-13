/**
 * 期权 T+1 预测：JSONL 持久化 + 权威命中/评分/统计（不依赖期权网关）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Kline,
  MarketExpectation,
  OptionBarDailyIv,
  OptionBarDayPrior,
  OptionPrediction,
  OptionPredictionBoard,
  OptionPredictionBoardRow,
  OptionPredictionDraft,
  OptionPredictionSettle,
  OptionPredictionStats,
  OptionPredictionTrack,
  PredictionKnowledgeItem,
  PredictionMatrixCell,
  PredictionOutcome,
  VolExpectation,
} from '@dshtrading/api'
import { optionsDataRoot, shanghaiCalendarDate } from './option-bar-ledger.js'

export const PREDICTION_CONSOLIDATION_PCT = 0.5
export const PREDICTION_BIG_MOVE_PCT = 1.5
export const PREDICTION_BREAKOUT_VOLUME = 1.5
export const PREDICTION_BREAKOUT_LOOKBACK = 5
export const DEFAULT_PREDICTION_EVALUATION =
  '盘势：|收盘涨跌幅|<0.5% 盘整；0.5–1.5% 小涨/小跌；≥1.5% 大涨/大跌；放量(≥1.5×近5日均量)且突破近5日高低点优先判突破。波动：ATM IV（缺则 HV20）T+1 相对 T 的符号。'

export interface PredictionMarketBar {
  readonly date: string
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface PredictionIvPoint {
  readonly date: string
  readonly atmIv?: number
  readonly hv20?: number
}

export interface RealizePredictionInput {
  readonly bars: readonly PredictionMarketBar[]
  readonly ivSeries?: readonly PredictionIvPoint[]
  readonly retrospect?: string
  readonly knowledgeNotes?: string
}

export interface PredictionAutoSettleResult {
  readonly settled: OptionPrediction[]
  readonly skipped: { id: string; reason: string }[]
}

export function etfSpotSymbol(underlying: string): string | undefined {
  const code = underlying.trim()
  if (/^5\d{5}$/.test(code)) return `${code}.SH`
  if (/^1\d{5}$/.test(code)) return `${code}.SZ`
  return undefined
}

export function klinesToPredictionBars(klines: readonly Kline[]): PredictionMarketBar[] {
  const byDate = new Map<string, PredictionMarketBar>()
  for (const bar of klines) {
    const date = shanghaiCalendarDate(bar.closeTime)
    byDate.set(date, {
      date,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function lastOnOrBefore<T extends { date: string }>(rows: readonly T[], date: string): T | undefined {
  return [...rows].filter((row) => row.date <= date).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
}

export function classifyMarketFromBars(
  bars: readonly PredictionMarketBar[],
  targetDate: string,
): { realizedMarket: MarketExpectation | 'na'; marketReturnPct: number } {
  const ordered = [...bars].sort((a, b) => a.date.localeCompare(b.date))
  const idx = ordered.findIndex((row) => row.date === targetDate)
  const target = idx >= 0 ? ordered[idx] : undefined
  const prev = idx > 0 ? ordered[idx - 1] : undefined
  if (target === undefined || prev === undefined || prev.close <= 0) {
    return { realizedMarket: 'na', marketReturnPct: 0 }
  }
  const marketReturnPct = ((target.close - prev.close) / prev.close) * 100
  const lookback = ordered.slice(Math.max(0, idx - PREDICTION_BREAKOUT_LOOKBACK), idx)
  if (lookback.length === PREDICTION_BREAKOUT_LOOKBACK) {
    const avgVol = lookback.reduce((sum, row) => sum + row.volume, 0) / lookback.length
    const volumeRatio = avgVol > 0 ? target.volume / avgVol : 0
    const brokeHigh = target.high > Math.max(...lookback.map((row) => row.high))
    const brokeLow = target.low < Math.min(...lookback.map((row) => row.low))
    if (volumeRatio >= PREDICTION_BREAKOUT_VOLUME && (brokeHigh || brokeLow) && Math.abs(marketReturnPct) >= PREDICTION_CONSOLIDATION_PCT) {
      return { realizedMarket: 'breakout', marketReturnPct }
    }
  }
  if (Math.abs(marketReturnPct) < PREDICTION_CONSOLIDATION_PCT) {
    return { realizedMarket: 'consolidation', marketReturnPct }
  }
  if (marketReturnPct >= PREDICTION_BIG_MOVE_PCT) return { realizedMarket: 'big_up', marketReturnPct }
  if (marketReturnPct <= -PREDICTION_BIG_MOVE_PCT) return { realizedMarket: 'big_down', marketReturnPct }
  return { realizedMarket: marketReturnPct > 0 ? 'small_up' : 'small_down', marketReturnPct }
}

export function classifyVolFromLevels(
  asOf: number | undefined,
  target: number | undefined,
): { realizedVol: VolExpectation | 'na'; volChange: number } {
  if (asOf === undefined || target === undefined || !Number.isFinite(asOf) || !Number.isFinite(target)) {
    return { realizedVol: 'na', volChange: 0 }
  }
  const volChange = target - asOf
  if (volChange === 0) return { realizedVol: 'na', volChange: 0 }
  return { realizedVol: volChange > 0 ? 'up' : 'down', volChange }
}

export function realizePrediction(
  prediction: OptionPrediction,
  bars: readonly PredictionMarketBar[],
  extra: Omit<RealizePredictionInput, 'bars'> = {},
): OptionPredictionSettle {
  const market = classifyMarketFromBars(bars, prediction.targetDate)
  const series = extra.ivSeries ?? []
  const asOfPoint = lastOnOrBefore(series, prediction.asOfDate)
  const targetPoint = lastOnOrBefore(series, prediction.targetDate)
  const iv = classifyVolFromLevels(asOfPoint?.atmIv, targetPoint?.atmIv)
  const vol = iv.realizedVol !== 'na' ? iv : classifyVolFromLevels(asOfPoint?.hv20, targetPoint?.hv20)
  return {
    id: prediction.id,
    realizedMarket: market.realizedMarket,
    realizedVol: vol.realizedVol,
    marketReturnPct: market.marketReturnPct,
    volChange: vol.volChange,
    ...(extra.retrospect !== undefined ? { retrospect: extra.retrospect } : {}),
    ...(extra.knowledgeNotes !== undefined ? { knowledgeNotes: extra.knowledgeNotes } : {}),
  }
}

export function predictionId(underlying: string, targetDate: string): string {
  return `${underlying}-${targetDate}`
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** 上一上海日历工作日（跳过周六日；节假日用 lastBarDate 再收窄）。 */
export function previousShanghaiWeekday(isoDate: string): string {
  if (!ISO_DATE.test(isoDate)) throw new Error(`previousShanghaiWeekday: invalid date ${isoDate}`)
  let ms = Date.parse(`${isoDate}T12:00:00+08:00`)
  for (let i = 0; i < 8; i++) {
    ms -= 86_400_000
    const candidate = shanghaiCalendarDate(ms)
    const dow = new Date(`${candidate}T12:00:00+08:00`).getUTCDay()
    if (dow !== 0 && dow !== 6) return candidate
  }
  throw new Error('previousShanghaiWeekday: no weekday')
}

/**
 * 自动回填默认 asOf = T-1（上一已收盘交易日）。
 * lastBarDate 若早于今日，优先采用（避开周末/假日空窗）。
 */
export function resolvePredictionAutoAsOf(today: string, lastBarDate?: string): string {
  if (lastBarDate !== undefined && ISO_DATE.test(lastBarDate) && lastBarDate < today) {
    return lastBarDate
  }
  return previousShanghaiWeekday(today)
}

export function toDayPrior(prediction: OptionPrediction): OptionBarDayPrior {
  return {
    targetDate: prediction.targetDate,
    marketExpectation: prediction.marketExpectation,
    volExpectation: prediction.volExpectation,
    confidence: prediction.confidence,
  }
}

/**
 * 盯盘先验：先取 targetDate=sessionDate 最新一条；否则取尚未回填且 targetDate≥今日的最近一条。
 * 过期（targetDate < sessionDate）不注入。
 */
export function dayPriorOf(
  predictions: readonly OptionPrediction[],
  underlying: string,
  sessionDate: string,
): OptionBarDayPrior | undefined {
  const mine = predictions.filter((row) => row.underlying === underlying)
  const exact = [...mine.filter((row) => row.targetDate === sessionDate)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (exact !== undefined) return toDayPrior(exact)
  const upcoming = [...mine.filter((row) => row.targetDate >= sessionDate && row.outcome === undefined)]
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate) || b.createdAt.localeCompare(a.createdAt))[0]
  return upcoming === undefined ? undefined : toDayPrior(upcoming)
}

export function predictionsPath(root: string): string {
  return path.join(root, 'predictions.jsonl')
}

export interface PredictionStoreOptions {
  readonly dataRoot?: () => string
  readonly now?: () => Date
}

async function readAll(root: string): Promise<OptionPrediction[]> {
  try {
    const raw = await readFile(predictionsPath(root), 'utf8')
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const parsed: OptionPrediction[] = []
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as OptionPrediction)
      } catch {
        // 单行损坏不影响其余
      }
    }
    return parsed
  } catch {
    return []
  }
}

async function writeAll(root: string, list: readonly OptionPrediction[]): Promise<void> {
  const dest = predictionsPath(root)
  await mkdir(path.dirname(dest), { recursive: true })
  const content = list.map((item) => JSON.stringify(item)).join('\n') + (list.length > 0 ? '\n' : '')
  await writeFile(dest, content, 'utf8')
}

function laterIso(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b
}

/** 回填时权威计算命中与评分（调用方只传原始实盘）。 */
export function scoreOutcome(
  prediction: OptionPrediction,
  input: OptionPredictionSettle,
  now: () => Date = () => new Date(),
): PredictionOutcome {
  const hitMarket = input.realizedMarket !== 'na' && input.realizedMarket === prediction.marketExpectation
  const hitVol = input.realizedVol !== 'na' && input.realizedVol === prediction.volExpectation
  const components: number[] = []
  if (input.realizedMarket !== 'na') components.push(hitMarket ? 1 : 0)
  if (input.realizedVol !== 'na') components.push(hitVol ? 1 : 0)
  const score = components.length === 0
    ? 0
    : components.reduce((sum, value) => sum + value, 0) / components.length
  return {
    realizedMarket: input.realizedMarket,
    realizedVol: input.realizedVol,
    marketReturnPct: input.marketReturnPct,
    volChange: input.volChange,
    hitMarket,
    hitVol,
    score,
    retrospect: input.retrospect ?? '',
    knowledgeNotes: input.knowledgeNotes ?? '',
    settledAt: now().toISOString(),
  }
}

export function predictionStatsOf(predictions: readonly OptionPrediction[]): OptionPredictionStats {
  const scored = predictions.filter((p) => p.outcome !== undefined)
  const marketMatrix: Record<string, PredictionMatrixCell> = {}
  const volMatrix: Record<string, PredictionMatrixCell> = {}
  let marketHits = 0
  let volHits = 0
  let scoreSum = 0
  for (const p of scored) {
    const o = p.outcome!
    const mKey = p.marketExpectation
    marketMatrix[mKey] = marketMatrix[mKey] ?? { predicted: 0, hit: 0 }
    marketMatrix[mKey].predicted += 1
    if (o.realizedMarket !== 'na' && o.hitMarket) {
      marketMatrix[mKey].hit += 1
      marketHits += 1
    }
    const vKey = p.volExpectation
    volMatrix[vKey] = volMatrix[vKey] ?? { predicted: 0, hit: 0 }
    volMatrix[vKey].predicted += 1
    if (o.realizedVol !== 'na' && o.hitVol) {
      volMatrix[vKey].hit += 1
      volHits += 1
    }
    scoreSum += o.score
  }
  const marketScored = scored.filter((p) => p.outcome!.realizedMarket !== 'na').length
  const volScored = scored.filter((p) => p.outcome!.realizedVol !== 'na').length
  return {
    total: predictions.length,
    scored: scored.length,
    marketHitRate: marketScored === 0 ? 0 : marketHits / marketScored,
    volHitRate: volScored === 0 ? 0 : volHits / volScored,
    avgScore: scored.length === 0 ? 0 : scoreSum / scored.length,
    marketMatrix,
    volMatrix,
  }
}

export function aggregateKnowledge(predictions: readonly OptionPrediction[]): PredictionKnowledgeItem[] {
  const byKey = new Map<string, {
    lesson: string
    condition: string
    sources: string[]
    usage: number
    createdAt: string
    firstId: string
  }>()
  for (const p of predictions) {
    const o = p.outcome
    if (o === undefined || o.knowledgeNotes.trim() === '') continue
    const lesson = o.knowledgeNotes.trim()
    const key = lesson.toLowerCase()
    const stamp = laterIso(p.createdAt, o.settledAt)
    const existing = byKey.get(key)
    if (existing !== undefined) {
      if (!existing.sources.includes(p.id)) existing.sources.push(p.id)
      existing.usage += 1
      existing.createdAt = laterIso(existing.createdAt, stamp)
    } else {
      byKey.set(key, {
        lesson,
        condition: p.thesis.trim(),
        sources: [p.id],
        usage: 1,
        createdAt: stamp,
        firstId: p.id,
      })
    }
  }
  return [...byKey.entries()]
    .map(([key, item]) => ({
      id: `kn-${item.firstId}-${key.length}`,
      lesson: item.lesson,
      condition: item.condition,
      sources: item.sources,
      usage: item.usage,
      createdAt: item.createdAt,
    }))
    .sort((a, b) => b.usage - a.usage)
}

export class PredictionStore {
  readonly #dataRoot: () => string
  readonly #now: () => Date

  constructor(options: PredictionStoreOptions = {}) {
    this.#dataRoot = options.dataRoot ?? (() => optionsDataRoot())
    this.#now = options.now ?? (() => new Date())
  }

  async board(underlying?: string, asOf?: string): Promise<OptionPredictionBoard> {
    const all = await readAll(this.#dataRoot())
    const filtered = underlying === undefined ? all : all.filter((p) => p.underlying === underlying)
    const byUnderlying = new Map<string, OptionPrediction[]>()
    for (const p of filtered) {
      const list = byUnderlying.get(p.underlying) ?? []
      list.push(p)
      byUnderlying.set(p.underlying, list)
    }
    const rows: OptionPredictionBoardRow[] = []
    for (const [u, list] of byUnderlying) {
      const sorted = [...list].sort((a, b) => b.targetDate.localeCompare(a.targetDate) || b.createdAt.localeCompare(a.createdAt))
      const latest = sorted[0]
      const scored = list.filter((p) => p.outcome !== undefined)
      const marketScored = scored.filter((p) => p.outcome!.realizedMarket !== 'na')
      const volScored = scored.filter((p) => p.outcome!.realizedVol !== 'na')
      const marketHits = marketScored.filter((p) => p.outcome!.hitMarket).length
      const volHits = volScored.filter((p) => p.outcome!.hitVol).length
      rows.push({
        underlying: u,
        ...(latest?.underlyingName !== undefined ? { underlyingName: latest.underlyingName } : {}),
        latest,
        ...(marketScored.length > 0 ? { marketHitRate: marketHits / marketScored.length } : {}),
        ...(volScored.length > 0 ? { volHitRate: volHits / volScored.length } : {}),
        total: list.length,
      })
    }
    rows.sort((a, b) => a.underlying.localeCompare(b.underlying))
    return { asOf: asOf ?? this.#now().toISOString(), rows }
  }

  async track(underlying?: string, limit?: number): Promise<OptionPredictionTrack> {
    const all = await readAll(this.#dataRoot())
    const filtered = underlying === undefined ? all : all.filter((p) => p.underlying === underlying)
    const sorted = [...filtered].sort((a, b) => b.targetDate.localeCompare(a.targetDate) || b.createdAt.localeCompare(a.createdAt))
    const shown = limit === undefined ? sorted : sorted.slice(0, limit)
    return {
      ...(underlying !== undefined ? { underlying } : {}),
      predictions: shown,
      stats: predictionStatsOf(filtered),
      knowledge: aggregateKnowledge(filtered),
    }
  }

  async create(draft: OptionPredictionDraft): Promise<OptionPrediction> {
    const root = this.#dataRoot()
    const all = await readAll(root)
    const id = predictionId(draft.underlying, draft.targetDate)
    const now = this.#now().toISOString()
    const next: OptionPrediction = {
      id,
      underlying: draft.underlying,
      ...(draft.underlyingName !== undefined && draft.underlyingName !== '' ? { underlyingName: draft.underlyingName } : {}),
      asOfDate: now.slice(0, 10),
      targetDate: draft.targetDate,
      marketExpectation: draft.marketExpectation,
      volExpectation: draft.volExpectation,
      confidence: draft.confidence,
      factors: draft.factors,
      thesis: draft.thesis,
      evaluationMethod: draft.evaluationMethod,
      createdAt: now,
    }
    const idx = all.findIndex((p) => p.id === id)
    if (idx >= 0) all[idx] = next
    else all.push(next)
    await writeAll(root, all)
    return next
  }

  async settle(input: OptionPredictionSettle): Promise<OptionPrediction> {
    const root = this.#dataRoot()
    const all = await readAll(root)
    const idx = all.findIndex((p) => p.id === input.id)
    if (idx < 0) throw new Error(`prediction not found: ${input.id}`)
    const current = all[idx]!
    const updated: OptionPrediction = { ...current, outcome: scoreOutcome(current, input, this.#now) }
    all[idx] = updated
    await writeAll(root, all)
    return updated
  }

  async autoSettle(id: string, input: RealizePredictionInput): Promise<OptionPrediction> {
    const root = this.#dataRoot()
    const all = await readAll(root)
    const current = all.find((p) => p.id === id)
    if (current === undefined) throw new Error(`prediction not found: ${id}`)
    return this.settle(realizePrediction(current, input.bars, input))
  }

  async settleDue(
    asOf: string,
    load: (prediction: OptionPrediction) => Promise<RealizePredictionInput>,
  ): Promise<PredictionAutoSettleResult> {
    const all = await readAll(this.#dataRoot())
    const settled: OptionPrediction[] = []
    const skipped: { id: string; reason: string }[] = []
    for (const row of all) {
      if (row.outcome !== undefined) {
        skipped.push({ id: row.id, reason: 'already_settled' })
        continue
      }
      if (row.targetDate > asOf) {
        skipped.push({ id: row.id, reason: 'not_due' })
        continue
      }
      const loaded = await load(row)
      settled.push(await this.autoSettle(row.id, loaded))
    }
    return { settled, skipped }
  }

  async knowledge(underlying?: string): Promise<readonly PredictionKnowledgeItem[]> {
    const all = await readAll(this.#dataRoot())
    const filtered = underlying === undefined ? all : all.filter((p) => p.underlying === underlying)
    return aggregateKnowledge(filtered)
  }
}
