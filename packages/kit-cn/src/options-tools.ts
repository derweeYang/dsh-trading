/**
 * CN ETF 期权 Agent 工具（只读）。服务来自 tradingCnOptions，不经过 CN 行情 provider。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CnOptionsService, OptionSource } from '@dshtrading/api'

export interface OptionToolOptions {
  service?: CnOptionsService
  getService?: () => CnOptionsService | undefined
}

function resolveService(options: OptionToolOptions): CnOptionsService {
  const service = options.service ?? options.getService?.()
  if (service === undefined) {
    throw new Error('cn options tools: tradingCnOptions is not mounted (install @dshtrading/connector-options)')
  }
  return service
}

function asSource(value: unknown): OptionSource | undefined {
  return value === 'synth' || value === 'akshare' ? value : undefined
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
        description: 'akshare (default) or synth',
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
        description: 'akshare (default) or synth',
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
        description: 'akshare (default) or synth',
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
        description: 'akshare (default) or synth',
      },
      rate: {
        type: 'number',
        description: 'Continuous risk-free rate',
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
      })
      return JSON.stringify(result)
    },
  })
}
