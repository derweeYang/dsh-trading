/**
 * 扫描回执状态机（2026-09-11）。
 *
 * 这组断言锁住的是一条用户可见的契约：**点了必有回执**。过去的写法
 * `void fill(...)` 会把 fill-composer 抛出的四类错误全部丢掉，按钮也无状态变化，
 * 于是「已填入、去输入框按发送」与「根本没填上」在界面上完全同形。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyComposerFailure,
  describeScanFailure,
  failureLocaleKey,
  SCAN_ALL,
  SCAN_FILLED_HOLD_MS,
  scanFailureText,
  scanLabelKey,
  scanPhaseOf,
  type ScanFeedback,
} from '../src/client/scan-feedback.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const t = (key: MarketLocaleKey, _params?: Record<string, unknown>): string => key

describe('classifyComposerFailure', () => {
  it('三类可自愈失败按 fill-composer 的原文归类', () => {
    expect(classifyComposerFailure(new Error('no session available to fill the composer (start a session first)')))
      .toBe('noSession')
    expect(classifyComposerFailure(new Error('conversation service unavailable — cannot fill the composer')))
      .toBe('noComposer')
    expect(classifyComposerFailure(new Error('composer is busy (submission in flight) — try again in a moment')))
      .toBe('busy')
  })

  it('未知失败不外推成可自愈类；非 Error 抛出也能归类', () => {
    expect(classifyComposerFailure(new Error('something else entirely'))).toBe('unknown')
    expect(classifyComposerFailure('boom')).toBe('unknown')
  })
})

describe('describeScanFailure / scanFailureText', () => {
  it('可自愈失败只给结论，不带原始串', () => {
    expect(describeScanFailure(new Error('composer is busy (submission in flight)'))).toEqual({ failure: 'busy' })
  })

  it('未知失败保留原文，由 {detail} 参数露出（不吞错）', () => {
    const failure = describeScanFailure(new Error('socket hang up'))
    expect(failure.failure).toBe('unknown')
    expect(failure.detail).toBe('socket hang up')
  })

  it('词典键落在 options.scan.error.*；unknown 带 detail 参数', () => {
    expect(failureLocaleKey('noSession')).toBe('options.scan.error.noSession')
    const spy = vi.fn((key: MarketLocaleKey, _params?: Record<string, unknown>) => key)
    expect(scanFailureText(spy, { failure: 'busy' })).toBe('options.scan.error.busy')
    expect(spy).toHaveBeenLastCalledWith('options.scan.error.busy')
    scanFailureText(spy, { failure: 'unknown', detail: 'socket hang up' })
    expect(spy).toHaveBeenLastCalledWith('options.scan.error.unknown', { detail: 'socket hang up' })
  })
})

describe('scanPhaseOf / scanLabelKey', () => {
  const feedback: ScanFeedback = { phase: 'filling', target: '510050' }

  it('只对匹配目标回状态：别的按钮在途时不自称在途', () => {
    expect(scanPhaseOf(feedback, '510050')).toBe('filling')
    expect(scanPhaseOf(feedback, '159915')).toBeNull()
    expect(scanPhaseOf(feedback, SCAN_ALL)).toBeNull()
    expect(scanPhaseOf(null, '510050')).toBeNull()
    expect(scanPhaseOf(undefined, '510050')).toBeNull()
  })

  it('三态各有文案；空闲回落调用方给的原文案', () => {
    expect(scanLabelKey('options.overview.scanRow', 'filling')).toBe('options.scan.filling')
    expect(scanLabelKey('options.overview.scanRow', 'filled')).toBe('options.scan.filled')
    expect(scanLabelKey('options.overview.scanRow', 'error')).toBe('options.scan.failed')
    expect(scanLabelKey('options.overview.scanRow', null)).toBe('options.overview.scanRow')
    // 顶栏与行内空闲文案不同，映射不能把它们合并
    expect(scanLabelKey('options.overview.scanAll', null)).toBe('options.overview.scanAll')
  })

  it('成功回执是限时回执，不是常驻状态', () => {
    expect(SCAN_FILLED_HOLD_MS).toBeGreaterThan(0)
    expect(Number.isFinite(SCAN_FILLED_HOLD_MS)).toBe(true)
  })

  it('t 直出键用于断言（与词典解耦的哨兵）', () => {
    expect(t('options.scan.filled')).toBe('options.scan.filled')
  })
})
