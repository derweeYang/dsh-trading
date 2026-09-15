/**
 * 推荐腿 → 纸账户腿的字段兼容测试（2026-09-15）。
 *
 * 缺陷：`explicitLegs` 只认 `side` + `last/fillPrice/premium`，而盘中推荐实际给的是
 * `action` + `price` / `limitPrice` / `quoteBid`+`quoteAsk`——09-15 上午三条带 picks 的
 * 推荐**全部**解析失败，回退取链后无链可用 → no_quote，fills 一行为零。
 *
 * 用例全部取自当日 `data/options/recommendations/2026-09-15.jsonl` 的真实字段形态，
 * 不是自造格式。断言方式：`chainFor` 恒返回 undefined（无链可退），因此**能出 fill 就
 * 证明显式腿被正确解析**；出 no_quote 即说明解析失败——这个反差是显式腿是否生效的证据。
 */
import { describe, expect, it } from 'vitest'
import type { OptionBarRecommendation, OptionIntradayBoxRow } from '@dshtrading/api'
import { decidePaperOpen } from '../src/option-paper.js'

const forecast: OptionIntradayBoxRow = {
  underlying: '159919',
  name: '嘉实沪深300ETF',
  exchange: 'SSE',
  horizonMin: 5,
  regime: 'breakout',
  session: 'regular',
  boxLow: 4.83,
  boxHigh: 4.86,
  candidates: [{
    template: 'vertical',
    bias: 'up',
    invalidIf: '1-minute close breaks Donchian on volumeRatio>=1.5',
    reason: 'x',
  }],
}

function recWith(pickLegs: unknown[]): OptionBarRecommendation {
  return {
    bucketStart: '2026-09-15T02:30:00.000Z',
    asOf: '2026-09-15T02:30:09.000Z',
    session: 'regular',
    opportunity: 'direction_delta',
    edge: 'x',
    logic: 'x',
    playbook: 'x',
    invalidIf: 'x',
    picks: [{ underlying: '159919', template: 'vertical', legs: pickLegs }],
    noTrade: false,
  }
}

function decide(legs: unknown[]) {
  return decidePaperOpen({
    rec: recWith(legs),
    forecastByUnderlying: { '159919': forecast },
    fillsToday: [],
    chainFor: () => undefined,
    marginFor: () => 1000,
    nowIso: '2026-09-15T02:30:09.000Z',
    cash: 100000,
  })
}

describe('explicitLegs 字段兼容（当日真实形态）', () => {
  it('形态一：action + price（10:30 桶 159919 vertical）', () => {
    const result = decide([
      { code: '159919C2609M04700', action: 'buy', ratio: 1, price: 0.0926 },
      { code: '159919C2609M04800', action: 'sell', ratio: 1, price: 0.0352 },
    ])
    expect(result).toMatchObject({ fill: {} })
    if ('fill' in result) {
      expect(result.fill.legs).toEqual([
        { code: '159919C2609M04700', side: 'buy', qty: 1, fillPrice: 0.0926, priceSource: 'pick' },
        { code: '159919C2609M04800', side: 'sell', qty: 1, fillPrice: 0.0352, priceSource: 'pick' },
      ])
    }
  })

  it('形态二：*_to_open + limitPrice + quoteBid/quoteAsk（10:55 桶）', () => {
    const result = decide([
      { action: 'sell_to_open', code: '159919P2609M04800', qty: 1, limitPrice: 0.0777, quoteBid: 0.0777, quoteAsk: 0.0786 },
      { action: 'buy_to_open', code: '159919P2609M04700', qty: 1, limitPrice: 0.0317, quoteBid: 0.0312, quoteAsk: 0.0317 },
    ])
    expect(result).toMatchObject({ fill: {} })
    if ('fill' in result) {
      expect(result.fill.legs.map((l) => `${l.side}:${l.fillPrice}`)).toEqual(['sell:0.0777', 'buy:0.0317'])
    }
  })

  it('形态三：只有盘口 → 买吃 ask、卖吃 bid，来源如实标记', () => {
    const result = decide([
      { code: '159919C2609M04700', action: 'buy', qty: 1, quoteBid: 0.09, quoteAsk: 0.0926 },
      { code: '159919C2609M04800', action: 'sell', qty: 1, quoteBid: 0.0352, quoteAsk: 0.036 },
    ])
    expect(result).toMatchObject({ fill: {} })
    if ('fill' in result) {
      expect(result.fill.legs.map((l) => `${l.side}:${l.fillPrice}:${l.priceSource}`))
        .toEqual(['buy:0.0926:ask', 'sell:0.0352:bid'])
    }
  })

  it('反向：只有 code 没有价格 → no_quote（禁止口算成交价）', () => {
    expect(decide([
      { code: '159919C2609M04700', action: 'buy', qty: 1 },
      { code: '159919C2609M04800', action: 'sell', qty: 1 },
    ])).toMatchObject({ skip: { skip: 'no_quote' } })
  })

  it('反向：方向认不出（未知动作）→ no_quote（不猜方向）', () => {
    expect(decide([
      { code: '159919C2609M04700', action: 'hedge', qty: 1, price: 0.09 },
      { code: '159919C2609M04800', action: 'close', qty: 1, price: 0.03 },
    ])).toMatchObject({ skip: { skip: 'no_quote' } })
  })
})
