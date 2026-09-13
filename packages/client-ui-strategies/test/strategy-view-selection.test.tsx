/**
 * 策略视图「当前标的」接线回归（P1-4，2026-09-12）。
 *
 * 钉住的是一个**静默失效**过的接线缺口：`StrategyView` 一直消费可选的 `useSelection`
 * （缺省回落硬编码 `cn / 600519`），但 `apply()` 的注册处**从未把壳下传的标的面透传进去**
 * ——于是视图永远显示 600519，与侧栏选中标的无关，且没有任何报错。
 *
 * 两条边界：
 * - 壳下传标的面 → 视图跟随该标的（不再出现 600519）；
 * - 老壳不下传（版本错配）→ 回落缺省，**不崩、不隐藏 tab**（降级契约，见 stage-views.ts）。
 *
 * 用轻量 ctx 桩跑真实 `apply()`：`ctx.inject` 同步回调，捕获注册 definition，
 * 再渲染它——覆盖「注册 → 渲染」全链，而不是只测组件。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'

import { apply } from '../src/client/index.ts'

const t = (key: string): string => key

/** 桥桩：视图挂载时会拉策略/选股器名册——全部给空集即可。 */
function bridgeStub() {
  return {
    fetchKlines: vi.fn(async () => []),
    fetchCustomStrategies: vi.fn(async () => []),
    fetchSymbols: vi.fn(async () => []),
    subscribeTradingEvents: vi.fn(() => () => { /* unsubscribe */ }),
    fetchCustomScreeners: vi.fn(async () => []),
    fetchStrategyTombstones: vi.fn(async () => []),
  }
}

/** 跑真实 apply()，返回注册项的 render 函数。 */
function captureRegisteredRender(): (props: unknown) => ReactElement {
  const registered: Array<{ render: (props: unknown) => ReactElement }> = []
  const ctx = {
    effect: (fn: () => unknown) => { fn(); return () => { /* dispose */ } },
    locale: { bind: () => t, register: () => { /* dict */ } },
    // apply() 尾部还会注册对话内富卡片 slot（tool.call.toolview）；本测试只关心
    // 视图注册面，slot 面给空实现即可。
    slots: { inject: (_name: string, callback: () => void) => { callback() }, register: () => { /* slot entry */ } },
    inject: (_services: unknown, callback: (scope: unknown) => void) => {
      callback({
        tradingStageViews: { register: (definition: { render: (props: unknown) => ReactElement }) => { registered.push(definition) } },
        tradingBridge: bridgeStub(),
      })
    },
  }
  apply(ctx as never)
  expect(registered).toHaveLength(1)
  return registered[0]!.render
}

/**
 * 把注册项的 render 包成组件再交给 testing-library —— **不能直接调用它**：
 * `render` 内部是 `StrategyView({...})`（普通函数调用），只有被 React 当组件挂载
 * 时才落在渲染期（否则 hooks 直接抛 invalid hook call）。真实链路同款：
 * MiddleStage `const View = definition.render; <View t={t} view={view} />`。
 */
function registeredComponent(useSelection?: unknown): ComponentType {
  const renderRegistered = captureRegisteredRender()
  return function RegisteredView() {
    return renderRegistered({ t, view: 'strategy', ...(useSelection === undefined ? {} : { useSelection }) })
  }
}

afterEach(() => { cleanup() })

describe('策略视图 · 当前标的接线（P1-4）', () => {
  it('壳下传标的面 → 视图显示该标的，且不再出现兜底 600519', async () => {
    const useSelection = (selector: (state: unknown) => unknown) => selector({ instrument: { market: 'cn', symbol: '510050', name: '华夏上证50ETF' } })
    const View = registeredComponent(useSelection)

    const { container } = render(<View />)
    await waitFor(() => { expect(container.textContent).toContain('510050') })
    expect(container.textContent).not.toContain('600519')
  })

  it('老壳不下传（版本错配）→ 回落缺省 600519，视图仍正常渲染（降级契约）', async () => {
    const View = registeredComponent(undefined)

    const { container } = render(<View />)
    await waitFor(() => { expect(container.textContent).toContain('600519') })
  })

  it('无选中标的（instrument=null）→ 同样回落缺省，不崩', async () => {
    const useSelection = (selector: (state: unknown) => unknown) => selector({ instrument: null })
    const View = registeredComponent(useSelection)

    const { container } = render(<View />)
    await waitFor(() => { expect(container.textContent).toContain('600519') })
  })
})
