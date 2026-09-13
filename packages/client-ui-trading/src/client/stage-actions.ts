/**
 * 中栏动作桥（2026-09-09 redesign）：期权总览升格为 MiddleStage 顶部 tab 后，
 * 薄壳视图（OptionsOverviewMiddleView）渲染在 MiddleStage 的插件视图面，只拿到
 * StageViewProps（t + view），拿不到 quote 视图专有的 selectInstrument / fillComposer
 * / 切视图动作。这些动作由 MiddleStage 在挂载时写入本单例，薄壳读取。
 *
 * 另持有多标的聚合快照（期权总览 + 5 分钟闭环共用单一数据源），避免重复打
 * /options/overview：顶部薄壳是唯一 fetch 方，QuoteStage 的 T 板「AI 扫描」从
 * 此处读快照（与 stageViews 单例同款模块级单例模式，同 bundle 内同一实例）。
 */
import { createObservable, type WritableObservable } from './store.ts'
import type { Instrument } from './types.ts'
import type { FillComposerFn } from './fill-composer.ts'
import type { OptionOverview, OptionCycleLoop } from '@dshtrading/api'

export interface StageActions {
  /** 切全局标的（总行进 T 板用）。 */
  selectInstrument?: (instrument: Instrument) => void
  /** 行情上下文 → 会话输入框（扫描预填用）。 */
  fillComposer?: FillComposerFn
  /** 切回 quote 视图（点行进 T 板前置）。 */
  switchToQuote?: () => void
  /** 切到期权总览顶部 tab（T 板「返回总览」用）。 */
  switchToOverview?: () => void
}

/** 行情中栏的双透镜（现货 ⇄ 期权）；期权透镜即 T 板 / 合约面。 */
export type QuoteLens = 'spot' | 'options'

/**
 * 「进 T 板」的目标透镜请求（2026-09-11）：总览点卡要求的是**合约面**，而
 * QuoteStage 的 `lens` 是组件内 state、初始恒 'spot'——总览 ↔ 行情是互斥挂载
 * （同刻只挂一个视图），跨视图的意图带不过去，于是过去点「进 T 板」落在标的
 * K 线上。这里用一个一次性请求承接：总览写入，QuoteStage 挂载即消费并清空，
 * 不在换标的时复活陈旧意图。
 */
let pendingQuoteLens: QuoteLens | null = null
const quoteLensListeners = new Set<(lens: QuoteLens) => void>()

/** 请求目标透镜（写入待消费值 + 通知已挂载的行情视图）。 */
export function requestQuoteLens(lens: QuoteLens): void {
  pendingQuoteLens = lens
  for (const listener of quoteLensListeners) listener(lens)
}

/** 取走待消费请求（取走即清，幂等：二次调用得 null）。 */
export function consumeQuoteLensRequest(): QuoteLens | null {
  const lens = pendingQuoteLens
  pendingQuoteLens = null
  return lens
}

/** 订阅后续请求：行情视图已挂载时也要跟着切透镜。 */
export function subscribeQuoteLens(listener: (lens: QuoteLens) => void): () => void {
  quoteLensListeners.add(listener)
  return () => { quoteLensListeners.delete(listener) }
}

/** 模块级可变容器：MiddleStage 挂载时 setStageActions 写入，薄壳读取。 */
export const stageActions: { current: StageActions } = { current: {} }

export function setStageActions(next: StageActions): void {
  stageActions.current = next
}

/** 多标的聚合快照（期权总览 + 5 分钟闭环共用单一数据源，避免重复打 /options/overview）。 */
export const optionsOverviewStore: WritableObservable<OptionOverview | null> = createObservable<OptionOverview | null>(null)

export interface OptionsCycleLoopState {
  readonly loop: OptionCycleLoop | null
  readonly loaded: boolean
  readonly failure: { code: string; message: string } | null
}

/** 5 分钟闭环快照（顶部薄壳是唯一 fetch 方；QuoteStage T 板 forecast / 降级箱从读）。 */
export const optionsCycleLoopStore: WritableObservable<OptionsCycleLoopState> = createObservable<OptionsCycleLoopState>({
  loop: null,
  loaded: false,
  failure: null,
})
