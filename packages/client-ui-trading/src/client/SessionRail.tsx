/**
 * 会话竖条（2.9）：右缘常驻功能栏，参考同花顺式右侧竖排工具栏。
 *
 * - 永不隐藏：折叠只收会话列轨道（fold-store → shell-pad.css 规则 9），
 *   竖条始终占住右缘 44px（shell-pad.css 规则 8 预留的侧栏轨道），会话
 *   进行中也在——取代 2.8「右上浮动簇 + 会话头内联按钮」双入口。
 * - 结构自上而下：折叠/展开、新会话、分隔线、功能页签（定时任务、资产）；
 *   设置入口 3.0 起迁往左侧自选面板底部（MarketDock），竖条不再承载。
 * - 功能页签 = 对话列容器的切换页签：激活时对话列内容被隐去（shell-pad.css
 *   规则 11/12），面板原位覆盖同一列——与对话非并排、同一容器二选一；
 *   状态走 body[data-dshtrading-*] 联动。定时任务（3.0）与资产面板
 *   （2026-09-05）互斥：同一条轨道同时只容一个覆盖面。
 * - 资产面板开关走 holdings-store 的 holdingsPanelStore（共享单例）：
 *   QuoteStage 下单成功后 setHoldingsPanelOpen(true) 跨树联动打开。
 * - 折叠态同步 body[data-dshtrading-chat-folded] 的 effect 从旧 WindowChrome
 *   移入本组件（竖条恒挂载，单一同步点）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FoldStore } from './fold-store.ts'
import { holdingsPanelStore, setHoldingsPanelOpen } from './holdings-store.ts'
import { IconClock, IconFoldPanel, IconNewSession, IconWallet } from './icons.tsx'
import { ScheduledTasksPanel } from './ScheduledTasksPanel.tsx'
import { HoldingsPanel } from './HoldingsPanel.tsx'
import { fetchTasksAvailability, type TasksAvailability } from './tasks-api.ts'
import { usePoll } from './usePoll.ts'
import type { FillComposerFn } from './fill-composer.ts'
import css from './session-rail.module.css'

/**
 * 可用性探测周期（P0-1）：只在定时任务面板**收起**时跑——面板打开时它自己带
 * reload 轮询，这里再探一次是重复请求。锁冲突可能由另一个宿主随时释放/获取，
 * 30s 足够跟上，又不会给本地桥添负担。
 */
const TASKS_AVAILABILITY_POLL_MS = 30_000

export interface SessionRailInjected {
  startNewSession(): void
  toggleFold(): void
  /** 定时任务执行历史「打开会话」（官方 sessions 通路，index.ts 注入）。 */
  openSession(sessionId: string): void
  /** 会话输入框填入入口（资产面板「导入持仓」只填不发；index.ts 注入）。 */
  fillComposer?: FillComposerFn | undefined
  hooks: { folded: FoldStore }
}

export type SessionRailProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<SessionRailInjected>

export function SessionRail({ t, useFolded, startNewSession, toggleFold, openSession, fillComposer }: SessionRailProps) {
  const folded = useFolded(value => value)
  // 定时任务页签（功能页签 1 号）：会话级开关（无需持久化——每次进来默认收起）。
  const [tasksOpen, setTasksOpen] = useState(false)
  // 资产面板（功能页签 2 号）：开关在共享 store（QuoteStage 下单联动），
  // 本组件是渲染点与 rail 页签入口；与定时任务互斥（同一容器二选一）。
  const holdingsOpen = useSyncExternalStore(holdingsPanelStore.subscribe, holdingsPanelStore.getSnapshot)

  useEffect(() => {
    document.body.dataset.dshtradingChatFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingChatFolded }
  }, [folded])

  useEffect(() => {
    document.body.dataset.dshtradingTasksOpen = tasksOpen ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingTasksOpen }
  }, [tasksOpen])

  useEffect(() => {
    document.body.dataset.dshtradingHoldingsOpen = holdingsOpen ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingHoldingsOpen }
  }, [holdingsOpen])

  // 互斥联动：资产面板打开 → 收定时任务；定时任务打开 → 收资产面板。
  useEffect(() => {
    if (holdingsOpen) setTasksOpen(false)
  }, [holdingsOpen])

  /**
   * 定时任务可用性（P0-1）：`null` = 未知（**未探测到 / 探测失败**）。
   *
   * 未知一律按可用处理（fail-open）——把入口禁掉比让用户开出一个空面板更糟；探测失败
   * 通常意味着旧 node 半没有这条路由，不是服务真的不可用。
   */
  const [tasksAvailability, setTasksAvailability] = useState<TasksAvailability | null>(null)

  usePoll(async () => {
    if (tasksOpen) return
    try {
      setTasksAvailability(await fetchTasksAvailability())
    } catch {
      setTasksAvailability(null)
    }
  }, TASKS_AVAILABILITY_POLL_MS, [tasksOpen])

  const tasksUnavailable = tasksAvailability !== null && !tasksAvailability.available

  const toggleTasks = (next: boolean): void => {
    setTasksOpen(next)
    if (next) setHoldingsPanelOpen(false)
  }

  /**
   * 收起所有覆盖对话列的功能面板（定时任务 / 资产），让对话列重新可见。
   *
   * 必要性（2026-09-14）：shell-pad.css 规则 11/12 在面板激活时把对话列第 2 轨的
   * 直接子节点全部 `display:none !important`，由 fixed 面板原位覆盖。不先收面板
   * 就建会话/切会话，会话其实建了但用户看不见——表现为「点了没反应」。原先只有
   * 定时任务走 toggleTasks(false)，资产面板开着时点「新会话」正好漏掉这一路。
   */
  const revealConversation = (): void => {
    setTasksOpen(false)
    setHoldingsPanelOpen(false)
  }

  return (
    <div className={css.rail} data-dshtrading-rail="" role="toolbar" aria-orientation="vertical">
      <button
        type="button"
        className={css.button}
        aria-pressed={folded}
        aria-label={folded ? t('chat.expand') : t('chat.fold')}
        title={folded ? t('chat.expand') : t('chat.fold')}
        onClick={toggleFold}
      >
        <IconFoldPanel size={16} />
      </button>
      <button
        type="button"
        className={css.button}
        aria-label={t('entry.new')}
        title={t('entry.new')}
        onClick={() => { revealConversation(); startNewSession() }}
      >
        <IconNewSession size={16} />
      </button>
      {/* 功能页签扩展位：分隔线下方（注释见 2.9 定稿）；激活时与对话列同容器
          切换（见文件头注），复用 .button 样式保持竖条节奏。 */}
      <div className={css.divider} aria-hidden="true" />
      {/* 服务整个不在时禁用入口 + 用 title 说明原因（P0-1）：原先按钮永远可点，
          点开却是一句「定时任务服务不可用」的红字——把失败提前到入口上。 */}
      <button
        type="button"
        className={css.button}
        aria-pressed={tasksOpen}
        aria-label={tasksUnavailable ? t('tasks.unavailable') : t('tasks.open')}
        title={tasksUnavailable ? t('tasks.unavailable') : t('tasks.open')}
        data-unavailable={tasksUnavailable ? 'true' : undefined}
        disabled={tasksUnavailable}
        onClick={() => { toggleTasks(!tasksOpen) }}
      >
        <IconClock size={16} />
      </button>
      <button
        type="button"
        className={css.button}
        aria-pressed={holdingsOpen}
        aria-label={t('trade.holdings.panel.open')}
        title={t('trade.holdings.panel.open')}
        onClick={() => { setHoldingsPanelOpen(!holdingsOpen) }}
      >
        <IconWallet size={16} />
      </button>
      {tasksOpen && (
        <ScheduledTasksPanel
          t={t}
          openSession={(sessionId) => { revealConversation(); openSession(sessionId) }}
          close={() => { toggleTasks(false) }}
        />
      )}
      {holdingsOpen && (
        <HoldingsPanel
          t={t}
          fillComposer={fillComposer}
          onClose={() => { setHoldingsPanelOpen(false) }}
        />
      )}
    </div>
  )
}
