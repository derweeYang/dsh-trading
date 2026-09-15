/**
 * 蝶式开仓链路测试（2026-09-14）。
 *
 * 缺陷：纸账户里蝶式永远开不了仓——`decidePaperOpen` 只放行 vertical 去取链
 * （`pick.template !== 'vertical'` 直接 no_quote），而蝶式候选 bias 恒为 neutral，
 * 即便拿到链 `completeVerticalLegs` 也会判 no_quote。结果是 09-14 三条 butterfly
 * 推荐全部以 no_quote 收场，纸账户自上线以来零成交。
 *
 * 本文件锁三件事：① `completeButterflyLegs` 造 1:2:1 三腿；② 缺腿/缺报价仍 no_quote
 * （不能为了出成交而口算权利金）；③ `tryPaperOpen` 端到端真的落一笔带腿成交。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OptionBarRecommendation, OptionChain, OptionIntradayBoxRow } from '@dshtrading/api'
import { completeButterflyLegs, decidePaperOpen, tryPaperOpen } from '../src/option-paper.js'
import { paperFillsPath } from '../src/option-bar-ledger.js'

/** spot 落在中间档（2.95），蝶式才有完整的低/中/高三腿。 */
const butterflyChain: OptionChain = {
  underlying: '510050',
  expiryMonth: '2609',
  source: 'iquant',
  spot: 2.964,
  calls: [
    { code: '510050C2609M02900', strike: 2.9, last: 0.08 },
    { code: '510050C2609M02950', strike: 2.95, last: 0.05 },
    { code: '510050C2609M03000', strike: 3.0, last: 0.03 },
  ],
  puts: [],
}

const butterflyForecast: OptionIntradayBoxRow = {
  underlying: '510050',
  name: '华夏上证50ETF',
  exchange: 'SSE',
  horizonMin: 5,
  regime: 'range_hold',
  session: 'regular',
  boxLow: 2.9594,
  boxHigh: 2.9686,
  candidates: [{
    template: 'butterfly',
    bias: 'neutral',
    invalidIf: '1-minute close outside [2.9594, 2.9686]',
    reason: 'Tight realized range; premium-selling butterfly only if IV is rich.',
  }],
}

function butterflyRec(): OptionBarRecommendation {
  return {
    bucketStart: '2026-09-14T02:00:00.000Z',
    asOf: '2026-09-14T02:00:09.000Z',
    session: 'regular',
    opportunity: 'theta_rent',
    edge: 'x',
    logic: 'x',
    playbook: 'x',
    invalidIf: '1-minute close outside [2.9594, 2.9686]',
    picks: [{ underlying: '510050', template: 'butterfly' }],
    noTrade: false,
  }
}

async function tmpRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'dsh-butterfly-'))
}

const roots: string[] = []

afterEach(async () => {
  // 落盘的临时账本只是纸账户 jsonl，直接留在 tmpdir 等价；此处仅断开引用避免误用。
  roots.length = 0
})

describe('completeButterflyLegs', () => {
  it('ATM 上下各一档 → 买 1 / 卖 2 / 买 1 三腿，价格取自可成交报价', () => {
    const { legs, skip } = completeButterflyLegs(butterflyChain, 1)
    expect(skip).toBeUndefined()
    expect(legs).toEqual([
      { code: '510050C2609M02900', side: 'buy', qty: 1, fillPrice: 0.08, priceSource: 'last' },
      { code: '510050C2609M02950', side: 'sell', qty: 2, fillPrice: 0.05, priceSource: 'last' },
      { code: '510050C2609M03000', side: 'buy', qty: 1, fillPrice: 0.03, priceSource: 'last' },
    ])
  })

  it('档位不足三行 → no_quote（不拼残缺蝶式）', () => {
    const thin: OptionChain = { ...butterflyChain, calls: butterflyChain.calls.slice(0, 2) }
    expect(completeButterflyLegs(thin, 1).skip).toBe('no_quote')
  })

  it('任一腿无报价 → no_quote（禁止口算权利金）', () => {
    const noQuote: OptionChain = {
      ...butterflyChain,
      calls: [
        { code: '510050C2609M02900', strike: 2.9 },
        { code: '510050C2609M02950', strike: 2.95, last: 0.05 },
        { code: '510050C2609M03000', strike: 3.0, last: 0.03 },
      ],
    }
    expect(completeButterflyLegs(noQuote, 1).skip).toBe('no_quote')
  })
})

describe('decidePaperOpen 蝶式放行', () => {
  it('有链 → 出 fill；链缺席 → no_quote（取链失败仍如实呈报）', () => {
    const base = {
      rec: butterflyRec(),
      forecastByUnderlying: { '510050': butterflyForecast },
      fillsToday: [],
      marginFor: () => 1000,
      nowIso: '2026-09-14T02:00:09.000Z',
      cash: 100000,
    }
    expect(decidePaperOpen({ ...base, chainFor: () => butterflyChain })).toMatchObject({ fill: {} })
    expect(decidePaperOpen({ ...base, chainFor: () => undefined })).toMatchObject({
      skip: { skip: 'no_quote' },
    })
  })

  it('保证金查询失败 → no_quote（不让无保证金的义务仓进场）', () => {
    const decision = decidePaperOpen({
      rec: butterflyRec(),
      forecastByUnderlying: { '510050': butterflyForecast },
      fillsToday: [],
      chainFor: () => butterflyChain,
      marginFor: () => undefined,
      nowIso: '2026-09-14T02:00:09.000Z',
      cash: 100000,
    })
    expect(decision).toMatchObject({ skip: { skip: 'no_quote' } })
  })
})

describe('tryPaperOpen 蝶式端到端', () => {
  it('落一笔带三腿的成交（纸账户历史首笔蝶式的回归锁）', async () => {
    const root = await tmpRoot()
    roots.push(root)
    await tryPaperOpen({
      root,
      date: '2026-09-14',
      rec: butterflyRec(),
      forecastByUnderlying: { '510050': butterflyForecast },
      nowIso: '2026-09-14T02:00:09.000Z',
      getChain: async () => butterflyChain,
      getMargin: async () => 1000,
    })
    const raw = await readFile(paperFillsPath(root, 'strategy', '2026-09-14'), 'utf8')
    const fills = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
      reason?: string
      offset?: string
      legs?: unknown[]
    })
    expect(fills).toHaveLength(1)
    // 成功成交的 fill 带 reason:'signal'；skip 桩才是 reason:'skipped'。
    expect(fills[0]).toMatchObject({ offset: 'open', reason: 'signal' })
    expect(fills[0]!.legs).toHaveLength(3)
  })
})
