/**
 * 套利纸面引擎单测：taker 定价、开仓决策（现货腿份数记账）、平仓四分支、
 * 现货腿端到端盈亏、周期编排（开仓 → 收敛平仓）。全部注入假件，不触网。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptionChain, OptionQuoteRow, PaperLegFill, PaperPosition } from '@dshtrading/api'
import {
  applyClose,
  applyOpen,
  emptyPaperAccount,
  fillFeeCny,
  legCashCny,
  loadPaperState,
  premiumCny,
} from '../src/option-paper.js'
import {
  arbPositionKey,
  buildArbCloseLegs,
  decideArbClose,
  decideArbOpen,
  decideIntrinsicOpen,
  intrinsicTemplateOf,
  rightOfIntrinsicTemplate,
  OPTION_ARB_MAX_INTRINSIC_POSITIONS,
  takerFillPrice,
  tryArbPaperCycle,
} from '../src/option-arb-paper.js'
import { paperFillsPath } from '../src/option-bar-ledger.js'

const NOW_MS = Date.parse('2026-09-13T03:00:00.000Z')
const NOW_ISO = '2026-09-13T03:00:00.000Z'

function row(code: string, strike: number, over: Partial<OptionQuoteRow> = {}): OptionQuoteRow {
  return { code, strike, ...over }
}

/** executable 平价机会链：K=2.85 唯一行权价（杜绝 box 组合），spot=2.9，
 * C/P 挂真实盘口使 buy_synthetic_sell_spot 可执行边 ≈ 0.02 元/股。
 * spot: null 构造"链不带 spot"形态（iquant /v1/chain 真实响应无该键）。 */
function parityChain(over: { calls?: OptionQuoteRow[]; puts?: OptionQuoteRow[]; spot?: number | null } = {}): OptionChain {
  return {
    underlying: '510050',
    expiryMonth: '2609',
    expiryDate: '2026-09-23',
    snapshotAt: '2026-09-13T02:59:50.000Z',
    source: 'iquant',
    ...(over.spot === null ? {} : { spot: over.spot ?? 2.9 }),
    calls: over.calls ?? [row('510050C2609M02850', 2.85, { last: 0.049, bid: 0.048, ask: 0.05 })],
    puts: over.puts ?? [row('510050P2609M02850', 2.85, { last: 0.0194, bid: 0.0184, ask: 0.0204 })],
  }
}

function parityOpportunity(over: Partial<Parameters<typeof decideArbOpen>[0]['opportunity']> = {}) {
  return {
    kind: 'parity',
    underlying: '510050',
    expiryMonth: '2609',
    strike: 2.85,
    edgePerShare: 0.01996,
    edgePerContract: 199.6,
    direction: 'buy_synthetic_sell_spot',
    legs: [
      { code: '510050C2609M02850', right: 'C', action: 'buy', strike: 2.85 },
      { code: '510050P2609M02850', right: 'P', action: 'sell', strike: 2.85 },
    ],
    note: 'test',
    executable: true,
    ...over,
  } as const
}

/**
 * 深实值贴水链：仅一只深实值 C K=2.65 挂真实盘口（无同 strike P → 无 parity/box 干扰）。
 * bound ≈ 2.9 − 2.65×e^{-0.02T} ≈ 0.2514，ask 0.24 → 贴水 ≈ 0.0114 元/股。
 */
function intrinsicChain(over: { calls?: OptionQuoteRow[]; spot?: number | null } = {}): OptionChain {
  return {
    underlying: '510050',
    expiryMonth: '2609',
    expiryDate: '2026-09-23',
    snapshotAt: '2026-09-13T02:59:50.000Z',
    source: 'iquant',
    ...(over.spot === null ? {} : { spot: over.spot ?? 2.9 }),
    calls: over.calls ?? [row('510050C2609M02650', 2.65, { last: 0.238, bid: 0.236, ask: 0.24 })],
    puts: [],
  }
}

/** 扫描层贴水机会对象（decideIntrinsicOpen 输入；数字与 intrinsicChain 对齐）。 */
function intrinsicDiscount(over: Partial<Parameters<typeof decideIntrinsicOpen>[0]['discount']> = {}) {
  return {
    underlying: '510050',
    expiryMonth: '2609',
    strike: 2.65,
    right: 'C' as const,
    boundPerShare: 0.2514,
    askPerShare: 0.24,
    discountPerShare: 0.0114,
    netPerContract: 114,
    leg: { code: '510050C2609M02650', right: 'C' as const, action: 'buy' as const, strike: 2.65 },
    note: 'test',
    ...over,
  }
}

describe('takerFillPrice', () => {
  it('strict 吃对手价；坏盘口/无盘口 → undefined', () => {
    expect(takerFillPrice(row('C', 1, { bid: 0.048, ask: 0.05 }), 'buy', 'strict'))
      .toEqual({ price: 0.05, source: 'ask' })
    expect(takerFillPrice(row('C', 1, { bid: 0.048, ask: 0.05 }), 'sell', 'strict'))
      .toEqual({ price: 0.048, source: 'bid' })
    expect(takerFillPrice(row('C', 1, { last: 0.049 }), 'buy', 'strict')).toBeUndefined()
    // 成交侧盘口有效即可成交（对侧坏盘不阻断吃单；双侧健全由 scan 的 executable 闸把守）。
    expect(takerFillPrice(row('C', 1, { bid: 0, ask: 0.05 }), 'buy', 'strict'))
      .toEqual({ price: 0.05, source: 'ask' })
    expect(takerFillPrice(row('C', 1, { bid: -0.01, ask: 0.05 }), 'sell', 'strict')).toBeUndefined()
  })

  it('fallback 回退 last → prevSettle；全缺 → undefined', () => {
    expect(takerFillPrice(row('C', 1, { last: 0.049 }), 'buy', 'fallback'))
      .toEqual({ price: 0.049, source: 'last' })
    expect(takerFillPrice(row('C', 1, { prevSettle: 0.047 }), 'sell', 'fallback'))
      .toEqual({ price: 0.047, source: 'prev_settle' })
    expect(takerFillPrice(row('C', 1), 'buy', 'fallback')).toBeUndefined()
    // 0/负 last 不算有效价，继续回退。
    expect(takerFillPrice(row('C', 1, { last: 0, prevSettle: 0.047 }), 'buy', 'fallback'))
      .toEqual({ price: 0.047, source: 'prev_settle' })
  })
})

describe('arbPositionKey', () => {
  it('strikes 升序归一（方向无关）；strike ×1000 编码', () => {
    expect(arbPositionKey({ kind: 'parity', underlying: '510050', expiryMonth: '2609', strikes: [2.85] }))
      .toBe('arb:parity:510050:2609:2850')
    expect(arbPositionKey({ kind: 'box', underlying: '510050', expiryMonth: '2609', strikes: [2.9, 2.85] }))
      .toBe(arbPositionKey({ kind: 'box', underlying: '510050', expiryMonth: '2609', strikes: [2.85, 2.9] }))
    expect(arbPositionKey({ kind: 'box', underlying: '510050', expiryMonth: '2609', strikes: [2.85, 2.9] }))
      .toBe('arb:box:510050:2609:2850-2900')
  })
})

describe('混合腿记账（spot 不乘 multiplier）', () => {
  const legs: PaperLegFill[] = [
    { code: '510050C2609M02850', side: 'buy', qty: 2, fillPrice: 0.05 },
    { code: '510050P2609M02850', side: 'sell', qty: 2, fillPrice: 0.0184 },
    { code: '510050', side: 'sell', qty: 20_000, fillPrice: 2.9, asset: 'spot' },
  ]

  it('legCashCny：期权腿 ×10000、现货腿按份', () => {
    expect(legCashCny(legs[0]!)).toBeCloseTo(-0.05 * 2 * 10_000, 10)
    expect(legCashCny(legs[1]!)).toBeCloseTo(0.0184 * 2 * 10_000, 10)
    expect(legCashCny(legs[2]!)).toBeCloseTo(2.9 * 20_000, 10)
  })

  it('premiumCny 混合 = Σ 腿；与手算逐位一致', () => {
    expect(premiumCny(legs)).toBeCloseTo(-1000 + 368 + 58_000, 10)
  })

  it('fillFeeCny：期权按张 + 现货按名义额万1', () => {
    expect(fillFeeCny(legs, 1.7)).toBeCloseTo(1.7 * 4 + 2.9 * 20_000 * 0.0001, 10)
  })
})

describe('decideArbOpen（parity happy path + skip 分支）', () => {
  const base = {
    opportunity: parityOpportunity(),
    chain: parityChain(),
    positionKeys: new Set<string>(),
    cash: 100_000,
    nowMs: NOW_MS,
    spotPrice: 2.9,
    spotSymbol: '510050.SH',
    optionMarginPerContract: 500,
  }

  it('happy path：现金约束下 qty=2，现货腿 10000 份/张，对手价记账', () => {
    const decided = decideArbOpen(base)
    expect(decided.kind).toBe('open')
    if (decided.kind !== 'open') return
    expect(decided.positionId).toBe('arb:parity:510050:2609:2850')
    // premiumPer = (2.9 − 0.05 + 0.0184) × 10000 = 28684；marginPer = 500 + 14500 = 15000
    // capitalPer = 43684 → floor(100000/43684) = 2。
    expect(decided.fill.qty).toBe(2)
    expect(decided.fill.marginCny).toBeCloseTo(15_000 * 2, 10)
    expect(decided.fill.premiumCny).toBeCloseTo(28_684 * 2, 10)
    expect(decided.fill.reason).toBe('arb_open')
    expect(decided.fill.book).toBe('arbitrage')
    expect(decided.fill.expiryDate).toBe('2026-09-23')
    expect(decided.fill.openEdgePerShare).toBeCloseTo(0.01996, 10)
    expect(decided.fill.legs).toEqual([
      { code: '510050C2609M02850', side: 'buy', qty: 2, fillPrice: 0.05, priceSource: 'ask' },
      { code: '510050P2609M02850', side: 'sell', qty: 2, fillPrice: 0.0184, priceSource: 'bid' },
      {
        code: '510050', side: 'sell', qty: 20_000, fillPrice: 2.9, priceSource: 'spot',
        asset: 'spot', spotSymbol: '510050.SH',
      },
    ])
    // 费 = 1.7×4 + 2.9×20000×0.0001 = 6.8 + 5.8。
    expect(decided.fill.feeCny).toBeCloseTo(12.6, 10)
  })

  it('skip 分支：not_executable / stale_snapshot / duplicate / no_quote / no_spot / no_margin / no_cash', () => {
    expect(decideArbOpen({ ...base, opportunity: parityOpportunity({ executable: false }) }))
      .toEqual({ kind: 'skip', reason: 'not_executable' })
    expect(decideArbOpen({
      ...base,
      chain: parityChain({ calls: [row('510050C2609M02850', 2.85, { last: 0.049, bid: 0.048, ask: 0.05 })] }),
      nowMs: NOW_MS + 120_000,
    })).toEqual({ kind: 'skip', reason: 'stale_snapshot' })
    expect(decideArbOpen({
      ...base,
      chain: { ...parityChain(), snapshotAt: undefined },
    })).toEqual({ kind: 'skip', reason: 'stale_snapshot' })
    expect(decideArbOpen({ ...base, positionKeys: new Set(['arb:parity:510050:2609:2850']) }))
      .toEqual({ kind: 'skip', reason: 'duplicate' })
    expect(decideArbOpen({
      ...base,
      opportunity: parityOpportunity({
        legs: [
          { code: '510050C2609M02850', right: 'C', action: 'buy', strike: 2.85 },
          { code: '510050P2609M02900', right: 'P', action: 'sell', strike: 2.9 },
        ],
      }),
    })).toEqual({ kind: 'skip', reason: 'no_quote' })
    expect(decideArbOpen({ ...base, spotPrice: undefined }))
      .toEqual({ kind: 'skip', reason: 'no_spot' })
    expect(decideArbOpen({ ...base, optionMarginPerContract: undefined }))
      .toEqual({ kind: 'skip', reason: 'no_margin' })
    expect(decideArbOpen({ ...base, cash: 10_000 }))
      .toEqual({ kind: 'skip', reason: 'no_cash' })
  })

  it('box：四腿无现货，不加融券保证金', () => {
    const chain: OptionChain = {
      ...parityChain(),
      calls: [
        row('510050C2609M02850', 2.85, { last: 0.049, bid: 0.048, ask: 0.05 }),
        row('510050C2609M02900', 2.9, { last: 0.012, bid: 0.011, ask: 0.013 }),
      ],
      puts: [
        row('510050P2609M02850', 2.85, { last: 0.0194, bid: 0.0184, ask: 0.0204 }),
        row('510050P2609M02900', 2.9, { last: 0.056, bid: 0.055, ask: 0.057 }),
      ],
    }
    const decided = decideArbOpen({
      opportunity: {
        kind: 'box',
        underlying: '510050',
        expiryMonth: '2609',
        lowStrike: 2.85,
        highStrike: 2.9,
        edgePerShare: 0.012,
        edgePerContract: 120,
        direction: 'long_box',
        legs: [
          { code: '510050C2609M02850', right: 'C', action: 'buy', strike: 2.85 },
          { code: '510050C2609M02900', right: 'C', action: 'sell', strike: 2.9 },
          { code: '510050P2609M02900', right: 'P', action: 'buy', strike: 2.9 },
          { code: '510050P2609M02850', right: 'P', action: 'sell', strike: 2.85 },
        ],
        note: 'test',
        executable: true,
      },
      chain,
      positionKeys: new Set<string>(),
      cash: 100_000,
      nowMs: NOW_MS,
      optionMarginPerContract: 800,
    })
    expect(decided.kind).toBe('open')
    if (decided.kind !== 'open') return
    expect(decided.positionId).toBe('arb:box:510050:2609:2850-2900')
    expect(decided.fill.legs).toHaveLength(4)
    expect(decided.fill.legs.every((leg) => leg.asset !== 'spot')).toBe(true)
    // taker 口径：buy 吃 ask / sell 吃 bid → premiumPer = (−0.05 + 0.011 − 0.057 + 0.0184)×10000 = −776/张；
    // capitalPer = 776+800 = 1576 → 现金可负担 63 张，上限 10。
    expect(decided.fill.qty).toBe(10)
    expect(decided.fill.premiumCny).toBeCloseTo(-776 * 10, 8)
    expect(decided.fill.marginCny).toBeCloseTo(800 * 10, 10)
  })
})

describe('decideArbClose（四分支）', () => {
  const position: PaperPosition = {
    id: 'arb:parity:510050:2609:2850',
    underlying: '510050',
    template: 'parity',
    openedBucketStart: NOW_ISO,
    invalidIf: '',
    qty: 1,
    marginCny: 15_000,
    legs: [],
    expiryDate: '2026-09-23',
    openEdgePerShare: 0.02,
  }

  it('到期强平 > 反转 > 收敛 > hold', () => {
    expect(decideArbClose({ position, todayDate: '2026-09-23' })).toBe('arb_expiry')
    expect(decideArbClose({ position, todayDate: '2026-09-24' })).toBe('arb_expiry')
    expect(decideArbClose({ position, currentEdgePerShare: undefined, todayDate: '2026-09-13' })).toBeUndefined()
    expect(decideArbClose({ position, currentEdgePerShare: -0.001, todayDate: '2026-09-13' })).toBe('arb_reverse')
    expect(decideArbClose({ position, currentEdgePerShare: 0.009, todayDate: '2026-09-13' })).toBe('arb_converge')
    expect(decideArbClose({ position, currentEdgePerShare: 0.011, todayDate: '2026-09-13' })).toBeUndefined()
  })
})

describe('现货腿端到端盈亏（applyOpen → 现货涨 → applyClose）', () => {
  it('realizedPnl = 权利金差 + ΔS × 10000 × qty − 双边费', () => {
    const open = decideArbOpen({
      opportunity: parityOpportunity(),
      chain: parityChain(),
      positionKeys: new Set<string>(),
      cash: 100_000,
      nowMs: NOW_MS,
      spotPrice: 2.9,
      spotSymbol: '510050.SH',
      optionMarginPerContract: 500,
    })
    expect(open.kind).toBe('open')
    if (open.kind !== 'open') return
    let state = applyOpen(
      { account: emptyPaperAccount(NOW_ISO, 'arbitrage'), positions: [], fills: [] },
      { ...open.fill, positionId: open.positionId, expiryMonth: '2609', direction: 'buy_synthetic_sell_spot', strikes: [2.85] },
    )
    expect(state.account.cash).toBeCloseTo(100_000 + 28_684 * 2 - 15_000 * 2 - 12.6, 8)

    // 平仓：现货 2.9→2.95，合成多头权利金 +0.098（C bid 0.164）。
    const closeLegs = buildArbCloseLegs(
      state.positions[0]!,
      (code, action) => {
        const price = code.endsWith('M02850') && code.includes('C')
          ? (action === 'sell' ? 0.164 : 0.166)
          : (action === 'buy' ? 0.021 : 0.019)
        return { price, source: action === 'buy' ? ('ask' as const) : ('bid' as const) }
      },
      { price: 2.95, source: 'spot' },
    )
    expect(closeLegs).toBeDefined()
    state = applyClose(state, open.positionId, closeLegs!, 'arb_converge', NOW_ISO)
    expect(state.positions).toHaveLength(0)
    // 净价差：现货 −0.05×20000 = −1000；C (0.164−0.05)×20000 = 2280；P −0.0026×20000 = −52
    // → 1228 − 费(12.6 + 12.7) = 1202.7。
    expect(state.account.realizedPnl).toBeCloseTo(1228 - 25.3, 8)
    expect(state.fills.at(-1)?.reason).toBe('arb_converge')
  })
})

describe('tryArbPaperCycle（周期编排：开仓 → 收敛平仓）', () => {
  it('regular 扫出 executable parity → arb_open 落账；close5 边收敛 → arb_converge 平仓', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-cycle-'))
    const openedChain = parityChain()
    // 收敛链：C_ask 0.05→0.06 → 可执行边 ≈ 0.00996 < openEdge/2(0.00998)。
    const convergedChain = parityChain({
      calls: [row('510050C2609M02850', 2.85, { last: 0.059, bid: 0.058, ask: 0.06 })],
    })
    const chains = [openedChain]
    const baseInput = {
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      underlyings: ['510050'],
      expiryMonthsFor: async () => ['2609'],
      getChain: async () => chains[0],
      getSpot: async () => 2.9,
      getOptionLegMarginPerContract: async () => 500,
      spotSymbolFor: (u: string) => `${u}.SH`,
    }

    await tryArbPaperCycle({ ...baseInput, session: 'regular' })
    let state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0]).toMatchObject({
      id: 'arb:parity:510050:2609:2850',
      template: 'parity',
      book: 'arbitrage',
      expiryMonth: '2609',
      expiryDate: '2026-09-23',
      direction: 'buy_synthetic_sell_spot',
      strikes: [2.85],
      qty: 2,
    })
    expect(state.fills).toHaveLength(1)
    expect(state.fills[0]).toMatchObject({ reason: 'arb_open', book: 'arbitrage', qty: 2 })
    expect(state.account.cash).toBeCloseTo(100_000 + 28_684 * 2 - 15_000 * 2 - 12.6, 8)
    const fillsText = await readFile(paperFillsPath(root, 'arbitrage', '2026-09-13'), 'utf8')
    expect(fillsText).toContain('"reason":"arb_open"')

    // close5：只平不开（收敛后不再追开新仓）。
    chains[0] = convergedChain
    await tryArbPaperCycle({ ...baseInput, session: 'close5' })
    state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toHaveLength(0)
    expect(state.fills.at(-1)).toMatchObject({ reason: 'arb_converge' })
    // 平仓现金流：C sell bid 0.058、P buy ask 0.0204、spot buy 2.9（回落价未变）。
    expect(state.account.realizedPnl).toBeCloseTo(
      57_368 + (0.058 - 0.0204) * 2 * 10_000 - 2.9 * 20_000 - 25.2,
      8,
    )
  })

  it('closed 会话不开仓；getChain 抛错整体吞掉不炸', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-cycle-closed-'))
    await tryArbPaperCycle({
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      session: 'closed',
      underlyings: ['510050'],
      expiryMonthsFor: async () => { throw new Error('expiries down') },
      getChain: async () => { throw new Error('chain down') },
      getSpot: async () => { throw new Error('spot down') },
      getOptionLegMarginPerContract: async () => { throw new Error('margin down') },
    })
    const state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toEqual([])
    expect(state.fills).toEqual([])
  })

  // 2026-09-17 生产事故回归：iquant /v1/chain 响应不带 spot，引擎扫描又不注入
  // → parityMatrix 恒空，平价检测整链瘫痪（当日 0 信号）。fixture 此前内嵌
  // spot: 2.9 掩盖了该形态。
  it('链不带 spot（iquant 形态）→ getSpot 现价补入，parity 开仓照常落账', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-cycle-nospot-'))
    await tryArbPaperCycle({
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      session: 'regular',
      underlyings: ['510050'],
      expiryMonthsFor: async () => ['2609'],
      getChain: async () => parityChain({ spot: null }),
      getSpot: async () => 2.9,
      getOptionLegMarginPerContract: async () => 500,
      spotSymbolFor: (u) => `${u}.SH`,
    })
    const state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0]).toMatchObject({
      id: 'arb:parity:510050:2609:2850',
      template: 'parity',
      direction: 'buy_synthetic_sell_spot',
    })
    // 现货腿成交价与检测同源（getSpot 2.9），不是 0/undefined 混入。
    const spotLeg = state.fills[0]!.legs.find((leg) => leg.asset === 'spot')
    expect(spotLeg).toMatchObject({ fillPrice: 2.9, priceSource: 'spot' })
  })

  it('链不带 spot 且 getSpot 也拿不到 → 不开仓不炸（parity 优雅降级）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-cycle-nospot-down-'))
    await tryArbPaperCycle({
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      session: 'regular',
      underlyings: ['510050'],
      expiryMonthsFor: async () => ['2609'],
      getChain: async () => parityChain({ spot: null }),
      getSpot: async () => undefined,
      getOptionLegMarginPerContract: async () => 500,
    })
    const state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toEqual([])
    expect(state.fills).toEqual([])
  })
})

describe('decideIntrinsicOpen（深实值贴水 happy path + skip 分支）', () => {
  const base = {
    discount: intrinsicDiscount(),
    chain: intrinsicChain(),
    positionKeys: new Set<string>(),
    cash: 100_000,
    nowMs: NOW_MS,
    spotPrice: 2.9,
    feePerContract: 1.7,
  }

  it('happy path：纯买腿无保证金，qty=10（2400 元/张 × 10 < 现金），边现算复核', () => {
    const decided = decideIntrinsicOpen(base)
    expect(decided.kind).toBe('open')
    if (decided.kind !== 'open') return
    expect(decided.positionId).toBe('arb:intrinsic_call:510050:2609:2650')
    expect(decided.fill.qty).toBe(10)
    expect(decided.fill.marginCny).toBe(0)
    expect(decided.fill.premiumCny).toBeCloseTo(-0.24 * 10 * 10_000, 8)
    expect(decided.fill.template).toBe('intrinsic_call')
    expect(decided.fill.legs).toEqual([
      { code: '510050C2609M02650', side: 'buy', qty: 10, fillPrice: 0.24, priceSource: 'ask' },
    ])
    // openEdge = bound − ask（链现算），与扫描口径一致。
    expect(decided.fill.openEdgePerShare).toBeCloseTo(0.0114, 3)
    expect(decided.fill.feeCny).toBeCloseTo(17, 8)
  })

  it('skip 分支：stale_snapshot / duplicate / no_quote / no_spot / edge_gone / no_cash', () => {
    expect(decideIntrinsicOpen({ ...base, nowMs: NOW_MS + 120_000 }))
      .toEqual({ kind: 'skip', reason: 'stale_snapshot' })
    expect(decideIntrinsicOpen({ ...base, chain: { ...intrinsicChain(), snapshotAt: undefined } }))
      .toEqual({ kind: 'skip', reason: 'stale_snapshot' })
    expect(decideIntrinsicOpen({ ...base, positionKeys: new Set(['arb:intrinsic_call:510050:2609:2650']) }))
      .toEqual({ kind: 'skip', reason: 'duplicate' })
    expect(decideIntrinsicOpen({ ...base, chain: intrinsicChain({ calls: [] }) }))
      .toEqual({ kind: 'skip', reason: 'no_quote' })
    expect(decideIntrinsicOpen({ ...base, spotPrice: undefined }))
      .toEqual({ kind: 'skip', reason: 'no_spot' })
    // ask 抬到 bound 之上 → 再入场边 ≤ 0（边反转，非缩量交易）。
    expect(decideIntrinsicOpen({
      ...base,
      chain: intrinsicChain({
        calls: [row('510050C2609M02650', 2.65, { last: 0.259, bid: 0.258, ask: 0.26 })],
      }),
    })).toEqual({ kind: 'skip', reason: 'edge_gone' })
    expect(decideIntrinsicOpen({ ...base, cash: 1_000 }))
      .toEqual({ kind: 'skip', reason: 'no_cash' })
  })

  it('模板助手：right ↔ intrinsic_call/put 双向；P 键与 C 键分离', () => {
    expect(intrinsicTemplateOf('C')).toBe('intrinsic_call')
    expect(intrinsicTemplateOf('P')).toBe('intrinsic_put')
    expect(rightOfIntrinsicTemplate('intrinsic_call')).toBe('C')
    expect(rightOfIntrinsicTemplate('intrinsic_put')).toBe('P')
    expect(rightOfIntrinsicTemplate('parity')).toBeUndefined()
    expect(arbPositionKey({
      kind: intrinsicTemplateOf('P'),
      underlying: '510050',
      expiryMonth: '2609',
      strikes: [2.65],
    })).toBe('arb:intrinsic_put:510050:2609:2650')
  })
})

describe('tryArbPaperCycle（深实值贴水：开仓 → 收敛平仓 → 子帽）', () => {
  it('regular 扫出深实值贴水 → intrinsic_call 落账；close5 边收敛 → arb_converge 平仓', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-intrinsic-'))
    const chains: OptionChain[] = [intrinsicChain()]
    const baseInput = {
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      underlyings: ['510050'],
      expiryMonthsFor: async () => ['2609'],
      getChain: async () => chains[0],
      getSpot: async () => 2.9,
      getOptionLegMarginPerContract: async () => 500,
    }

    await tryArbPaperCycle({ ...baseInput, session: 'regular' })
    let state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0]).toMatchObject({
      id: 'arb:intrinsic_call:510050:2609:2650',
      template: 'intrinsic_call',
      book: 'arbitrage',
      expiryMonth: '2609',
      expiryDate: '2026-09-23',
      strikes: [2.65],
      qty: 10,
    })
    // 贴水仓无 direction（right 在模板里）；openEdge 为链现算贴水。
    expect(state.positions[0]!.direction).toBeUndefined()
    expect(state.positions[0]!.openEdgePerShare).toBeCloseTo(0.0114, 3)

    // 收敛：ask 抬到 0.247 → 再入场边 ≈ 0.0044 < openEdge/2(≈0.0057)。
    chains[0] = intrinsicChain({
      calls: [row('510050C2609M02650', 2.65, { last: 0.245, bid: 0.243, ask: 0.247 })],
    })
    await tryArbPaperCycle({ ...baseInput, session: 'close5' })
    state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toHaveLength(0)
    expect(state.fills.at(-1)).toMatchObject({ reason: 'arb_converge', template: 'intrinsic_call' })
    // 平仓：sell 10 张 @bid 0.243 = +24300；开仓 −24000；双边费 17+17。
    expect(state.account.realizedPnl).toBeCloseTo(24_300 - 24_000 - 34, 6)
  })

  it(`深实值子帽：${OPTION_ARB_MAX_INTRINSIC_POSITIONS} 组封顶，不挤占共享上限`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-intrinsic-cap-'))
    // 4 档深实值 C 全部低于 bound（贴水约 0.011）；三组现金占用 ≈ 4.2 万 < 10 万，
    // 现金不先于子帽约束。
    const strikes = [2.8, 2.75, 2.7, 2.65]
    const chain: OptionChain = {
      ...intrinsicChain(),
      calls: strikes.map((strike) => {
        const bound = 2.9 - strike * 0.999464
        const ask = Number((bound - 0.011).toFixed(4))
        return row(`510050C2609M0${Math.round(strike * 1000)}`, strike, { last: ask, bid: ask - 0.004, ask })
      }),
    }
    await tryArbPaperCycle({
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      session: 'regular',
      underlyings: ['510050'],
      expiryMonthsFor: async () => ['2609'],
      getChain: async () => chain,
      getSpot: async () => 2.9,
      getOptionLegMarginPerContract: async () => 500,
    })
    const state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toHaveLength(OPTION_ARB_MAX_INTRINSIC_POSITIONS)
    expect(state.positions.every((p) => p.template === 'intrinsic_call')).toBe(true)
  })

  // 生产形态活性哨兵（2026-09-17 事故教训的 intrinsic 版）：
  // 链不带 spot + last-only（无盘口）→ 贴水扫描必须空转不炸、不落账。
  it('链无 spot 且无盘口（生产形态）→ 不开仓不炸', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opt-arb-intrinsic-degraded-'))
    await tryArbPaperCycle({
      root,
      date: '2026-09-13',
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
      session: 'regular',
      underlyings: ['510050'],
      expiryMonthsFor: async () => ['2609'],
      getChain: async () => intrinsicChain({
        spot: null,
        calls: [row('510050C2609M02650', 2.65, { last: 0.24 })],
      }),
      getSpot: async () => undefined,
      getOptionLegMarginPerContract: async () => 500,
    })
    const state = await loadPaperState(root, '2026-09-13', NOW_ISO, 'arbitrage')
    expect(state.positions).toEqual([])
    expect(state.fills).toEqual([])
  })
})
