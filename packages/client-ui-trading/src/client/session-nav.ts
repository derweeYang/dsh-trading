/**
 * 会话导航兜底（2026-09-14）。
 *
 * 背景：`uiWorkspace`（UiWorkspaceService）由 dsh-client-ui-workspace 的 apply 注册，
 * apply 时序不保证（官方 dsh.client.inject 边只加载/预取元数据、「never apply
 * sequencing」），所以只能在点击时惰性解析。旧写法
 * `(ctx.get('uiWorkspace') as … | undefined)?.startSession()` 在服务缺席时是
 * **静默 no-op**——用户点「新会话」或宿主「开始 AI 对话」后界面毫无变化，
 * 只能判定为「点了没反应」，且没有任何日志可归因。
 *
 * 本模块把「解析 + 兜底」抽成纯函数：apply() 全链路需要 mock slots/locale/
 * sessions/reflect 等十余个面，直接为 index.ts 写单测成本过高；纯函数既能被
 * index.ts 一行接线，也能被 node 测试直接覆盖。
 */
/** uiWorkspace 的最小结构面（startSession = 建/复用并打开会话）。 */
export interface SessionNavigation {
  startSession(workspaceId?: string): void
}

/** 服务缺席/未注册时给用户的可见提示（宿主内 toast，非阻断）。 */
export const SESSION_NAV_UNAVAILABLE = '会话入口暂不可用，请刷新页面重试' // i18n-allow: last-resort toast when the host workspace service is unavailable; zh-only UI

/**
 * 惰性解析 uiWorkspace 面。
 *
 * 宿主未提供、或提供了但形状不符（缺 startSession）一律 `undefined`——**不抛错**：
 * 这里是辅助入口，调用方按「拿不到就提示」处理，抛错会让整个 slot 渲染崩溃。
 */
export function resolveSessionNav(get: (name: string) => unknown): SessionNavigation | undefined {
  const nav: unknown = get('uiWorkspace')
  if (nav === null || nav === undefined || typeof nav !== 'object') return undefined
  if (typeof (nav as SessionNavigation).startSession !== 'function') return undefined
  return nav as SessionNavigation
}

/**
 * 建新会话。返回是否真的发起了导航——
 *
 * - 服务缺席 → `warn(SESSION_NAV_UNAVAILABLE)` + `false`（不再静默）；
 * - `startSession()` 同步抛错 → 记 console.warn + 同样提示 + `false`（宿主升级
 *   改签名/内部断言失败时，用户至少知道该刷新，而不是反复点一个死按钮）。
 */
export function startSessionOrWarn(
  get: (name: string) => unknown,
  warn: (message: string) => void,
): boolean {
  const nav = resolveSessionNav(get)
  if (nav === undefined) {
    warn(SESSION_NAV_UNAVAILABLE)
    return false
  }
  try {
    nav.startSession()
    return true
  } catch (error) {
    console.warn('[dsh-trading] startSession rejected:', error)
    warn(SESSION_NAV_UNAVAILABLE)
    return false
  }
}
