import { describe, it, expect } from 'vitest'
import type { ArbitrageChain } from '../src/arbitrage/types.ts'
import { scanIntrinsicDiscount, intrinsicSignedEdge } from '../src/arbitrage/intrinsic.ts'

const asOf = '2026-09-13'
const expiryDate = '2026-09-23' // T ≈ 0.0274，e^{-0.02T} ≈ 0.999452

// spot=2.90。深实值 C K=2.65：bound ≈ 2.9 − 2.65×0.999452 ≈ 0.25145（实值度 8.7%）。
// 深实值 P K=3.20：bound ≈ 3.2×0.999452 − 2.9 ≈ 0.29825（实值度 10.3%）。
function chain(over: Partial<Pick<ArbitrageChain, 'calls' | 'puts' | 'spot' | 'expiryDate'>> = {}): ArbitrageChain {
  return {
    underlying: '510050.SH',
    expiryMonth: '2609',
    expiryDate,
    asOf,
    spot: 2.9,
    multiplier: 10000,
    calls: [
      // ask 低于 bound ≈ 0.25145：贴水 ≈ 0.0115，价差 0.004 < 贴水
      { code: 'C265', strike: 2.65, last: 0.24, bid: 0.236, ask: 0.24 },
    ],
    puts: [
      // ask 低于 bound ≈ 0.29825：贴水 ≈ 0.0133，价差 0.005 < 贴水
      { code: 'P320', strike: 3.2, last: 0.2825, bid: 0.28, ask: 0.285 },
    ],
    ...over,
  }
}

describe('scanIntrinsicDiscount', () => {
  it('检出深实值 call/put 贴水，费后净贴水降序，腿为 buy', () => {
    const rows = scanIntrinsicDiscount(chain(), { asOf })
    expect(rows.map((r) => r.right)).toEqual(['P', 'C']) // put 贴水 0.0133 > call 0.0115
    const c = rows.find((r) => r.right === 'C')
    expect(c?.strike).toBe(2.65)
    expect(c?.discountPerShare).toBeCloseTo(0.0115, 3)
    expect(c?.netPerContract).toBeCloseTo(c!.discountPerShare * 10000, 3)
    expect(c?.leg).toEqual({ code: 'C265', right: 'C', action: 'buy', strike: 2.65 })
    expect(c?.boundPerShare).toBeCloseTo(0.25145, 3)
  })

  it('费后净贴水过默认门槛（50 元/张）才计入，费率从边里扣', () => {
    // 贴水 0.0115 → 费后 115 − 1.7 = 113.3 > 50 计入；
    // 把 ask 抬到 bound − 0.004 → 费后 40 − 1.7 < 50 被滤。
    const pricey = chain({ calls: [{ code: 'C265', strike: 2.65, bid: 0.245, ask: 0.24745 }], puts: [] })
    expect(scanIntrinsicDiscount(pricey, { asOf, feePerContract: 1.7 })).toEqual([])
    const ok = scanIntrinsicDiscount(chain(), { asOf, feePerContract: 1.7 })
    const c = ok.find((r) => r.right === 'C')
    expect(c?.netPerContract).toBeCloseTo(c!.discountPerShare * 10000 - 1.7, 6)
  })

  it('价差闸：买卖价差 ≥ 贴水的行不计（盘口内噪声，进出即亏）', () => {
    const wide = chain({ calls: [{ code: 'C265', strike: 2.65, bid: 0.225, ask: 0.24 }], puts: [] }) // 价差 0.015 > 贴水 0.0115
    expect(scanIntrinsicDiscount(wide, { asOf })).toEqual([])
  })

  it('实值度闸：近 ATM 折价行（bound/spot < 3%）不计', () => {
    // K=2.85 bound ≈ 0.0516（实值度 1.8%），ask 低于 bound 仍被 moneyness 闸滤掉。
    const nearAtm = chain({
      calls: [{ code: 'C285', strike: 2.85, last: 0.045, bid: 0.048, ask: 0.049 }],
      puts: [],
    })
    expect(scanIntrinsicDiscount(nearAtm, { asOf })).toEqual([])
  })

  it('无盘口 / 无 spot / 无到期 → 空数组（不产生 last 价近似信号）', () => {
    expect(
      scanIntrinsicDiscount(chain({ calls: [{ code: 'C265', strike: 2.65, last: 0.24 }], puts: [] }), { asOf }),
    ).toEqual([])
    expect(scanIntrinsicDiscount(chain({ spot: undefined }), { asOf })).toEqual([])
    expect(scanIntrinsicDiscount(chain({ expiryDate: undefined }), { asOf })).toEqual([])
  })
})

describe('intrinsicSignedEdge（持仓监控签名边）', () => {
  it('与 scanIntrinsicDiscount 同值同号（再入场边 = bound − ask）', () => {
    for (const r of scanIntrinsicDiscount(chain(), { asOf })) {
      const signed = intrinsicSignedEdge(chain(), r.strike, r.right, { asOf })
      expect(signed).toBeDefined()
      expect(signed!.edgePerShare).toBeCloseTo(r.discountPerShare, 10)
      expect(signed!.executable).toBe(true)
    }
  })

  it('ask 抬到 bound 之上 → 负边（反转判据）；盘口撤了 → undefined（hold）', () => {
    const faded = chain({ calls: [{ code: 'C265', strike: 2.65, bid: 0.252, ask: 0.254 }] })
    const signed = intrinsicSignedEdge(faded, 2.65, 'C', { asOf })
    expect(signed!.edgePerShare).toBeLessThan(0)
    const noBook = chain({ calls: [{ code: 'C265', strike: 2.65, last: 0.24 }] })
    expect(intrinsicSignedEdge(noBook, 2.65, 'C', { asOf })).toBeUndefined()
    expect(intrinsicSignedEdge(chain(), 2.8, 'C', { asOf })).toBeUndefined() // 缺行
    expect(intrinsicSignedEdge(chain({ spot: undefined }), 2.65, 'C', { asOf })).toBeUndefined()
  })
})
