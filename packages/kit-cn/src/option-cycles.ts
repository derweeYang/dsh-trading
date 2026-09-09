/**
 * ETF 期权 5 分钟闭环：打分上一周期箱体，再校准下一周期。
 * 纯函数 + 内存账本。不下单、不调 LLM。
 */
import type {
  Kline,
  OptionCycle,
  OptionCycleCalibration,
  OptionCycleLoop,
  OptionCycleScore,
  OptionCycleStats,
  OptionCycleVerdict,
  OptionIntradayBoxRow,
} from '@dshtrading/api'

export const CYCLE_HORIZON_MS = 5 * 60 * 1000
export const CYCLE_MAX_PER_UNDERLYING = 48
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const WIDEN_FACTOR = 1.25
const WIDEN_CAP_PCT = 0.02

/** Asia/Shanghai 无夏令时：把 epoch 对齐到 5 分钟墙钟桶。 */
export function shanghaiBucketStartMs(nowMs: number, horizonMs = CYCLE_HORIZON_MS): number {
  const shifted = nowMs + SHANGHAI_OFFSET_MS
  return Math.floor(shifted / horizonMs) * horizonMs - SHANGHAI_OFFSET_MS
}

export function cycleId(underlying: string, bucketStartMs: number): string {
  return `${underlying}:${bucketStartMs}`
}

export function realizedInWindow(
  klines: readonly Kline[],
  fromMs: number,
  toMs: number,
): Kline[] {
  return [...klines]
    .filter((bar) => bar.closeTime > fromMs && bar.closeTime <= toMs)
    .sort((a, b) => a.closeTime - b.closeTime)
}

export function scorePreviousCycle(input: {
  forecast: OptionIntradayBoxRow
  realized: readonly Kline[]
}): OptionCycleScore {
  const { forecast, realized } = input
  if (forecast.regime === 'no_trade') {
    return { verdict: 'skipped', barCount: realized.length, skipReason: 'no_trade' }
  }
  if (forecast.boxLow === undefined || forecast.boxHigh === undefined) {
    return { verdict: 'skipped', barCount: realized.length, skipReason: 'no_box' }
  }
  if (realized.length < 3) {
    return { verdict: 'skipped', barCount: realized.length, skipReason: 'insufficient' }
  }

  const highs = realized.map((bar) => bar.high)
  const lows = realized.map((bar) => bar.low)
  const last = realized[realized.length - 1]!.close
  const realizedHigh = Math.max(...highs)
  const realizedLow = Math.min(...lows)
  const closeInside = last >= forecast.boxLow && last <= forecast.boxHigh
  const pathInside = realizedHigh <= forecast.boxHigh && realizedLow >= forecast.boxLow
  const directionHit = forecast.bias === 'up'
    ? last > (forecast.last ?? last)
    : forecast.bias === 'down'
      ? last < (forecast.last ?? last)
      : closeInside

  const width = forecast.boxHigh - forecast.boxLow
  const realizedRange = realizedHigh - realizedLow
  let regimeHit = closeInside
  if (forecast.regime === 'breakout') regimeHit = !closeInside && directionHit
  else if (forecast.regime === 'vol_expand') regimeHit = width > 0 && realizedRange >= width * 0.8
  else if (forecast.regime === 'mean_revert' || forecast.regime === 'range_hold') regimeHit = closeInside

  let verdict: OptionCycleVerdict = 'miss'
  if (regimeHit) verdict = 'hit'
  else if (closeInside) verdict = 'partial'

  return {
    verdict,
    barCount: realized.length,
    closeInside,
    pathInside,
    directionHit,
    regimeHit,
    realizedLast: last,
    realizedHigh,
    realizedLow,
  }
}

export function calibrateNextForecast(
  forecast: OptionIntradayBoxRow,
  recent: readonly OptionCycleScore[],
): { forecast: OptionIntradayBoxRow; calibration: OptionCycleCalibration } {
  const last3 = recent.filter((row) => row.verdict !== 'skipped').slice(-3)
  if (last3.length < 3) return { forecast, calibration: 'none' }

  if (last3.every((row) => row.verdict === 'miss') && last3.every((row) => row.regimeHit === false)) {
    return {
      forecast: {
        ...forecast,
        regime: 'no_trade',
        noTradeReason: 'calibrated',
        candidates: [],
      },
      calibration: 'suppressed',
    }
  }

  if (
    last3.every((row) => row.verdict === 'miss')
    && forecast.last !== undefined
    && forecast.halfWidth !== undefined
    && forecast.boxLow !== undefined
    && forecast.boxHigh !== undefined
  ) {
    const widened = Math.min(forecast.halfWidth * WIDEN_FACTOR, forecast.last * WIDEN_CAP_PCT)
    if (widened > forecast.halfWidth) {
      return {
        forecast: {
          ...forecast,
          halfWidth: widened,
          boxLow: forecast.last - widened,
          boxHigh: forecast.last + widened,
        },
        calibration: 'widened',
      }
    }
  }
  return { forecast, calibration: 'none' }
}

export function statsOf(cycles: readonly OptionCycle[]): OptionCycleStats {
  let hits = 0
  let misses = 0
  let partials = 0
  let skipped = 0
  for (const cycle of cycles) {
    const verdict = cycle.score?.verdict
    if (verdict === 'hit') hits += 1
    else if (verdict === 'miss') misses += 1
    else if (verdict === 'partial') partials += 1
    else if (verdict === 'skipped') skipped += 1
  }
  const scored = hits + misses + partials
  return {
    n: cycles.length,
    hits,
    misses,
    partials,
    skipped,
    ...(scored === 0 ? {} : { hitRate: hits / scored }),
  }
}

export class OptionCycleBook {
  readonly #byUnderlying = new Map<string, OptionCycle[]>()
  lastBucket?: string
  running = false

  list(underlying?: string, limit = 12): OptionCycle[] {
    const cap = Math.min(Math.max(limit, 1), CYCLE_MAX_PER_UNDERLYING)
    if (underlying !== undefined) {
      return (this.#byUnderlying.get(underlying) ?? []).slice(-cap)
    }
    const all: OptionCycle[] = []
    for (const rows of this.#byUnderlying.values()) all.push(...rows)
    return all.sort((a, b) => a.asOf.localeCompare(b.asOf)).slice(-cap)
  }

  latest(underlying: string): OptionCycle | undefined {
    const rows = this.#byUnderlying.get(underlying)
    return rows?.[rows.length - 1]
  }

  scores(underlying: string): OptionCycleScore[] {
    return (this.#byUnderlying.get(underlying) ?? [])
      .map((row) => row.score)
      .filter((row): row is OptionCycleScore => row !== undefined)
  }

  upsert(cycle: OptionCycle): OptionCycle {
    const rows = this.#byUnderlying.get(cycle.underlying) ?? []
    const index = rows.findIndex((row) => row.id === cycle.id)
    if (index >= 0) {
      const next = [...rows]
      next[index] = cycle
      this.#byUnderlying.set(cycle.underlying, next)
      return cycle
    }
    const appended = [...rows, cycle].slice(-CYCLE_MAX_PER_UNDERLYING)
    this.#byUnderlying.set(cycle.underlying, appended)
    return cycle
  }

  loop(underlyings: readonly string[]): OptionCycleLoop {
    return {
      running: this.running,
      horizonMin: 5,
      ...(this.lastBucket === undefined ? {} : { lastBucket: this.lastBucket }),
      rows: underlyings.map((underlying) => {
        const latest = this.latest(underlying)
        const stats = statsOf(this.#byUnderlying.get(underlying) ?? [])
        if (latest === undefined) return { underlying, stats }
        return { underlying, stats, latest }
      }),
    }
  }
}
