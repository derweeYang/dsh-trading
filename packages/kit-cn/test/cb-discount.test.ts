/** 转债折价扫描单测：重算口径、陈旧列防伪影、价带/门槛闸、台账聚合、工具降级。 */
import { describe, expect, it } from 'vitest'
import type { CbQuoteRow, MarketDataService } from '@dshtrading/api'
import {
  createGetCbDiscountScanTool,
  scanCbDiscount,
  shouldRunCbScan,
  CB_SCAN_INTERVAL_MS,
} from '../src/cb-discount.js'
import { foldCbScans, type CbScanLedgerRow } from '../src/option-bar-ledger.js'

function row(over: Partial<CbQuoteRow> = {}): CbQuoteRow {
  return {
    bondCode: '123001',
    bondName: '测试转债',
    exchange: 'SZ',
    price: 95,
    stockCode: '000001',
    stockPrice: 20,
    conversionPrice: 20,
    ...over,
  }
}

describe('scanCbDiscount', () => {
  it('重算转股价值与溢价率：折价行命中、费后净溢价、升序排列', () => {
    const scan = scanCbDiscount([
      row({ bondCode: 'A', price: 95, stockPrice: 20, conversionPrice: 20 }), // value=100 → −5%
      row({ bondCode: 'B', price: 96.5, stockPrice: 20, conversionPrice: 20 }), // −3.5%
      row({ bondCode: 'C', price: 100.5, stockPrice: 20, conversionPrice: 20 }), // +0.5% 不命中
    ])
    expect(scan.scanned).toBe(3)
    expect(scan.priced).toBe(3)
    expect(scan.stale).toBe(0)
    expect(scan.minPremiumPct).toBeCloseTo(-5, 8)
    expect(scan.hits.map((h) => h.bondCode)).toEqual(['A', 'B'])
    expect(scan.hits[0]).toMatchObject({
      bondCode: 'A',
      conversionValue: 100,
      premiumPct: -5,
      netPremiumPct: -5 + 0.05,
    })
    expect(scan.disclaimer).toContain('不构成投资建议')
  })

  it('快照列陈旧防伪影：conversionValue 偏差超容忍 → stale 剔除不进分布', () => {
    const scan = scanCbDiscount([
      row({ bondCode: 'S', conversionValue: 130, price: 95 }), // 重算 100，偏差 30% > 0.5%
      row({ bondCode: 'OK', conversionValue: 100.2, price: 95 }), // 偏差 0.2% ≤ 0.5% 正常计
    ])
    expect(scan.stale).toBe(1)
    expect(scan.priced).toBe(2)
    expect(scan.hits.map((h) => h.bondCode)).toEqual(['OK']) // stale 行即便折价也不列示
    expect(scan.minPremiumPct).toBeCloseTo(-5, 8)
  })

  it('价带闸：转债价 < 70 的深折价行不进 hits（分布统计仍含其溢价）', () => {
    const scan = scanCbDiscount([
      row({ bondCode: 'LOW', price: 65, stockPrice: 10, conversionPrice: 10 }), // value=100 → −35%
    ])
    expect(scan.hits).toEqual([])
    expect(scan.minPremiumPct).toBeCloseTo(-35, 8)
    const loosened = scanCbDiscount(
      [row({ bondCode: 'LOW', price: 65, stockPrice: 10, conversionPrice: 10 })],
      { minPrice: 60 },
    )
    expect(loosened.hits.map((h) => h.bondCode)).toEqual(['LOW'])
  })

  it('门槛可调 / 三要素缺失行跳过 / 空输入', () => {
    const rows = [
      row({ bondCode: 'A', price: 99.5, stockPrice: 20, conversionPrice: 20 }), // −0.5%
    ]
    expect(scanCbDiscount(rows).hits).toEqual([]) // 默认 −1 门槛
    expect(scanCbDiscount(rows, { thresholdPct: -0.4 }).hits.map((h) => h.bondCode)).toEqual(['A'])
    expect(scanCbDiscount([row({ conversionPrice: 0 })]).priced).toBe(0)
    expect(scanCbDiscount([])).toMatchObject({ scanned: 0, priced: 0, hits: [] })
  })
})

describe('shouldRunCbScan / foldCbScans', () => {
  it('仅 regular 且间隔到点才跑', () => {
    expect(shouldRunCbScan(300_000, 0, 'regular', CB_SCAN_INTERVAL_MS)).toBe(true)
    expect(shouldRunCbScan(299_999, 0, 'regular', CB_SCAN_INTERVAL_MS)).toBe(false)
    expect(shouldRunCbScan(600_000, 0, 'close5', CB_SCAN_INTERVAL_MS)).toBe(false)
  })

  it('台账日聚合：轮数/错误/stale/命中轮/最深溢价', () => {
    const rows: CbScanLedgerRow[] = [
      { kind: 'cb_scan', asOf: 't1', scanned: 1000, priced: 300, stale: 2, hitCount: 1, top: [{ bondCode: 'A', premiumPct: -1.2 } as CbScanLedgerRow['top'][number]] },
      { kind: 'cb_scan', asOf: 't2', scanned: 1000, priced: 300, stale: 1, hitCount: 0, top: [] },
      { kind: 'cb_scan', asOf: 't3', scanned: 0, priced: 0, stale: 0, hitCount: 0, top: [], error: 'route' },
    ]
    const folded = foldCbScans(rows)
    expect(folded).toMatchObject({ cycles: 3, errors: 1, stale: 3, hitCycles: 1, minPremiumPct: -1.2 })
  })
})

describe('createGetCbDiscountScanTool', () => {
  it('有 getCovSnapshot 的服务 → 扫描结果 JSON', async () => {
    const service = {
      getCovSnapshot: async () => [row({ bondCode: 'A', price: 95 })],
    } as unknown as MarketDataService
    const tool = createGetCbDiscountScanTool({ getMarketData: () => service })
    const raw = await tool.execute({})
    const parsed = JSON.parse(raw as string) as { hits: Array<{ bondCode: string }>; priced: number }
    expect(parsed.priced).toBe(1)
    expect(parsed.hits[0]?.bondCode).toBe('A')
  })

  it('active provider 无能力 → 显式降级报错（不抛异常）', async () => {
    const service = {} as MarketDataService
    const tool = createGetCbDiscountScanTool({ getMarketData: () => service })
    const raw = await tool.execute({})
    expect(JSON.parse(raw as string)).toMatchObject({ error: expect.stringContaining('getCovSnapshot') })
  })
})
