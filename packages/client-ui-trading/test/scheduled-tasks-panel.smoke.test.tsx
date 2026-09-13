/**
 * ScheduledTasksPanel 只读降级渲染冒烟（P0-1，2026-09-12）。
 *
 * 本组件此前**零渲染覆盖**。这里钉死可用性门控的两条边界：
 * - `writable:false`（ledger 被另一存活宿主持锁）→ 出只读横幅 + **全部写动作禁用**
 *   （否则用户点下去只会撞一次失败，且失败理由不解释「为什么」）；
 * - 可用性探测**失败**（旧 node 半无此路由）→ 按未知处理、**不得降级**为只读/禁用
 *   （fail-open：探测不到不等于不可用，把能用的打成不能用是更严重的回归）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const API = vi.hoisted(() => ({
  snapshot: vi.fn(),
  meta: vi.fn(),
  availability: vi.fn(),
  action: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('../src/client/tasks-api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/tasks-api.ts')>()
  return {
    ...actual,
    fetchTasksSnapshot: API.snapshot,
    fetchTasksMeta: API.meta,
    fetchTasksAvailability: API.availability,
    postTaskAction: API.action,
  }
})

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, subscribeTradingEvents: API.subscribe }
})

import { ScheduledTasksPanel } from '../src/client/ScheduledTasksPanel.tsx'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { TasksSnapshot } from '../src/client/tasks-protocol.ts'

const t = (key: MarketLocaleKey): string => key

/** 一条带排期的任务（排期在 → 「停用」「编辑」「运行」「删除」四个写按钮都渲染）。 */
const SNAPSHOT: TasksSnapshot = {
  schemaVersion: 1,
  revision: 3,
  sessionDefaultPermission: 'read-only',
  scheduler: { timeZone: 'Asia/Shanghai' },
  tasks: [{
    id: 'task-1',
    title: '盘前观察池',
    prompt: '生成今日观察池',
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
    executions: [],
    schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: 1_750_000_600_000, lastTriggeredAt: undefined },
  }],
}

beforeEach(() => {
  API.subscribe.mockReturnValue(() => { /* unsubscribe */ })
  API.snapshot.mockResolvedValue(SNAPSHOT)
  API.meta.mockResolvedValue({ sessionDefaultPermission: 'read-only', workspaces: [], agentPresets: [] })
  API.action.mockResolvedValue(SNAPSHOT)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** 取全部写动作按钮的禁用态（按文案键定位）。 */
function writeButtons(container: HTMLElement): HTMLButtonElement[] {
  const keys = ['tasks.new', 'tasks.action.disable', 'tasks.action.enable', 'tasks.action.run', 'tasks.action.edit', 'tasks.action.delete']
  return keys
    .map(key => [...container.querySelectorAll('button')].find(button => button.textContent === key))
    .filter((button): button is HTMLButtonElement => button !== undefined)
}

describe('ScheduledTasksPanel 可用性门控（P0-1）', () => {
  it('只读降级：出只读横幅，且全部写动作禁用', async () => {
    API.availability.mockResolvedValue({ available: true, writable: false, mode: 'readonly', reason: 'locked by another live host' })
    const { container, getByText } = render(<ScheduledTasksPanel t={t} openSession={() => { /* noop */ }} close={() => { /* noop */ }} />)

    await waitFor(() => { expect(container.querySelector('[data-dshtrading-tasks-readonly]')).toBeTruthy() })
    const banner = container.querySelector('[data-dshtrading-tasks-readonly]') as HTMLElement
    // 横幅同段拼接：说明（readonly）＋ 为什么点不动（readonlyHint）＋ 原始原因留痕
    expect(banner.textContent).toContain('tasks.readonly')
    expect(banner.textContent).toContain('tasks.readonlyHint')
    expect(banner.textContent).toContain('locked by another live host')

    const writes = writeButtons(container)
    // 4 个写动作 + 新建都必须被禁用（历史查看不禁用）
    expect(writes.length).toBeGreaterThanOrEqual(5)
    for (const button of writes) expect(button.disabled).toBe(true)
    // 只读的「查看历史」仍可用——只读不等于把面板变死
    const history = [...container.querySelectorAll('button')].find(button => button.textContent === 'tasks.action.history') as HTMLButtonElement
    expect(history.disabled).toBe(false)
  })

  it('可用性探测失败 → 未知按可写处理（fail-open，不误判为只读）', async () => {
    API.availability.mockRejectedValue(new Error('404 SHELL_ROUTE_NOT_FOUND'))
    const { container, queryByText } = render(<ScheduledTasksPanel t={t} openSession={() => { /* noop */ }} close={() => { /* noop */ }} />)

    await waitFor(() => { expect(queryByText('tasks.action.run')).toBeTruthy() })
    expect(queryByText('tasks.readonly')).toBeNull()
    for (const button of writeButtons(container)) expect(button.disabled).toBe(false)
  })

  it('exclusive（可写）→ 无横幅、写动作可用', async () => {
    API.availability.mockResolvedValue({ available: true, writable: true, mode: 'exclusive' })
    const { container, queryByText } = render(<ScheduledTasksPanel t={t} openSession={() => { /* noop */ }} close={() => { /* noop */ }} />)

    await waitFor(() => { expect(queryByText('tasks.action.run')).toBeTruthy() })
    expect(queryByText('tasks.readonly')).toBeNull()
    for (const button of writeButtons(container)) expect(button.disabled).toBe(false)
  })

  it('快照失败不连累可用性：横幅仍按 availability 渲染', async () => {
    API.snapshot.mockRejectedValue(new Error('503 TASKS_UNAVAILABLE'))
    API.availability.mockResolvedValue({ available: true, writable: false, mode: 'readonly', reason: 'locked' })
    const { getByText } = render(<ScheduledTasksPanel t={t} openSession={() => { /* noop */ }} close={() => { /* noop */ }} />)

    await waitFor(() => { expect(getByText('tasks.loadFailed')).toBeTruthy() })
    expect(getByText('tasks.readonly')).toBeTruthy()
  })
})
