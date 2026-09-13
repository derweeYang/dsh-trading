/**
 * 「打开设置」稳定通道（前端 P0-2，2026-09-12）。
 *
 * 钉死三件事：
 * - **跨半契约事件名不漂移**：client 半不能 import node 半（会把 node 半模块打进浏览器
 *   bundle），事件名只能靠本测试断言两边字面相等；
 * - `requestOpenSettings` 三态解析：宿主服务可用 / 501 上游缺口 / 桥不可达（含 2xx 但协议
 *   异常、请求抛错），后两者对调用方都是「退回 DOM」，但必须分辨得出原因；
 * - **通道顺序**：宿主服务 → 契约事件 → DOM 触发器，前一条成功即停（防止「宿主已开设置又被
 *   DOM 点击开一次」的双开/误动作回归）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPEN_SETTINGS_EVENT, requestOpenSettings } from '../src/client/api.ts'
import { openSettingsViaStableChannels } from '../src/client/open-settings.ts'
import { OPEN_SETTINGS_EVENT as NODE_OPEN_SETTINGS_EVENT } from '../src/shell-settings.ts'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(response: Response | (() => Promise<Response>)): void {
  vi.stubGlobal('fetch', typeof response === 'function' ? vi.fn(response) : vi.fn(async () => response))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('打开设置 · 桥调用（api.ts）', () => {
  it('契约事件名与 node 半字面一致（跨半契约不能 import，只能靠此断言兜底）', () => {
    expect(OPEN_SETTINGS_EVENT).toBe(NODE_OPEN_SETTINGS_EVENT)
  })

  it('宿主服务可用 → ok:true 且带 via', async () => {
    stubFetch(jsonResponse(200, {
      ok: true, capability: 'host-service', hostService: 'settings.open',
      event: OPEN_SETTINGS_EVENT, upstreamGap: false, invoked: true, via: 'settings.open',
    }))
    await expect(requestOpenSettings()).resolves.toEqual({ ok: true, via: 'settings.open' })
  })

  it('501 SETTINGS_OPEN_UNSUPPORTED → unsupported（宿主确实没这个能力，属预期缺口）', async () => {
    stubFetch(jsonResponse(501, {
      ok: false, invoked: false, via: null, event: OPEN_SETTINGS_EVENT, code: 'SETTINGS_OPEN_UNSUPPORTED',
    }))
    await expect(requestOpenSettings()).resolves.toMatchObject({
      ok: false, reason: 'unsupported', code: 'SETTINGS_OPEN_UNSUPPORTED',
    })
  })

  it('路由缺失（404，旧 node 半未重建）→ unreachable 而非 unsupported', async () => {
    stubFetch(jsonResponse(404, { ok: false, code: 'SHELL_ROUTE_NOT_FOUND', message: 'unknown shell route' }))
    await expect(requestOpenSettings()).resolves.toMatchObject({ ok: false, reason: 'unreachable', code: 'SHELL_ROUTE_NOT_FOUND' })
  })

  it('2xx 但 invoked 非 true（协议异常）→ unreachable（不能当成功吞掉）', async () => {
    stubFetch(jsonResponse(200, { ok: true, invoked: false }))
    await expect(requestOpenSettings()).resolves.toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('请求抛错（桥挂起 / 网络断）→ unreachable 且不向上抛', async () => {
    stubFetch(async () => { throw new Error('boom') })
    await expect(requestOpenSettings()).resolves.toMatchObject({ ok: false, reason: 'unreachable', message: 'boom' })
  })
})

describe('打开设置 · 通道顺序（open-settings.ts）', () => {
  function makeDeps(host: Awaited<ReturnType<typeof requestOpenSettings>>, eventHandled: boolean) {
    return {
      requestHost: vi.fn(async () => host),
      dispatchContractEvent: vi.fn(() => eventHandled),
      clickDomTrigger: vi.fn(() => { /* 兜底副作用 */ }),
    }
  }

  it('宿主服务成功 → 走 host，且不再派发事件 / 不点 DOM', async () => {
    const deps = makeDeps({ ok: true, via: 'ui.openSettings' }, false)
    await expect(openSettingsViaStableChannels(deps)).resolves.toBe('host')
    expect(deps.dispatchContractEvent).not.toHaveBeenCalled()
    expect(deps.clickDomTrigger).not.toHaveBeenCalled()
  })

  it('宿主缺口 + 事件有监听者接管 → 走 event，且不点 DOM', async () => {
    const deps = makeDeps({ ok: false, reason: 'unsupported', code: 'SETTINGS_OPEN_UNSUPPORTED' }, true)
    await expect(openSettingsViaStableChannels(deps)).resolves.toBe('event')
    expect(deps.clickDomTrigger).not.toHaveBeenCalled()
  })

  it('两条稳定通道都不行 → 才落到 DOM 触发器', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => { /* 静音 */ })
    const deps = makeDeps({ ok: false, reason: 'unreachable', code: 'HTTP_404' }, false)
    await expect(openSettingsViaStableChannels(deps)).resolves.toBe('dom')
    expect(deps.clickDomTrigger).toHaveBeenCalledTimes(1)
    // 缺口原因必须留痕：否则日后只能从「点了没反应」倒推
    expect(info.mock.calls.flat().join(' ')).toContain('unreachable')
  })

  it('桥不可达（reason=unreachable）同样允许落到 DOM —— DOM 是今日唯一有效路径', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => { /* 静音 */ })
    const deps = makeDeps({ ok: false, reason: 'unreachable', message: 'timeout' }, false)
    await expect(openSettingsViaStableChannels(deps)).resolves.toBe('dom')
    expect(deps.clickDomTrigger).toHaveBeenCalledTimes(1)
  })
})
