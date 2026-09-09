/**
 * ETF 期权 1 分钟 → 5 分钟箱体（纯函数，零 I/O）。
 * 数字由本模块算；LLM 只读 JSON，不得重算箱体。
 */
import type {
  Kline,
  MarketDataService,
  OptionIntradayBox,
  OptionIntradayBoxRow,
  OptionIntradayCandidate,
  OptionIntradayRegime,
  OptionIntradaySession,
  OptionUnderlying,
} from '@dshtrading/api'

export const BOX_LOOKBACK = 60 as const
export const BOX_SIGMA_BARS = 30
export const BOX_ATR_PERIOD = 14
export const BOX_DONCHIAN_BARS = 15
export const BOX_HORIZON_MIN = 5 as const
export const BOX_VOLUME_SURGE = 1.5
export const BOX_VOL_EXPAND = 1.8
export const BOX_EDGE = 0.2

const TWIN: Readonly<Record<string, string>> = {
  '510300': '159919',
  '159919': '510300',
  '510500': '159922',
  '159922': '510500',
  '588000': '588080',
  '588080': '588000',
}

export function twinUnderlyingOf(underlying: string): string | undefined {
  return TWIN[underlying]
}

export function spotSymbolOfBox(
  underlying: string,
  exchange: 'SSE' | 'SZSE' | 'SYNTH',
): string | undefined {
  if (exchange === 'SSE') return `${underlying}.SH`
  if (exchange === 'SZSE') return `${underlying}.SZ`
  return undefined
}

/** Asia/Shanghai 会话门：regular 才允许给策略候选。 */
export function sessionFlag(nowMs: number): OptionIntradaySession {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed'
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'closed'
  const t = hour * 60 + minute
  if (t >= 9 * 60 + 30 && t < 9 * 60 + 45) return 'open15'
  if (t >= 11 * 60 + 25 && t < 11 * 60 + 30) return 'lunch'
  if (t >= 13 * 60 && t < 13 * 60 + 5) return 'lunch'
  if (t >= 14 * 60 + 55 && t < 15 * 60) return 'close5'
  if (t >= 9 * 60 + 45 && t < 11 * 60 + 25) return 'regular'
  if (t >= 13 * 60 + 5 && t < 14 * 60 + 55) return 'regular'
  return 'closed'
}

export function bareUnderlying(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  const six = trimmed.match(/^(\d{6})/)
  if (six?.[1] !== undefined) return six[1]
  return trimmed.replace(/\.(SH|SZ)$/u, '')
}

/** 名册去 SYNTH；underlying 空 / all = 全表；指定但未命中 = []。 */
export function selectBoxTargets(
  roster: readonly OptionUnderlying[],
  underlying?: string,
): OptionUnderlying[] {
  const live = roster.filter((row) => row.exchange !== 'SYNTH')
  if (underlying === undefined) return live
  const trimmed = underlying.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return live
  const bare = bareUnderlying(trimmed)
  return live.filter((row) => row.underlying === bare)
}

export async function collectIntradayBox(input: {
  roster: readonly OptionUnderlying[]
  market?: Pick<MarketDataService, 'getKlines'> & Partial<Pick<MarketDataService, 'getTicker'>>
  underlying?: string
  nowMs: number
}): Promise<OptionIntradayBox> {
  const targets = selectBoxTargets(input.roster, input.underlying)
  const rows = await Promise.all(targets.map((row) => loadBoxRow(row, input.market, input.nowMs)))
  return {
    asOf: new Date(input.nowMs).toISOString(),
    horizonMin: BOX_HORIZON_MIN,
    lookback: BOX_LOOKBACK,
    rows,
  }
}

async function loadBoxRow(
  row: OptionUnderlying,
  market: (Pick<MarketDataService, 'getKlines'> & Partial<Pick<MarketDataService, 'getTicker'>>) | undefined,
  nowMs: number,
): Promise<OptionIntradayBoxRow> {
  const spotSymbol = spotSymbolOfBox(row.underlying, row.exchange)
  let klines: readonly Kline[] = []
  let last: number | undefined
  if (spotSymbol !== undefined && market !== undefined) {
    try {
      klines = await market.getKlines(spotSymbol, '1m', BOX_LOOKBACK)
    } catch {
      klines = []
    }
    try {
      last = (await market.getTicker?.(spotSymbol))?.price
    } catch {
      last = undefined
    }
  }
  return buildIntradayBox({
    underlying: row.underlying,
    name: row.name,
    exchange: row.exchange,
    klines,
    nowMs,
    ...(last === undefined ? {} : { last }),
  })
}

export interface BuildIntradayBoxInput {
  readonly underlying: string
  readonly name: string
  readonly exchange: 'SSE' | 'SZSE' | 'SYNTH'
  readonly klines: readonly Kline[]
  readonly nowMs: number
  readonly last?: number
}

export function buildIntradayBox(input: BuildIntradayBoxInput): OptionIntradayBoxRow {
  const underlying = bareUnderlying(input.underlying)
  const spotSymbol = spotSymbolOfBox(underlying, input.exchange)
  const twin = twinUnderlyingOf(underlying)
  const session = sessionFlag(input.nowMs)
  const base = {
    underlying,
    name: input.name,
    exchange: input.exchange,
    horizonMin: BOX_HORIZON_MIN as 5,
    session,
    ...(spotSymbol === undefined ? {} : { spotSymbol }),
    ...(twin === undefined ? {} : { twinUnderlying: twin }),
  }

  if (session !== 'regular') {
    return {
      ...base,
      regime: 'no_trade',
      noTradeReason: session,
      candidates: [],
    }
  }

  const ordered = [...input.klines].sort((a, b) => a.closeTime - b.closeTime).slice(-BOX_LOOKBACK)
  const lastClose = ordered[ordered.length - 1]?.close
  const last = input.last ?? lastClose
  if (ordered.length < BOX_SIGMA_BARS + 1 || last === undefined || last <= 0) {
    return {
      ...base,
      regime: 'no_trade',
      noTradeReason: 'insufficient',
      candidates: [],
    }
  }

  const closes = ordered.map((bar) => bar.close)
  const sigma30 = logReturnStdev(closes.slice(-(BOX_SIGMA_BARS + 1)))
  const sigma5 = logReturnStdev(closes.slice(-6))
  const atr14 = wilderAtr(ordered, BOX_ATR_PERIOD)
  const halfRv = sigma30 === undefined ? undefined : sigma30 * Math.sqrt(BOX_HORIZON_MIN) * last
  const halfAtr = atr14 === undefined ? undefined : atr14 * Math.sqrt(BOX_HORIZON_MIN)
  const halfWidth = maxDefined(halfRv, halfAtr)
  const boxLow = halfWidth === undefined ? undefined : last - halfWidth
  const boxHigh = halfWidth === undefined ? undefined : last + halfWidth
  const vwap = typicalVwap(ordered)
  const donchian = donchianChannel(ordered, BOX_DONCHIAN_BARS)
  const volumeRatio = volumeRatioOf(ordered, 5, 30)

  const { regime, bias } = classifyRegime({
    last,
    sigma5,
    sigma30,
    volumeRatio,
    donchian,
  })
  const candidates = candidatesFor(regime, bias, boxLow, boxHigh)

  return {
    ...base,
    last,
    regime,
    candidates,
    ...(boxLow === undefined ? {} : { boxLow }),
    ...(boxHigh === undefined ? {} : { boxHigh }),
    ...(halfWidth === undefined ? {} : { halfWidth }),
    ...(sigma30 === undefined ? {} : { sigma1: sigma30 }),
    ...(atr14 === undefined ? {} : { atr14 }),
    ...(vwap === undefined ? {} : { vwap }),
    ...(donchian === undefined ? {} : { donchianHigh: donchian.high, donchianLow: donchian.low }),
    ...(volumeRatio === undefined ? {} : { volumeRatio }),
    ...(bias === undefined ? {} : { bias }),
  }
}

function classifyRegime(input: {
  last: number
  sigma5: number | undefined
  sigma30: number | undefined
  volumeRatio: number | undefined
  donchian: { high: number; low: number } | undefined
}): { regime: OptionIntradayRegime; bias?: 'up' | 'down' | 'neutral' } {
  if (
    input.sigma5 !== undefined
    && input.sigma30 !== undefined
    && input.sigma30 > 0
    && input.sigma5 / input.sigma30 >= BOX_VOL_EXPAND
  ) {
    return { regime: 'vol_expand', bias: 'neutral' }
  }

  const width = input.donchian === undefined ? 0 : input.donchian.high - input.donchian.low
  if (input.donchian !== undefined && width > 0) {
    const nearHigh = input.last >= input.donchian.high - BOX_EDGE * width
    const nearLow = input.last <= input.donchian.low + BOX_EDGE * width
    const surge = input.volumeRatio !== undefined && input.volumeRatio >= BOX_VOLUME_SURGE
    if (nearHigh && surge) return { regime: 'breakout', bias: 'up' }
    if (nearLow && surge) return { regime: 'breakout', bias: 'down' }
    if (nearHigh && !surge) return { regime: 'mean_revert', bias: 'down' }
    if (nearLow && !surge) return { regime: 'mean_revert', bias: 'up' }
  }
  return { regime: 'range_hold', bias: 'neutral' }
}

function candidatesFor(
  regime: OptionIntradayRegime,
  bias: 'up' | 'down' | 'neutral' | undefined,
  boxLow: number | undefined,
  boxHigh: number | undefined,
): OptionIntradayCandidate[] {
  const box = boxLow !== undefined && boxHigh !== undefined
    ? `[${boxLow.toFixed(4)}, ${boxHigh.toFixed(4)}]`
    : 'the 5-minute box'
  if (regime === 'no_trade') return []
  if (regime === 'range_hold') {
    return [{
      template: 'butterfly',
      bias: 'neutral',
      invalidIf: `1-minute close outside ${box}`,
      reason: 'Tight realized range; premium-selling butterfly only if IV is rich.',
    }]
  }
  if (regime === 'mean_revert') {
    return [{
      template: 'vertical',
      bias: bias ?? 'neutral',
      invalidIf: '1-minute close breaks Donchian on volumeRatio>=1.5',
      reason: 'Price at Donchian edge without volume confirmation; fade with a vertical.',
    }]
  }
  if (regime === 'breakout') {
    return [{
      template: 'vertical',
      bias: bias ?? 'neutral',
      invalidIf: '1-minute close re-enters the Donchian mid-band',
      reason: 'Donchian edge plus volume surge; directional vertical, do not short ATM straddle.',
    }]
  }
  return [
    {
      template: 'straddle',
      bias: 'neutral',
      invalidIf: '1-minute sigma collapses below the 30-bar sigma',
      reason: 'Intraday realized vol expanding; buy premium, no naked short.',
    },
    {
      template: 'vertical',
      bias: bias ?? 'neutral',
      invalidIf: '1-minute close re-enters the prior 15-bar range',
      reason: 'If a direction appears, switch to a vertical instead of holding a long straddle.',
    },
  ].slice(0, 2) as OptionIntradayCandidate[]
}

function logReturnStdev(closes: readonly number[]): number | undefined {
  if (closes.length < 2) return undefined
  const returns: number[] = []
  for (let index = 1; index < closes.length; index += 1) {
    const prev = closes[index - 1]
    const next = closes[index]
    if (prev === undefined || next === undefined || prev <= 0 || next <= 0) continue
    returns.push(Math.log(next / prev))
  }
  if (returns.length < 2) return undefined
  const mean = returns.reduce((sum, item) => sum + item, 0) / returns.length
  const variance = returns.reduce((sum, item) => sum + (item - mean) ** 2, 0) / returns.length
  const sigma = Math.sqrt(variance)
  return Number.isFinite(sigma) ? sigma : undefined
}

function wilderAtr(klines: readonly Kline[], period: number): number | undefined {
  if (klines.length < period + 1) return undefined
  const tr: number[] = []
  for (let index = 1; index < klines.length; index += 1) {
    const bar = klines[index]
    const prev = klines[index - 1]
    if (bar === undefined || prev === undefined) continue
    tr.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prev.close),
      Math.abs(bar.low - prev.close),
    ))
  }
  if (tr.length < period) return undefined
  let atr = tr.slice(0, period).reduce((sum, item) => sum + item, 0) / period
  for (let index = period; index < tr.length; index += 1) {
    const next = tr[index]
    if (next === undefined) continue
    atr = (atr * (period - 1) + next) / period
  }
  return Number.isFinite(atr) ? atr : undefined
}

function typicalVwap(klines: readonly Kline[]): number | undefined {
  let pv = 0
  let vol = 0
  for (const bar of klines) {
    if (bar.volume <= 0) continue
    pv += ((bar.high + bar.low + bar.close) / 3) * bar.volume
    vol += bar.volume
  }
  if (vol <= 0) return undefined
  const value = pv / vol
  return Number.isFinite(value) ? value : undefined
}

function donchianChannel(
  klines: readonly Kline[],
  period: number,
): { high: number; low: number } | undefined {
  const window = klines.slice(-period)
  if (window.length === 0) return undefined
  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  for (const bar of window) {
    if (bar.high > high) high = bar.high
    if (bar.low < low) low = bar.low
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high < low) return undefined
  return { high, low }
}

function volumeRatioOf(
  klines: readonly Kline[],
  shortBars: number,
  longBars: number,
): number | undefined {
  const recent = klines.slice(-shortBars)
  const basis = klines.slice(-longBars)
  if (recent.length < shortBars || basis.length < longBars) return undefined
  const short = mean(recent.map((bar) => bar.volume))
  const long = mean(basis.map((bar) => bar.volume))
  if (short === undefined || long === undefined || long <= 0) return undefined
  return short / long
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, item) => sum + item, 0) / values.length
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}
