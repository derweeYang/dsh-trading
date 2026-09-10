import {
  OPTION_MULTIPLIER,
  OPTION_PAPER_INITIAL_CASH,
  type OptionBarRecommendation,
  type OptionChain,
  type OptionIntradayBoxRow,
  type OptionQuoteRow,
  type PaperAccount,
  type PaperFill,
  type PaperPosition,
} from '@dshtrading/api'

export { OPTION_MULTIPLIER, OPTION_PAPER_INITIAL_CASH }

export interface PaperState {
  account: PaperAccount
  positions: PaperPosition[]
  fills: PaperFill[]
}

type PaperLegs = PaperFill['legs']
type SkipReason = NonNullable<PaperFill['skip']>

export function emptyPaperAccount(nowIso: string): PaperAccount {
  return {
    currency: 'CNY',
    initialCash: OPTION_PAPER_INITIAL_CASH,
    cash: OPTION_PAPER_INITIAL_CASH,
    realizedPnl: 0,
    updatedAt: nowIso,
  }
}

export function quoteFillPrice(
  row: OptionQuoteRow & { bid?: number; ask?: number },
  side: 'buy' | 'sell',
): number | undefined {
  const prices = [
    row.last,
    row.prevSettle,
    side === 'buy' ? row.ask : row.bid,
  ]
  return prices.find((price): price is number => (
    typeof price === 'number' && Number.isFinite(price) && price >= 0
  ))
}

function nearestIndex(rows: readonly OptionQuoteRow[], spot: number | undefined): number {
  if (spot === undefined) return Math.floor((rows.length - 1) / 2)
  let best = 0
  for (let index = 1; index < rows.length; index += 1) {
    if (Math.abs(rows[index]!.strike - spot) < Math.abs(rows[best]!.strike - spot)) {
      best = index
    }
  }
  return best
}

export function completeVerticalLegs(
  chain: OptionChain,
  bias: 'up' | 'down' | 'neutral',
  qty: number,
): { legs: PaperLegs; skip?: 'no_quote' } {
  if (bias === 'neutral') return { legs: [], skip: 'no_quote' }

  const rows = [...(bias === 'down' ? chain.calls : chain.puts)]
    .sort((left, right) => left.strike - right.strike)
  if (rows.length < 2) return { legs: [], skip: 'no_quote' }

  const nearest = nearestIndex(rows, chain.spot)
  const shortIndex = bias === 'down'
    ? (chain.spot === undefined
        ? nearest
        : rows.findIndex((row) => row.strike >= chain.spot!))
    : (chain.spot === undefined
        ? nearest
        : rows.findLastIndex((row) => row.strike <= chain.spot!))
  const longIndex = bias === 'down' ? shortIndex + 1 : shortIndex - 1
  const short = rows[shortIndex]
  const long = rows[longIndex]
  if (!short?.code || !long?.code) return { legs: [], skip: 'no_quote' }

  const shortPrice = quoteFillPrice(short, 'sell')
  const longPrice = quoteFillPrice(long, 'buy')
  if (shortPrice === undefined || longPrice === undefined) {
    return { legs: [], skip: 'no_quote' }
  }

  return {
    legs: [
      { code: short.code, side: 'sell', qty, fillPrice: shortPrice },
      { code: long.code, side: 'buy', qty, fillPrice: longPrice },
    ],
  }
}

export function premiumCny(legs: PaperLegs): number {
  return legs.reduce((total, leg) => (
    total + (leg.side === 'sell' ? 1 : -1) * leg.fillPrice * leg.qty * OPTION_MULTIPLIER
  ), 0)
}

export function sizeQty(
  maxContracts: number | undefined,
  cash: number,
  premiumPer: number,
  marginPer: number,
): number {
  let qty = Math.max(1, Math.floor(maxContracts ?? 1))
  const capitalPer = Math.abs(premiumPer) + Math.max(0, marginPer)
  while (qty > 0 && cash - capitalPer * qty < 0) qty -= 1
  return qty
}

export function hasSuccessfulOpen(
  fills: readonly PaperFill[],
  bucketStart: string,
): boolean {
  return fills.some((fill) => (
    fill.bucketStart === bucketStart
    && fill.offset === 'open'
    && fill.reason !== 'skipped'
    && fill.qty > 0
  ))
}

export function applyOpen(
  state: PaperState,
  fill: Omit<PaperFill, 'cashAfter' | 'id'> & { id?: string },
): PaperState {
  const cash = state.account.cash + fill.premiumCny - fill.marginCny
  const id = fill.id ?? `${fill.underlying ?? 'unknown'}:${fill.bucketStart}`
  const recorded: PaperFill = { ...fill, id, cashAfter: cash }
  const position: PaperPosition | undefined = (
    fill.reason !== 'skipped'
    && fill.qty > 0
    && fill.underlying !== undefined
    && fill.template !== undefined
  ) ? {
      id: `${fill.underlying}:${fill.bucketStart}`,
      underlying: fill.underlying,
      template: fill.template,
      openedBucketStart: fill.bucketStart,
      invalidIf: '',
      qty: fill.qty,
      marginCny: fill.marginCny,
      legs: fill.legs,
    } : undefined

  return {
    account: { ...state.account, cash, updatedAt: fill.asOf },
    positions: position === undefined ? [...state.positions] : [...state.positions, position],
    fills: [...state.fills, recorded],
  }
}

export function applyClose(
  state: PaperState,
  positionId: string,
  legs: PaperLegs,
  reason: 'invalidIf' | 'close5' | 'session',
  asOf: string,
): PaperState {
  const position = state.positions.find((item) => item.id === positionId)
  if (position === undefined) return state

  const closePremium = premiumCny(legs)
  const openPremium = premiumCny(position.legs)
  const cash = state.account.cash + closePremium + position.marginCny
  const fill: PaperFill = {
    id: `${positionId}:close:${asOf}`,
    bucketStart: position.openedBucketStart,
    asOf,
    underlying: position.underlying,
    template: position.template,
    offset: 'close',
    qty: position.qty,
    legs,
    premiumCny: closePremium,
    marginCny: 0,
    cashAfter: cash,
    reason,
  }

  return {
    account: {
      ...state.account,
      cash,
      realizedPnl: state.account.realizedPnl + openPremium + closePremium,
      updatedAt: asOf,
    },
    positions: state.positions.filter((item) => item.id !== positionId),
    fills: [...state.fills, fill],
  }
}

export function invalidIfTriggered(input: {
  invalidIf: string
  lastClose: number
  boxLow?: number
  boxHigh?: number
  volumeRatio?: number
}): boolean {
  if (input.boxLow === undefined || input.boxHigh === undefined) return false
  if (!/(donchian|box)/i.test(input.invalidIf)) return false

  const needsVolumeSurge = /volumeRatio\s*>=\s*1\.5|BOX_VOLUME_SURGE/i.test(input.invalidIf)
  if (needsVolumeSurge && (input.volumeRatio === undefined || input.volumeRatio < 1.5)) {
    return false
  }
  return input.lastClose < input.boxLow || input.lastClose > input.boxHigh
}

function skipFill(
  rec: OptionBarRecommendation,
  nowIso: string,
  cash: number,
  skip: SkipReason,
  underlying?: string,
  template?: string,
): PaperFill {
  return {
    id: `${rec.bucketStart}:skip:${skip}`,
    bucketStart: rec.bucketStart,
    asOf: nowIso,
    ...(underlying === undefined ? {} : { underlying }),
    ...(template === undefined ? {} : { template }),
    offset: 'open',
    qty: 0,
    legs: [],
    premiumCny: 0,
    marginCny: 0,
    cashAfter: cash,
    reason: 'skipped',
    skip,
  }
}

function explicitLegs(legs: readonly unknown[] | undefined): PaperLegs | undefined {
  if (legs === undefined || legs.length === 0) return undefined
  const parsed = legs.map((item) => {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as {
      code?: unknown
      side?: unknown
      last?: unknown
      fillPrice?: unknown
      premium?: unknown
    }
    const price = [row.last, row.fillPrice, row.premium]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (
      typeof row.code !== 'string'
      || (row.side !== 'buy' && row.side !== 'sell')
      || price === undefined
    ) return undefined
    return { code: row.code, side: row.side, qty: 1, fillPrice: price }
  })
  return parsed.every((leg) => leg !== undefined) ? parsed as PaperLegs : undefined
}

export function decidePaperOpen(input: {
  rec: OptionBarRecommendation
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  fillsToday: readonly PaperFill[]
  chainFor: (underlying: string) => OptionChain | undefined
  marginFor: (legs: PaperLegs) => number
  nowIso: string
  cash: number
}): { fill: Omit<PaperFill, 'cashAfter'> } | { skip: PaperFill } | { noop: true } {
  const { rec } = input
  if (rec.skipReason !== undefined || rec.noTrade) return { noop: true }
  if (hasSuccessfulOpen(input.fillsToday, rec.bucketStart)) {
    return { skip: skipFill(rec, input.nowIso, input.cash, 'duplicate_bucket') }
  }

  let lastFailure: {
    reason: SkipReason
    underlying?: string
    template?: string
  } = { reason: 'bad_template' }

  for (const pick of rec.picks) {
    if (!pick.underlying || !pick.template) {
      lastFailure = { reason: 'bad_template' }
      continue
    }
    const forecast = input.forecastByUnderlying[pick.underlying]
    if (forecast === undefined) {
      lastFailure = {
        reason: 'no_forecast',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }
    const candidate = forecast.candidates.find((item) => item.template === pick.template)
    if (candidate === undefined) {
      lastFailure = {
        reason: 'bad_template',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }

    let unitLegs = explicitLegs(pick.legs)
    if (unitLegs === undefined) {
      const chain = input.chainFor(pick.underlying)
      if (chain === undefined) {
        lastFailure = {
          reason: 'no_quote',
          underlying: pick.underlying,
          template: pick.template,
        }
        continue
      }
      const completed = completeVerticalLegs(chain, candidate.bias, 1)
      if (completed.skip !== undefined) {
        lastFailure = {
          reason: completed.skip,
          underlying: pick.underlying,
          template: pick.template,
        }
        continue
      }
      unitLegs = completed.legs
    }

    const premiumPer = premiumCny(unitLegs)
    const marginPer = input.marginFor(unitLegs)
    const qty = sizeQty(pick.maxContracts, input.cash, premiumPer, marginPer)
    if (qty === 0) {
      lastFailure = {
        reason: 'no_cash',
        underlying: pick.underlying,
        template: pick.template,
      }
      continue
    }

    const legs = unitLegs.map((leg) => ({ ...leg, qty }))
    return {
      fill: {
        id: `${pick.underlying}:${rec.bucketStart}:open`,
        bucketStart: rec.bucketStart,
        asOf: input.nowIso,
        underlying: pick.underlying,
        template: pick.template,
        offset: 'open',
        qty,
        legs,
        premiumCny: premiumPer * qty,
        marginCny: marginPer * qty,
        reason: 'signal',
      },
    }
  }

  return {
    skip: skipFill(
      rec,
      input.nowIso,
      input.cash,
      lastFailure.reason,
      lastFailure.underlying,
      lastFailure.template,
    ),
  }
}
