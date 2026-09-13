/**
 * 「打开设置」通道编排（前端 P0-2，2026-09-12）。
 *
 * 背景：设置入口一直是本插件最脆弱的一环——宿主没暴露打开设置的服务，前端只能
 * `document.querySelector` 猜宿主 DOM 里的设置按钮（实测宿主 DOM 一变就静默失效，
 * 甚至点错按钮把侧栏折叠了）。后端 B2 落了两个稳定通道（宿主服务探测 + 跨半契约
 * 事件名），本模块把「先稳定通道、后 DOM 兜底」的顺序固定下来并做成可测单元——
 * 顺序一旦颠倒（比如先点 DOM 再问宿主），会出现「宿主要开设置、DOM 又点了一次」的
 * 双开/误动作，这是本模块要防的回归。
 *
 * 编排只依赖注入的副作用函数（不碰 document / window），故纯逻辑可在 node 环境下钉死。
 */
import type { OpenSettingsOutcome } from './api.ts'

/** 实际生效的通道（按稳定性降序）。 */
export type OpenSettingsRoute = 'host' | 'event' | 'dom'

export interface OpenSettingsDeps {
  /** 请求宿主服务（POST /shell/open-settings 的桥封装）。 */
  requestHost(): Promise<OpenSettingsOutcome>
  /** 派发跨半契约事件；返回 true = 有监听者已接管（事件 cancelable，preventDefault 即处理）。 */
  dispatchContractEvent(): boolean
  /** 末位兜底：按选择器找宿主 DOM 触发器并点击（含全失败 toast）。 */
  clickDomTrigger(): void
}

/**
 * 按「宿主服务 → 契约事件 → DOM 触发器」顺序尝试打开设置。
 *
 * 前两条任一成功即**立即返回**，不再往下走：DOM 兜底只在稳定通道确实无法处理时执行。
 */
export async function openSettingsViaStableChannels(deps: OpenSettingsDeps): Promise<OpenSettingsRoute> {
  const result = await deps.requestHost()
  if (result.ok) return 'host'
  if (deps.dispatchContractEvent()) return 'event'
  // 两条稳定通道都不可用才落到 DOM：把缺口原因打出来，避免日后只能从「点了没反应」倒推。
  console.info(
    `[dsh-trading] openSettings: stable channels unavailable (${result.reason}${result.code === undefined ? '' : ' ' + result.code}); falling back to DOM trigger`,
  )
  deps.clickDomTrigger()
  return 'dom'
}
