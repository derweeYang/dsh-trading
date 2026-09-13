/**
 * options-sources：期权总览页数据源聚合判定（P2-8，2026-09-12）纯逻辑契约。
 *
 * 判定优先级是这页「只出一条通知」的前提，锁死它才能保证聚合文案不因来源顺序漂移。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateOptionsSources,
  firstOptionsSourceFailure,
  optionsSourcePhaseOf,
  type OptionsSourceProbe,
} from '../src/client/options-sources.ts'

function probe(over: Partial<OptionsSourceProbe> = {}): OptionsSourceProbe {
  return { loaded: true, failure: null, snapshot: true, hasRows: true, ...over }
}

describe('optionsSourcePhaseOf', () => {
  it('分诊链与子组件同序：失败 > 加载 > 未提供 > 空集 > 有数据', () => {
    expect(optionsSourcePhaseOf(probe({ failure: { code: 'X', message: 'boom' } }))).toBe('failed')
    expect(optionsSourcePhaseOf(probe({ loaded: false }))).toBe('loading')
    expect(optionsSourcePhaseOf(probe({ snapshot: false }))).toBe('unavailable')
    expect(optionsSourcePhaseOf(probe({ hasRows: false }))).toBe('empty')
    expect(optionsSourcePhaseOf(probe())).toBe('data')
  })

  it('失败优先于「未落地」（同时成立时报失败，不把错误说成加载中）', () => {
    expect(optionsSourcePhaseOf(probe({ loaded: false, failure: { code: 'X', message: 'boom' } }))).toBe('failed')
  })
})

describe('aggregateOptionsSources', () => {
  it('任一条有数据 → data（不聚合，部分可用不被掩盖成整页空）', () => {
    expect(aggregateOptionsSources([
      probe(),
      probe({ failure: { code: 'CYCLE_DOWN', message: 'down' } }),
    ])).toBe('data')
    expect(aggregateOptionsSources([
      probe({ failure: { code: 'OVERVIEW_DOWN', message: 'down' } }),
      probe(),
    ])).toBe('data')
  })

  it('全无数据 → 取优先级最高的非数据态（failed > loading > unavailable > empty）', () => {
    expect(aggregateOptionsSources([
      probe({ failure: { code: 'A', message: 'a' } }),
      probe({ loaded: false }),
    ])).toBe('failed')
    expect(aggregateOptionsSources([
      probe({ loaded: false }),
      probe({ hasRows: false }),
    ])).toBe('loading')
    expect(aggregateOptionsSources([
      probe({ snapshot: false }),
      probe({ hasRows: false }),
    ])).toBe('unavailable')
    expect(aggregateOptionsSources([
      probe({ hasRows: false }),
      probe({ hasRows: false }),
    ])).toBe('empty')
  })

  it('空入参按 empty 处理（无数据源可判 ⇒ 无数据）', () => {
    expect(aggregateOptionsSources([])).toBe('empty')
  })
})

describe('firstOptionsSourceFailure', () => {
  it('返回首个失败源原文（摆在人话下面做诊断）；无失败源返回 null', () => {
    expect(firstOptionsSourceFailure([
      probe({ failure: { code: 'OVERVIEW_DOWN', message: 'gateway down' } }),
      probe({ failure: { code: 'CYCLE_DOWN', message: 'loop down' } }),
    ])).toEqual({ code: 'OVERVIEW_DOWN', message: 'gateway down' })
    expect(firstOptionsSourceFailure([probe(), probe()])).toBeNull()
  })
})
