/**
 * 期权长代码解析测试（2026-09-14）。
 *
 * 用例取当日真实合约代码（`data/options/recommendations/2026-09-14.jsonl` 里
 * 13:45 桶推荐的腿），确保解析口径与线上数据一致，而不是自造格式。
 */
import { describe, expect, it } from 'vitest'
import { parseOptionCode } from '../src/option-code.js'

describe('parseOptionCode', () => {
  it('解析当日真实 call 腿 159915C2609M03300', () => {
    expect(parseOptionCode('159915C2609M03300')).toEqual({
      underlying: '159915',
      optionType: 'C',
      expiryMonth: '2609',
      strike: 3.3,
    })
  })

  it('解析当日真实 call 腿 159915C2609M03400（行权价 3.4）', () => {
    expect(parseOptionCode('159915C2609M03400')).toMatchObject({ strike: 3.4 })
  })

  it('认沽腿 P 与上证 50 合约同样可解析', () => {
    expect(parseOptionCode('510050P2609M02850')).toEqual({
      underlying: '510050',
      optionType: 'P',
      expiryMonth: '2609',
      strike: 2.85,
    })
  })

  it('非合约代码一律 undefined 且不抛错：现货腿 / 空值 / 位数不符', () => {
    // 现货腿 code 是 6 位 ETF 代码；解析不出时调用方按缺参处理，不能中断开仓决策。
    expect(parseOptionCode('510050')).toBeUndefined()
    expect(parseOptionCode(undefined)).toBeUndefined()
    expect(parseOptionCode('')).toBeUndefined()
    expect(parseOptionCode('510050C2609M0285')).toBeUndefined()
    expect(parseOptionCode('not-an-option')).toBeUndefined()
  })
})
