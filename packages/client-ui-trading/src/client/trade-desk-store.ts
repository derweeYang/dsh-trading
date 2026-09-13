/**
 * 交易台开关共享 Store（P1-2，2026-09-12）：过去 tradeDeskOpen 是 QuoteStage 的
 * 组件内 state + 局部持久化（键 dshtrading.tradeDesk.open，值 '1'/'0'），只有行情
 * 视图内能开关交易台 → 非行情 tab（期权总览 / 期权预测 / 期权 T 板 / 策略 / 知识库）
 * 没有下单入口。
 *
 * 抽成模块级懒单例 observable（与 chat-width-store 同款模式）：MiddleStage（tab 条
 * 全局入口，任何 tab 常驻）与 QuoteStage（右侧交易台渲染）读写同一份，跨视图切换时
 * 状态不回退——交易台是否展开由 store 承载，切走再切回行情视图仍是展开态。
 *
 * 缺省关（安全敏感面）：交易台只做模拟与只读查询，实盘下单唯一通道是 Agent 会话
 * （显式 liveTrading + 统一审批闸门）。存储沿用旧键与旧 '1'/'0' 格式，不重置用户偏好。
 * 存储访问走 try/catch + 裸 localStorage（同 store.ts 的 readJson/writeJson）——node
 * 测试环境无该全局时静默降级，隐私模式/无头环境同理。
 */
import { createObservable, type WritableObservable } from './store.ts'

const OPEN_KEY = 'dshtrading.tradeDesk.open'

function readInitial(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    /* 无 localStorage（node 测试 / 隐私模式）→ 安全缺省：关 */
    return false
  }
}

function persist(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    /* 忽略存储异常（内存态仍生效） */
  }
}

let store: WritableObservable<boolean> | undefined

/** 交易台开关 Store（true = 右侧交易台展开）；懒单例，首读 localStorage。 */
export function tradeDeskStore(): WritableObservable<boolean> {
  if (store !== undefined) return store
  store = createObservable<boolean>(readInitial())
  return store
}

/** 写交易台开关并持久化（存储异常静默忽略）。 */
export function writeTradeDeskOpen(open: boolean): void {
  tradeDeskStore().set(open)
  persist(open)
}

/** 取反交易台开关（行情工具栏与 tab 条全局入口共用同一状态）。 */
export function toggleTradeDesk(): void {
  writeTradeDeskOpen(!tradeDeskStore().getSnapshot())
}
