/**
 * 期权总览页数据源聚合态（P2-8，2026-09-12）。
 *
 * 中栏「期权总览」tab 由两条独立端点拼成：
 *   ① 七标的聚合总览 `/options/overview`
 *   ② 5 分钟闭环       `/options/cycle-loop`
 * 两条各自会经历 加载中 / 失败 / 未提供 / 空集 四种非数据态，且各自渲染一个灰字通知框。
 * 期权网关未起时两条同时失败 → 页面上叠两个同样的「code: message」框，既噪又不可读
 * （2026-09-12 全页面复盘 P2-8：空态与错误反馈文案不友好）。
 *
 * 本模块把两条的状态收敛成**一个页面级聚合态**：只要两条都没出可用数据，页面出一句人话
 * ＋ 一行原始明细（诊断保留）；任一条有数据则各节自报（部分可用时保留定位信息，不掩盖）。
 * 纯函数、零依赖，便于单测把判定优先级钉死。
 */

export type OptionsSourcePhase = 'data' | 'loading' | 'failed' | 'unavailable' | 'empty'

/** 取数失败原因（桥回执原文）。 */
export interface OptionsSourceFailure {
  code: string
  message: string
}

/** 一条数据源的可判定快照（由薄壳从各自的 loaded / failure / 快照 / 行数推出）。 */
export interface OptionsSourceProbe {
  /** 本轮取数是否已有结论（false = 仍在途）。 */
  loaded: boolean
  /** 取数失败原因（非 null 即失败态，优先于其它判定）。 */
  failure: OptionsSourceFailure | null
  /** 已加载且桥返回了快照（false = 服务未提供 / 未挂载）。 */
  snapshot: boolean
  /** 快照内是否有行（false = 空集）。 */
  hasRows: boolean
}

/**
 * 单条数据源阶段：与两个子组件各自的分诊链同序（失败 → 加载中 → 未提供 → 空集 → 有数据），
 * 保证聚合文案与子组件原本的说法不冲突。
 */
export function optionsSourcePhaseOf(probe: OptionsSourceProbe): OptionsSourcePhase {
  if (probe.failure !== null) return 'failed'
  if (!probe.loaded) return 'loading'
  if (!probe.snapshot) return 'unavailable'
  if (!probe.hasRows) return 'empty'
  return 'data'
}

/**
 * 页面级聚合态：**任一条有数据 → 'data'**（不聚合，各节自报，部分可用不被掩盖）；
 * 全都没数据 → 返回优先级最高的非数据态（failed > loading > unavailable > empty）。
 * 空入参按 'empty' 处理（无数据源可判 ⇒ 无数据）。
 */
export function aggregateOptionsSources(probes: readonly OptionsSourceProbe[]): OptionsSourcePhase {
  const phases = probes.map(optionsSourcePhaseOf)
  if (phases.includes('data')) return 'data'
  if (phases.includes('failed')) return 'failed'
  if (phases.includes('loading')) return 'loading'
  if (phases.includes('unavailable')) return 'unavailable'
  return 'empty'
}

/** 首个失败源的原始明细（摆在聚合通知的人话下面；无失败源返回 null）。 */
export function firstOptionsSourceFailure(probes: readonly OptionsSourceProbe[]): OptionsSourceFailure | null {
  for (const probe of probes) if (probe.failure !== null) return probe.failure
  return null
}
