import { describe, it, expect } from 'vitest'
import type { ArbitrageChain } from '../src/arbitrage/types.ts'
import { parityMatrix, scanParityArbitrage } from '../src/arbitrage/parity.ts'
import { scanBoxArbitrage } from '../src/arbitrage/box.ts'
import { buildVerticalSpread, scanVerticalSpreads } from '../src/arbitrage/vertical.ts'

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
