import { describe, it, expect } from 'vitest'
import type { OptionChain } from '@dshtrading/api'
import type { ArbitrageChain, ArbitrageOpportunity } from '../src/arbitrage/types.ts'
import { parityMatrix, paritySignedEdge, scanParityArbitrage } from '../src/arbitrage/parity.ts'
import { boxSignedEdge, scanBoxArbitrage } from '../src/arbitrage/box.ts'
import { buildVerticalSpread, scanVerticalSpreads } from '../src/arbitrage/vertical.ts'
import { fromOptionChain } from '../src/arbitrage/adapter.ts'
import { scanArbitrage } from '../src/arbitrage/index.ts'

const asOf = '2026-09-13'
const expiryDate = '2026-09-23'

// 单调真实价：call 随行权价递增，put 随行权价递减；spot=2.90。
// 故意不全为无套利（K=2.90 令 C−P 偏离现金远 ~0.0084，箱型长箱有正边）。
function fixture(): ArbitrageChain {
  return {
    underlying: '510050.SH',
    expiryMonth: '2609',
    expiryDate,
    asOf,
    spot: 2.9,
    multiplier: 10000,
    calls: [
      { code: 'C285', strike: 2.85, last: 0.065 },
      { code: 'C290', strike: 2.9, last: 0.045 },
      { code: 'C295', strike: 2.95, last: 0.025 },
    ],
    puts: [
      { code: 'P285', strike: 2.85, last: 0.02 },
      { code: 'P290', strike: 2.9, last: 0.035 },
      { code: 'P295', strike: 2.95, last: 0.055 },
    ],
  }
}

describe('parityMatrix', () => {
  it('detects call-rich deviation at K=2.90', () => {
    const rows = parityMatrix(fixture(), { rate: 0.02, dividendYield: 0, asOf })
    const r = rows.find((x) => x.strike === 2.9)
    expect(r).toBeDefined()
    expect(r?.direction).toBe('call_rich')
    // cashForward ≈ 2.9 - 2.9*e^{-0.02*T} (T≈0.0274) ≈ 0.00159; synth = 0.045-0.035 = 0.01
    expect(r?.deviation).toBeGreaterThan(0)
    expect(r?.deviation).toBeCloseTo(0.0084, 3)
  })

  it('returns empty when spot or expiry missing', () => {
    expect(parityMatrix({ ...fixture(), spot: undefined }, { asOf })).toEqual([])
    expect(parityMatrix({ ...fixture(), expiryDate: undefined }, { asOf })).toEqual([])
  })
})

describe('scanParityArbitrage', () => {
  it('returns opportunities sorted by edge, all parity kind', () => {
    const ops = scanParityArbitrage(fixture(), { rate: 0.02, dividendYield: 0, asOf, threshold: 0.0001 })
    expect(ops.length).toBeGreaterThan(0)
    expect(ops[0]?.kind).toBe('parity')
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i - 1]?.edgePerContract ?? 0).toBeGreaterThanOrEqual(ops[i]?.edgePerContract ?? 0)
    }
  })
})

describe('scanBoxArbitrage', () => {
  it('flags long box when market box is cheap', () => {
    const ops = scanBoxArbitrage(fixture(), { rate: 0.02, asOf, threshold: 0.0001 })
    expect(ops.length).toBeGreaterThan(0)
    const op = ops[0]
    expect(op?.kind).toBe('box')
    expect(op?.direction).toBe('long_box')
    expect(op?.edgePerShare ?? 0).toBeGreaterThan(0)
  })
})

describe('buildVerticalSpread', () => {
  it('bull call debit spread math', () => {
    const sp = buildVerticalSpread(fixture(), { right: 'C', direction: 'bull', lowStrike: 2.85, highStrike: 2.9 })
    expect(sp).toBeDefined()
    expect(sp?.netDebit).toBeCloseTo(0.02, 6)
    expect(sp?.maxProfitPerShare).toBeCloseTo(0.03, 6)
    expect(sp?.maxLossPerShare).toBeCloseTo(0.02, 6)
    expect(sp?.breakeven).toBeCloseTo(2.87, 6)
  })

  it('bear put debit spread math', () => {
    const sp = buildVerticalSpread(fixture(), { right: 'P', direction: 'bear', lowStrike: 2.85, highStrike: 2.95 })
    expect(sp).toBeDefined()
    // 卖 P(2.85)收0.02, 买 P(2.95)付0.055 → 净借记 0.035
    expect(sp?.netDebit).toBeCloseTo(0.035, 6)
    expect(sp?.maxProfitPerShare).toBeCloseTo(0.065, 6) // 价差0.10 - 净借记0.035
    expect(sp?.maxLossPerShare).toBeCloseTo(0.035, 6)
    expect(sp?.breakeven).toBeCloseTo(2.915, 6) // 高K - 净借记
  })
})

describe('scanVerticalSpreads', () => {
  it('enumerates all four combos across strike pairs', () => {
    const spreads = scanVerticalSpreads(fixture())
    // 3 strikes → 3 pairs × 4 combos = 12
    expect(spreads.length).toBe(12)
  })
})

/** 后端 OptionChain（含 2026-09-13 契约扩展的 bid/ask 与 snapshotAt）。 */
function wireChain(quotes: { bid?: number; ask?: number }): OptionChain {
  return {
    underlying: '510050',
    expiryMonth: '2609',
    expiryDate,
    snapshotAt: `${asOf}T15:00:00+08:00`,
    source: 'iquant',
    spot: 2.9,
    calls: [
      { code: 'C285', strike: 2.85, last: 0.065, ...quotes },
      { code: 'C290', strike: 2.9, last: 0.045, ...quotes },
      { code: 'C295', strike: 2.95, last: 0.025, ...quotes },
    ],
    puts: [
      { code: 'P285', strike: 2.85, last: 0.02, ...quotes },
      { code: 'P290', strike: 2.9, last: 0.035, ...quotes },
      { code: 'P295', strike: 2.95, last: 0.055, ...quotes },
    ],
  }
}

describe('fromOptionChain（adapter，后端链路）', () => {
  it('转发 bid/ask 与 snapshotAt（→ asOf），缺价键不落 undefined', () => {
    const arb = fromOptionChain(wireChain({ bid: 0.044, ask: 0.046 }))
    expect(arb.asOf).toBe(`${asOf}T15:00:00+08:00`)
    expect(arb.calls[1]?.bid).toBeCloseTo(0.044, 6)
    expect(arb.calls[1]?.ask).toBeCloseTo(0.046, 6)
    const bare = fromOptionChain({ ...wireChain({}), snapshotAt: undefined })
    expect('bid' in (bare.calls[1] ?? {})).toBe(false)
    expect('asOf' in bare).toBe(false)
  })

  it('真实买卖盘 → scanArbitrage 机会 executable=true', () => {
    // 仅 ATM（K=2.90）挂真实盘：C bid/ask=0.044/0.046（mid=last），P=0.034/0.036（mid=last）。
    // 卖合成可执行边 (C_bid − P_ask) − cashForward(≈0.0016) ≈ 0.0064 元/股。
    const base = wireChain({})
    const withQuotes: OptionChain = {
      ...base,
      calls: base.calls.map((c) => (c.strike === 2.9 ? { ...c, bid: 0.044, ask: 0.046 } : c)),
      puts: base.puts.map((p) => (p.strike === 2.9 ? { ...p, bid: 0.034, ask: 0.036 } : p)),
    }
    const ops = scanArbitrage(fromOptionChain(withQuotes), { asOf, threshold: 0.0001 })
    const parityOp = ops.find((o) => o.kind === 'parity' && o.strike === 2.9)
    expect(parityOp).toBeDefined()
    expect(parityOp?.executable).toBe(true)
    expect(parityOp?.edgePerShare ?? 0).toBeGreaterThan(0.006)
  })

  it('无买卖盘（last 近似）→ executable=false', () => {
    const ops = scanArbitrage(fromOptionChain(wireChain({})), { asOf, threshold: 0.0001 })
    for (const op of ops) expect(op.executable).toBe(false)
    expect(ops.length).toBeGreaterThan(0)
  })
})

/** 每行按 last ± halfSpread 挂真实盘口（mid=last，全部 executable）。 */
function quoted(chain: ArbitrageChain, halfSpread: number): ArbitrageChain {
  const map = (rows: readonly ArbitrageChain['calls'][number][]) => rows.map((r) => (
    r.last === undefined ? r : { ...r, bid: r.last - halfSpread, ask: r.last + halfSpread }
  ))
  return { ...chain, calls: map(chain.calls), puts: map(chain.puts) }
}

describe('paritySignedEdge / boxSignedEdge（持仓监控签名边，2026-09-13 C2）', () => {
  const parityDir = (op: ArbitrageOpportunity) =>
    op.direction as 'buy_synthetic_sell_spot' | 'sell_synthetic_buy_spot'
  const boxDir = (op: ArbitrageOpportunity) => op.direction as 'long_box' | 'short_box'

  it.each([
    ['无盘口（mid 近似）', () => fixture()],
    ['全行真实盘口（executable）', () => quoted(fixture(), 0.001)],
  ])('%s：与 scanArbitrage 同值同号，executable 传播一致', (_name, make) => {
    const chain = make()
    const ops = scanArbitrage(chain, { asOf, threshold: 0.0001 })
    expect(ops.length).toBeGreaterThan(0)
    for (const op of ops) {
      const signed = op.kind === 'parity'
        ? paritySignedEdge(chain, op.strike!, parityDir(op), { asOf })
        : boxSignedEdge(chain, op.lowStrike!, op.highStrike!, boxDir(op), { asOf })
      expect(signed).toBeDefined()
      expect(signed!.edgePerShare).toBeCloseTo(op.edgePerShare, 10)
      expect(signed!.executable).toBe(op.executable)
    }
  })

  it('反向持仓的残余边为负（收敛/反转判据的符号语义）', () => {
    // K=2.90 call_rich（deviation≈0.0084）：sell_synthetic 方向为正，反向为负。
    const parityOp = scanParityArbitrage(fixture(), { asOf, threshold: 0.0001 })
      .find((o) => o.strike === 2.9)
    expect(parityOp?.direction).toBe('sell_synthetic_buy_spot')
    const reverseParity = paritySignedEdge(fixture(), 2.9, 'buy_synthetic_sell_spot', { asOf })
    expect(reverseParity!.edgePerShare).toBeLessThan(0)

    // fixture 的正边是 long_box → short_box 反向为负（无盘口时两向互为相反数）。
    const boxOp = scanBoxArbitrage(fixture(), { asOf, threshold: 0.0001 })[0]
    expect(boxOp?.direction).toBe('long_box')
    const reverseBox = boxSignedEdge(fixture(), boxOp!.lowStrike!, boxOp!.highStrike!, 'short_box', { asOf })
    expect(reverseBox!.edgePerShare).toBeCloseTo(-boxOp!.edgePerShare, 10)
  })

  it('缺行 / 缺 spot / 缺到期 → undefined（调用方 hold 等下轮）', () => {
    expect(paritySignedEdge(fixture(), 2.8, 'sell_synthetic_buy_spot', { asOf })).toBeUndefined()
    expect(paritySignedEdge({ ...fixture(), spot: undefined }, 2.9, 'sell_synthetic_buy_spot', { asOf })).toBeUndefined()
    expect(paritySignedEdge({ ...fixture(), expiryDate: undefined }, 2.9, 'sell_synthetic_buy_spot', { asOf })).toBeUndefined()
    expect(boxSignedEdge(fixture(), 2.8, 2.9, 'long_box', { asOf })).toBeUndefined()
    expect(boxSignedEdge({ ...fixture(), expiryDate: undefined }, 2.85, 2.9, 'long_box', { asOf })).toBeUndefined()
  })
})
