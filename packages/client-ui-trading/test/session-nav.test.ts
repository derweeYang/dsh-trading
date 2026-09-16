/**
 * 会话导航兜底纯函数测试（2026-09-14）。
 *
 * 起因：右缘竖条「新会话」与宿主「开始 AI 对话」点了没反应。根因之一是
 * `(ctx.get('uiWorkspace') as … | undefined)?.startSession()` 的可选链——服务
 * 缺席时整句静默跳过，用户零反馈、控制台零日志。apply() 全链路 mock 成本过高
 * （slots/locale/sessions/reflect 十余个面），故把解析与兜底抽成纯函数在此覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_NAV_UNAVAILABLE, resolveSessionNav, startSessionOrWarn } from '../src/client/session-nav.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveSessionNav', () => {
  it('宿主提供合格 uiWorkspace → 返回该面', () => {
    const nav = { startSession: () => {} }
    expect(resolveSessionNav(() => nav)).toBe(nav)
  })

  it('缺席 / null / 非对象 / 缺 startSession 一律 undefined 且不抛错', () => {
    // fail-open 的辅助面：抛错会让整个 slot 渲染崩溃，比「建不了会话」严重得多。
    expect(resolveSessionNav(() => undefined)).toBeUndefined()
    expect(resolveSessionNav(() => null)).toBeUndefined()
    expect(resolveSessionNav(() => 42)).toBeUndefined()
    expect(resolveSessionNav(() => ({ startSession: 'not-a-function' }))).toBeUndefined()
  })
})

describe('startSessionOrWarn', () => {
  it('正常路径：发起一次导航，返回 true 且不打扰用户', () => {
    const startSession = vi.fn()
    const warn = vi.fn()
    const ok = startSessionOrWarn(() => ({ startSession }), warn)
    expect(ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('服务缺席：提示用户并返回 false——不再静默 no-op', () => {
    const warn = vi.fn()
    const ok = startSessionOrWarn(() => undefined, warn)
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(SESSION_NAV_UNAVAILABLE)
  })

  it('startSession 抛错：记日志 + 同样提示，不留一个永远无反应的死按钮', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warn = vi.fn()
    const ok = startSessionOrWarn(
      () => ({
        startSession() {
          throw new Error('host signature changed')
        },
      }),
      warn,
    )
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(SESSION_NAV_UNAVAILABLE)
    expect(warnSpy).toHaveBeenCalled()
  })
})
