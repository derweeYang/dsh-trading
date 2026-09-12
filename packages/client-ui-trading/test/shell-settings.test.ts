import { describe, expect, it } from 'vitest'
import {
  OPEN_SETTINGS_EVENT,
  describeOpenSettingsCapability,
  tryInvokeHostOpenSettings,
} from '../src/shell-settings.ts'

describe('openSettings 宿主能力面', () => {
  it('登记稳定事件名与上游缺口（宿主无 open 服务时）', () => {
    const cap = describeOpenSettingsCapability({})
    expect(cap.ok).toBe(true)
    expect(cap.event).toBe(OPEN_SETTINGS_EVENT)
    expect(cap.event).toBe('dshtrading:open-settings')
    expect(cap.capability).toBe('event')
    expect(cap.hostService).toBeNull()
    expect(cap.upstreamGap).toBe(true)
  })

  it('探测到宿主 settings.open 则声明可调用', () => {
    const cap = describeOpenSettingsCapability({
      settings: { open() { /* host */ } },
    })
    expect(cap.capability).toBe('host-service')
    expect(cap.hostService).toBe('settings.open')
    expect(cap.upstreamGap).toBe(false)
  })

  it('tryInvokeHostOpenSettings：有服务则调用，无服务返回 unsupported', () => {
    const calls: string[] = []
    expect(tryInvokeHostOpenSettings({ settings: { open() { calls.push('open') } } })).toEqual({
      ok: true,
      invoked: true,
      via: 'settings.open',
    })
    expect(calls).toEqual(['open'])
    expect(tryInvokeHostOpenSettings({})).toEqual({
      ok: false,
      invoked: false,
      via: null,
      event: OPEN_SETTINGS_EVENT,
      code: 'SETTINGS_OPEN_UNSUPPORTED',
    })
  })
})
