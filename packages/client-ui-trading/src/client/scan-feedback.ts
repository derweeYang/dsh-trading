/**
 * 扫描类动作的可见反馈（2026-09-11）。
 *
 * 为什么需要这个模块：期权总览的「扫描标的 / AI 扫描 / 问 AI」都只做一件事——
 * 把 prompt 填进会话输入框（owner 裁决：只填不发）。填成功时页面**本就没有**
 * 别的变化，填失败时过去用 `void fill(...)` 直接把 rejection 丢掉——两种情况下
 * 用户看到的都是「点了没反应」，无法区分「已填入、去输入框按发送」与「根本没填上」。
 *
 * 于是把「这一次点击的结果」显式建模：filling / filled / error 三态 + 目标标识，
 * 按钮据此换标签，错误原因上浮到页面提示。与 `quote.sendSending/sendSent/
 * sendFailed`（QuoteStage 的「发给 Agent」）同一约定，不再两套手感。
 *
 * 纯函数 + 类型，不碰 DOM、不 import 组件，单测直测。
 */
import type { MarketLocaleKey } from './contract.ts'

/** 顶栏「扫描标的」的目标标识（按行扫描用 underlying）。 */
export const SCAN_ALL = '__all__'

export type ScanPhase = 'filling' | 'filled' | 'error'

/** 一次扫描动作的结果；`target` 决定哪个按钮换标签（同刻只有一个目标在途）。 */
export interface ScanFeedback {
  phase: ScanPhase
  target: string
  /** 失败归类（仅 phase='error'）；`unknown` 时配 `detail` 原样带上。 */
  failure?: ComposerFailureCode
  /** 未归类失败的原始信息——不吞错，宁可露出一句英文工程串。 */
  detail?: string
}

/** fill-composer 的四类可预期失败（与 fillComposerWithQuote 的 throw 一一对应）。 */
export type ComposerFailureCode = 'noSession' | 'noComposer' | 'busy' | 'unknown'

/**
 * 归类 composer 预填失败。按 message 子串匹配而不是 `instanceof`：
 * fill-composer 的 reject 是跨包边界抛出的普通 Error，错误类不可靠，
 * 文案（本来就是该模块的对外契约）才是稳定判据。
 */
export function classifyComposerFailure(error: unknown): ComposerFailureCode {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('no session available')) return 'noSession'
  if (message.includes('conversation service unavailable')) return 'noComposer'
  if (message.includes('composer is busy')) return 'busy'
  return 'unknown'
}

/** 失败 → 词典键（unknown 带 {detail} 参数，调用方传 `detail`）。 */
export function failureLocaleKey(failure: ComposerFailureCode): MarketLocaleKey {
  return `options.scan.error.${failure}`
}

/** 归类后的失败展示材料（组件把它翻成文案 / 挂 tooltip）。 */
export interface ScanFailure {
  failure: ComposerFailureCode
  /** 仅 unknown 有：原始信息，原样露出，不吞错。 */
  detail?: string
}

/** reject → 展示材料：可自愈的三类只给结论，未知类把原文带上。 */
export function describeScanFailure(error: unknown): ScanFailure {
  const failure = classifyComposerFailure(error)
  if (failure !== 'unknown') return { failure }
  return { failure, detail: error instanceof Error ? error.message : String(error) }
}

/** 展示材料 → 本地化文案（unknown 用 {detail} 参数）。 */
export function scanFailureText(
  t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string,
  failure: ScanFailure,
): string {
  const key = failureLocaleKey(failure.failure)
  return failure.detail === undefined ? t(key) : t(key, { detail: failure.detail })
}

/** 该目标的当前状态；目标不匹配（别的按钮在途）→ null，保持原标签。 */
export function scanPhaseOf(feedback: ScanFeedback | null | undefined, target: string): ScanPhase | null {
  if (feedback === null || feedback === undefined) return null
  return feedback.target === target ? feedback.phase : null
}

/**
 * 按钮标签：有状态走状态文案，无状态回落各自的动态文案（`idle` 由调用方给，
 * 因为「扫描标的」与「AI 扫描」的空闲文案不同）。
 */
export function scanLabelKey(idle: MarketLocaleKey, phase: ScanPhase | null): MarketLocaleKey {
  if (phase === 'filling') return 'options.scan.filling'
  if (phase === 'filled') return 'options.scan.filled'
  if (phase === 'error') return 'options.scan.failed'
  return idle
}

/** 成功提示只做「我刚把字填进去了」的一次性回执，到点回落空闲态，不常驻。 */
export const SCAN_FILLED_HOLD_MS = 4000
