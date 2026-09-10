/**
 * CN ETF 期权 Agent 工具（只读）。服务来自 tradingCnOptions，不经过 CN 行情 provider。
 * 例外：cn_get_option_intraday_box 读 CN 现货 1 分钟 K（iquant）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CnOptionsService, MarketDataService, OptionChain, OptionSource, PaperFill } from '@dshtrading/api'
import { BOX_HORIZON_MIN, collectIntradayBox } from './intraday-box.js'
import { tryPaperOpen } from './option-paper.js'
import {
  appendJsonlLine,
  loadPacketForBucket,
  normalizeRecommendation,
  optionsDataRoot,
  packetByUnderlyingOf,
  recommendationsPath,
  shanghaiCalendarDate,
} from './option-bar-ledger.js'

export interface OptionToolOptions {
  service?: CnOptionsService
  getService?: () => CnOptionsService | undefined
  marketData?: MarketDataService
  getMarketData?: () => MarketDataService | undefined
  now?: () => number
  dataRoot?: () => string
  getChain?: (underlying: string) => Promise<OptionChain | undefined>
  getMargin?: (legs: PaperFill['legs']) => Promise<number | undefined>
}

function resolveService(options: OptionToolOptions): CnOptionsService {
  const service = options.service ?? options.getService?.()
  if (service === undefined) {
    throw new Error('cn options tools: tradingCnOptions is not mounted (install @dshtrading/connector-options)')
  }
  return service
}

function resolveMarket(options: OptionToolOptions): MarketDataService | undefined {
  return options.marketData ?? options.getMarketData?.()
}

function asSource(value: unknown): OptionSource | undefined {
  return value === 'synth' || value === 'akshare' || value === 'iquant' ? value : undefined
}

/** exactOptionalPropertyTypes：可选字段缺席时整键省略，不得显式传 undefined。 */
function optionalField<K extends string, T>(
  key: K,
  value: T | undefined,
): { [P in K]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as { [P in K]: T }
}

export function createGetOptionExpiriesTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_expiries',
    description:
      'List the standard China ETF option expiry months for an underlying (front, next, +3, +6). '
      + 'Expiry date is the fourth Wednesday of that month. Does not require the options gateway. '
      + 'Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        required: true,
        description: 'ETF underlying or option long code, e.g. 510050.SH',
      },
      source: {
        type: 'string',
        description: 'akshare (default), iquant, or synth',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { underlying?: unknown; source?: unknown }
      const calendar = await resolveService(options).getOptionExpiries({
        underlying: typeof args.underlying === 'string' ? args.underlying : '',
        ...optionalField('source', asSource(args.source)),
      })
      return JSON.stringify(calendar)
    },
  })
}

export function createGetOptionChainTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_chain',
    description:
      'Get a China SSE/SZSE ETF options T-quote chain for one underlying and expiry month (e.g. 510050 + 2609). '
      + 'Accepts market-canonical spot (510050.SH) or option long code (510050C2609M02850). '
      + 'source=akshare is research-grade SSE quotes; SZSE underlyings return NO_DATA (statics only). '
      + 'source=synth is a deterministic offline fixture. Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        required: true,
        description: 'ETF underlying or option long code, e.g. 510050.SH or 510050C2609M02850',
      },
      expiryMonth: {
        type: 'string',
        required: true,
        description: 'Expiry month YYMM, e.g. 2609',
      },
      source: {
        type: 'string',
        description: 'akshare (default), iquant, or synth',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { underlying?: unknown; expiryMonth?: unknown; source?: unknown }
      const underlying = typeof args.underlying === 'string' ? args.underlying : ''
      const expiryMonth = typeof args.expiryMonth === 'string' ? args.expiryMonth : ''
      const chain = await resolveService(options).getOptionChain({
        underlying,
        expiryMonth,
        ...optionalField('source', asSource(args.source)),
      })
      return JSON.stringify(chain)
    },
  })
}

export function createGetOptionIvTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_iv',
    description:
      'Invert Black-Scholes implied volatility for each row of a China ETF option chain. '
      + 'rate is required (continuous). Failed rows are kept with a failReason (below-intrinsic / unconverged). '
      + 'Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        required: true,
        description: 'ETF underlying or option long code, e.g. 510050.SH',
      },
      expiryMonth: {
        type: 'string',
        required: true,
        description: 'Expiry month YYMM, e.g. 2609',
      },
      rate: {
        type: 'number',
        required: true,
        description: 'Continuous risk-free rate, e.g. 0.015',
      },
      source: {
        type: 'string',
        description: 'akshare (default), iquant, or synth',
      },
      priceField: {
        type: 'string',
        description: 'last (default) or prevSettle',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        underlying?: unknown
        expiryMonth?: unknown
        rate?: unknown
        source?: unknown
        priceField?: unknown
      }
      const priceField = args.priceField === 'prevSettle' ? 'prevSettle' as const : 'last' as const
      const result = await resolveService(options).getImpliedVol({
        underlying: typeof args.underlying === 'string' ? args.underlying : '',
        expiryMonth: typeof args.expiryMonth === 'string' ? args.expiryMonth : '',
        rate: typeof args.rate === 'number' ? args.rate : Number.NaN,
        ...optionalField('source', asSource(args.source)),
        priceField,
      })
      return JSON.stringify(result)
    },
  })
}

export function createGetOptionStrategyTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_strategy',
    description:
      'Build a China ETF options multi-leg book from a template (covered_call / collar / vertical / straddle / butterfly) '
      + 'and report expiry P/L, net Greeks, and SSE/SZSE standard obligation margin (12%/7%, covered short call cash 0). '
      + 'Margin is a per-leg sum, not exchange combo margin. Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        required: true,
        description: 'ETF underlying, e.g. 510050.SH',
      },
      expiryMonth: {
        type: 'string',
        description: 'Expiry month YYMM when the template needs a month',
      },
      template: {
        type: 'string',
        description: 'covered_call | collar | vertical | straddle | butterfly',
      },
      source: {
        type: 'string',
        description: 'akshare (default), iquant, or synth',
      },
      rate: {
        type: 'number',
        description: 'Continuous risk-free rate',
      },
      holdingQty: {
        type: 'number',
        description: 'Real ETF share holding for covered_call/collar templates: prefills the stock leg (qty = floor(holdingQty/multiplier) contracts, both legs auto-matched)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        underlying?: unknown
        expiryMonth?: unknown
        template?: unknown
        source?: unknown
        rate?: unknown
        holdingQty?: unknown
      }
      const template = typeof args.template === 'string' ? args.template : undefined
      const allowed = ['covered_call', 'collar', 'vertical', 'straddle', 'butterfly'] as const
      const typed = allowed.find((item) => item === template)
      const expiryMonth = typeof args.expiryMonth === 'string' ? args.expiryMonth : undefined
      const rate = typeof args.rate === 'number' ? args.rate : undefined
      const result = await resolveService(options).getStrategy({
        underlying: typeof args.underlying === 'string' ? args.underlying : '',
        ...optionalField('expiryMonth', expiryMonth),
        ...optionalField('template', typed),
        ...optionalField('source', asSource(args.source)),
        ...optionalField('rate', rate),
        ...optionalField('holdingQty', typeof args.holdingQty === 'number' ? args.holdingQty : undefined),
      })
      return JSON.stringify(result)
    },
  })
}

/* -- 阶段 3 内核上桥（python vol_analytics / fetch_underlying_daily / price /
 *    parity_check 四命令，报告 JSON 透传不解释）------------------------------- */

export function createGetOptionVolAnalyticsTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_vol_analytics',
    description:
      'Multi-month IV surface analytics for a China ETF option underlying: term structure, skew, realized vol (HV), '
      + 'IV percentile, smile, Raw SVI fit, and butterflies, plus underlying daily stats. '
      + 'akshare serves SSE; SZSE needs source=iquant (live option books are SHO/SZO, not SH/SZ); '
      + 'synth is deterministic offline. Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        required: true,
        description: 'ETF underlying or option long code, e.g. 510050.SH',
      },
      expiryMonths: {
        type: 'string',
        description: 'Comma-separated YYMM list, e.g. 2609,2610; default = standard four months',
      },
      asOf: {
        type: 'string',
        description: 'Snapshot date YYYY-MM-DD; default = latest',
      },
      rate: {
        type: 'number',
        description: 'Continuous risk-free rate',
      },
      dividendYield: {
        type: 'number',
        description: 'Continuous dividend yield',
      },
      source: {
        type: 'string',
        description: 'akshare (default), iquant, or synth',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        underlying?: unknown
        expiryMonths?: unknown
        asOf?: unknown
        rate?: unknown
        dividendYield?: unknown
        source?: unknown
      }
      const expiryMonths = typeof args.expiryMonths === 'string'
        ? args.expiryMonths.split(',').map(m => m.trim()).filter(m => m !== '')
        : undefined
      const report = await resolveService(options).getVolAnalytics({
        underlying: typeof args.underlying === 'string' ? args.underlying : '',
        ...(expiryMonths === undefined || expiryMonths.length === 0 ? {} : { expiryMonths }),
        ...optionalField('asOf', typeof args.asOf === 'string' ? args.asOf : undefined),
        ...optionalField('rate', typeof args.rate === 'number' ? args.rate : undefined),
        ...optionalField('dividendYield', typeof args.dividendYield === 'number' ? args.dividendYield : undefined),
        ...optionalField('source', asSource(args.source)),
      })
      return JSON.stringify(report)
    },
  })
}

export function createGetOptionUnderlyingDailyTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_underlying_daily',
    description:
      'Fetch underlying ETF spot daily bars for option analysis (parquet cache-first on the kernel side). '
      + 'source=akshare or iquant only; omit underlying to fetch the whole source registry. Read-only; not investment advice.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'akshare or iquant',
      },
      underlying: {
        type: 'string',
        description: 'ETF code, e.g. 510050; omit or "all" = whole registry',
      },
      start: {
        type: 'string',
        description: 'Start date YYYY-MM-DD',
      },
      end: {
        type: 'string',
        description: 'End date YYYY-MM-DD',
      },
      adjust: {
        type: 'string',
        description: '"" (raw, default) | qfq | hfq (akshare only)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        source?: unknown
        underlying?: unknown
        start?: unknown
        end?: unknown
        adjust?: unknown
      }
      const source = args.source === 'iquant' ? 'iquant' : 'akshare'
      const adjust = args.adjust === 'qfq' ? 'qfq' : args.adjust === 'hfq' ? 'hfq' : ''
      const report = await resolveService(options).getUnderlyingDaily({
        source,
        ...optionalField('underlying', typeof args.underlying === 'string' ? args.underlying : undefined),
        ...optionalField('start', typeof args.start === 'string' ? args.start : undefined),
        ...optionalField('end', typeof args.end === 'string' ? args.end : undefined),
        ...(adjust === '' ? {} : { adjust: adjust as 'qfq' | 'hfq' }),
      })
      return JSON.stringify(report)
    },
  })
}

export function createGetOptionPriceTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_price',
    description:
      'Price a single European option leg with Black-Scholes and full Greeks (delta/gamma/vega/theta/rho with '
      + 'per-vol-point / per-day / per-bp variants). Pure computation, no market data needed. Read-only; not investment advice.',
    parameters: {
      spot: {
        type: 'number',
        required: true,
        description: 'Underlying spot price, e.g. 2.912',
      },
      strike: {
        type: 'number',
        required: true,
        description: 'Strike price, e.g. 2.85',
      },
      optionType: {
        type: 'string',
        required: true,
        description: 'C (call) or P (put)',
      },
      vol: {
        type: 'number',
        required: true,
        description: 'Annualized volatility, e.g. 0.18',
      },
      expiryDate: {
        type: 'string',
        description: 'Expiry date YYYY-MM-DD (with asOf; alternative to years)',
      },
      asOf: {
        type: 'string',
        description: 'Valuation date YYYY-MM-DD, default = today',
      },
      years: {
        type: 'number',
        description: 'Time to expiry in calendar years (alternative to expiryDate+asOf)',
      },
      rate: {
        type: 'number',
        description: 'Continuous risk-free rate, default 0',
      },
      dividendYield: {
        type: 'number',
        description: 'Continuous dividend yield, default 0',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        spot?: unknown
        strike?: unknown
        optionType?: unknown
        vol?: unknown
        expiryDate?: unknown
        asOf?: unknown
        years?: unknown
        rate?: unknown
        dividendYield?: unknown
      }
      const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)
      const report = await resolveService(options).getPrice({
        spot: num(args.spot),
        strike: num(args.strike),
        vol: num(args.vol),
        optionType: args.optionType === 'P' ? 'P' : 'C',
        ...optionalField('expiryDate', typeof args.expiryDate === 'string' ? args.expiryDate : undefined),
        ...optionalField('asOf', typeof args.asOf === 'string' ? args.asOf : undefined),
        ...optionalField('years', typeof args.years === 'number' ? args.years : undefined),
        ...optionalField('rate', typeof args.rate === 'number' ? args.rate : undefined),
        ...optionalField('dividendYield', typeof args.dividendYield === 'number' ? args.dividendYield : undefined),
      })
      return JSON.stringify(report)
    },
  })
}

export function createOptionParityCheckTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_option_parity_check',
    description:
      'Put-call parity check for a China ETF option chain: pair C/P at equal strike, report deviation '
      + 'from (C - P) - (S·e^{-qT} - K·e^{-rT}) with tick-scaled flags. Default threshold = max(2×tickSize, 0.0005). '
      + 'Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        required: true,
        description: 'ETF underlying or option long code, e.g. 510050.SH',
      },
      expiryMonth: {
        type: 'string',
        required: true,
        description: 'Expiry month YYMM, e.g. 2609',
      },
      rate: {
        type: 'number',
        description: 'Continuous risk-free rate',
      },
      threshold: {
        type: 'number',
        description: 'Deviation threshold in yuan; default = max(2×tickSize, 0.0005)',
      },
      source: {
        type: 'string',
        description: 'akshare (default), iquant, or synth',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        underlying?: unknown
        expiryMonth?: unknown
        rate?: unknown
        threshold?: unknown
        source?: unknown
      }
      const report = await resolveService(options).getParityCheck({
        underlying: typeof args.underlying === 'string' ? args.underlying : '',
        expiryMonth: typeof args.expiryMonth === 'string' ? args.expiryMonth : '',
        ...optionalField('rate', typeof args.rate === 'number' ? args.rate : undefined),
        ...optionalField('threshold', typeof args.threshold === 'number' ? args.threshold : undefined),
        ...optionalField('source', asSource(args.source)),
      })
      return JSON.stringify(report)
    },
  })
}

export function createGetOptionIntradayBoxTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_get_option_intraday_box',
    description:
      'Compute a deterministic 1-minute → 5-minute price box for China ETF option underlyings '
      + '(sigma/ATR half-width, Donchian, VWAP, session gate, at most two strategy templates). '
      + 'Omit underlying or pass "all" for the full non-SYNTH roster. Uses CN spot 1m klines (iquant). '
      + 'Do not invent box levels — read this JSON. Read-only; not investment advice.',
    parameters: {
      underlying: {
        type: 'string',
        description: 'ETF code (510050 / 510050.SH) or "all"; omit = whole roster',
      },
      asOf: {
        type: 'string',
        description: 'Valuation instant ISO-8601; default = now (Asia/Shanghai session gate)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { underlying?: unknown; asOf?: unknown }
      const underlying = typeof args.underlying === 'string' ? args.underlying : undefined
      const nowMs = parseAsOf(args.asOf) ?? options.now?.() ?? Date.now()
      const roster = await resolveService(options).listUnderlyings()
      const box = await collectIntradayBox({
        roster,
        nowMs,
        ...optionalField('underlying', underlying),
        ...optionalField('market', resolveMarket(options)),
      })
      if (
        underlying !== undefined
        && underlying.trim().toLowerCase() !== 'all'
        && box.rows.length === 0
      ) {
        throw new Error(`cn_get_option_intraday_box: unknown underlying ${underlying}`)
      }
      return JSON.stringify({
        ...box,
        horizonMin: BOX_HORIZON_MIN,
        note: 'Deterministic box JSON. Do not recompute levels. Not investment advice.',
      })
    },
  })
}

export function createPutOptionBarRecommendationTool(options: OptionToolOptions = {}) {
  return defineTool({
    name: 'cn_put_option_bar_recommendation',
    description:
      'Persist one 5-minute-bar option recommendation JSON for the current Shanghai calendar day. '
      +       'Call this before the six-section reply. Templates must be in that bucket\'s forecast.candidates. '
      + 'IV/volume gates use the host ContextPacket for this bucketStart (do not relabel ivRegime). '
      + 'Does not place orders. Not investment advice.',
    parameters: {
      recommendation: {
        type: 'string',
        description: 'JSON object: bucketStart, asOf, session, opportunity, edge, logic, playbook, invalidIf, picks, noTrade',
      },
      forecasts: {
        type: 'string',
        description: 'JSON map underlying -> box row (must include candidates). Required when picks is non-empty.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { recommendation?: unknown; forecasts?: unknown }
      const parsed = typeof args.recommendation === 'string'
        ? JSON.parse(args.recommendation) as unknown
        : args.recommendation
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('cn_put_option_bar_recommendation: recommendation must be a JSON object')
      }
      let forecastByUnderlying: Record<string, import('@dshtrading/api').OptionIntradayBoxRow | undefined> = {}
      if (typeof args.forecasts === 'string' && args.forecasts.trim() !== '') {
        const mapped = JSON.parse(args.forecasts) as Record<string, import('@dshtrading/api').OptionIntradayBoxRow>
        forecastByUnderlying = mapped
      }
      const nowMs = options.now?.() ?? Date.now()
      const date = shanghaiCalendarDate(nowMs)
      const root = options.dataRoot?.() ?? optionsDataRoot()
      const bucketStart = typeof (parsed as { bucketStart?: unknown }).bucketStart === 'string'
        ? (parsed as { bucketStart: string }).bucketStart
        : ''
      const packet = bucketStart === '' ? undefined : await loadPacketForBucket(root, date, bucketStart)
      const packetMap = packetByUnderlyingOf(packet)
      const heldFromPacket = packet === undefined
        ? undefined
        : Object.fromEntries(packet.rows.map((item) => [item.underlying, item.heldQty]))
      const row = normalizeRecommendation(
        parsed,
        forecastByUnderlying,
        heldFromPacket,
        packetMap,
      )
      await appendJsonlLine(recommendationsPath(root, date), row)
      void tryPaperOpen({
        root,
        date,
        rec: row,
        forecastByUnderlying,
        nowIso: new Date(nowMs).toISOString(),
        getChain: async (underlying) => {
          try {
            return await options.getChain?.(underlying)
          } catch {
            return undefined
          }
        },
        getMargin: async (legs) => {
          try {
            return await options.getMargin?.(legs)
          } catch {
            return undefined
          }
        },
      }).catch(() => {})
      return JSON.stringify({ ok: true, bucketStart: row.bucketStart, opportunity: row.opportunity })
    },
  })
}

function parseAsOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}
