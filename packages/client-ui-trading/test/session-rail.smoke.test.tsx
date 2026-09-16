/**
 * 右缘会话竖条冒烟（2026-09-14）：「新会话」必须先收起覆盖对话列的功能面板。
 *
 * 实证缺陷：shell-pad.css 规则 11/12 在定时任务 / 资产面板激活时把对话列第 2 轨的
 * 直接子节点全部 `display:none !important`（fixed 面板原位覆盖）。原先「新会话」
 * 只 `toggleTasks(false)`，**没有关资产面板**——资产面板开着时点它，会话其实建了
 * 但对话列仍被盖住，用户看到的就是「点了没反应」。本文件锁住「先收面板再导航」。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'

// 两个覆盖面板都桩掉：它们各自带轮询取数（台账 / 任务执行历史），
// 与本用例无关，且会把全局 fetch 桩的调用次数搅乱。
vi.mock('../src/client/HoldingsPanel.tsx', () => ({ HoldingsPanel: () => null }))
vi.mock('../src/client/ScheduledTasksPanel.tsx', () => ({
  // 留一个可点的「打开会话」入口，用于覆盖 openSession 同一条收面板路径。
  ScheduledTasksPanel: ({ openSession }: { openSession: (sessionId: string) => void }) =>
    createElement('button', {
      'aria-label': 'stub-open-session',
      onClick: () => { openSession('s-9') },
    }),
}))

import { SessionRail, type SessionRailProps } from '../src/client/SessionRail.tsx'
import { setHoldingsPanelOpen } from '../src/client/holdings-store.ts'

/** key 直出翻译：断言用 key 而非文案，与词典解耦。 */
const t = (key: string): string => key

function railProps(overrides: { startNewSession: () => void; openSession: (id: string) => void }): SessionRailProps {
  return {
    t,
    useFolded: (selector: (value: boolean) => unknown) => selector(false),
    startNewSession: overrides.startNewSession,
    toggleFold: () => {},
    openSession: overrides.openSession,
    hooks: { folded: { getSnapshot: () => false, subscribe: () => () => {}, set: () => {}, toggle: () => {} } },
  } as unknown as SessionRailProps
}

function renderRail(overrides: { startNewSession: () => void; openSession: (id: string) => void }) {
  return render(createElement(SessionRail, railProps(overrides)))
}

/** 资产面板开 → body[data-dshtrading-holdings-open] = on（CSS 规则 12 据此隐对话列）。 */
function holdingsFlag(): string | null {
  return document.body.getAttribute('data-dshtrading-holdings-open')
}

beforeEach(() => {
  // 定时任务可用性探测（辅助面）走网络 → 断网桩，探测失败必须 fail-open。
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  setHoldingsPanelOpen(false) // 共享单例显式复位，否则跨用例互相「看见」
})

describe('SessionRail 会话入口与覆盖面板互斥', () => {
  it('资产面板开着点「新会话」→ 先收面板再导航（否则会话建了也看不见）', () => {
    const startNewSession = vi.fn()
    setHoldingsPanelOpen(true)
    const { container } = renderRail({ startNewSession, openSession: vi.fn() })
    expect(holdingsFlag()).toBe('on')

    fireEvent.click(container.querySelector('[aria-label="entry.new"]') as Element)

    expect(startNewSession).toHaveBeenCalledTimes(1)
    expect(holdingsFlag()).toBe('off')
  })

  it('资产面板关着时点「新会话」→ 只导航，面板标记保持 off', () => {
    const startNewSession = vi.fn()
    const { container } = renderRail({ startNewSession, openSession: vi.fn() })
    expect(holdingsFlag()).toBe('off')

    fireEvent.click(container.querySelector('[aria-label="entry.new"]') as Element)

    expect(startNewSession).toHaveBeenCalledTimes(1)
    expect(holdingsFlag()).toBe('off')
  })

  it('不点就不导航：入口存在不等于被触发（防「挂载即调用」回归）', () => {
    const startNewSession = vi.fn()
    renderRail({ startNewSession, openSession: vi.fn() })
    expect(startNewSession).not.toHaveBeenCalled()
  })

  it('定时任务「打开会话」同样先收资产面板', () => {
    const openSession = vi.fn()
    setHoldingsPanelOpen(true)
    const { container } = renderRail({ startNewSession: vi.fn(), openSession })
    expect(holdingsFlag()).toBe('on')

    // 时钟按钮（t('tasks.open') 直出为 key）→ 展开定时任务面板桩
    fireEvent.click(container.querySelector('[aria-label="tasks.open"]') as Element)
    fireEvent.click(container.querySelector('[aria-label="stub-open-session"]') as Element)

    expect(openSession).toHaveBeenCalledWith('s-9')
    expect(holdingsFlag()).toBe('off')
  })
})
