/**
 * 稳定的「打开设置」契约：优先调用宿主服务；否则登记 window 事件名供浏览器半
 * 派发。@deepseek-ai/dsh 当前未提供 settings.open —— 此时 upstreamGap=true。
 */
export const OPEN_SETTINGS_EVENT = 'dshtrading:open-settings' as const

export interface HostSettingsProbe {
  settings?: { open?: () => void }
  ui?: { openSettings?: () => void }
}

export interface OpenSettingsCapability {
  ok: true
  capability: 'host-service' | 'event'
  hostService: 'settings.open' | 'ui.openSettings' | null
  event: typeof OPEN_SETTINGS_EVENT
  upstreamGap: boolean
}

export function describeOpenSettingsCapability(host: HostSettingsProbe): OpenSettingsCapability {
  if (typeof host.settings?.open === 'function') {
    return {
      ok: true,
      capability: 'host-service',
      hostService: 'settings.open',
      event: OPEN_SETTINGS_EVENT,
      upstreamGap: false,
    }
  }
  if (typeof host.ui?.openSettings === 'function') {
    return {
      ok: true,
      capability: 'host-service',
      hostService: 'ui.openSettings',
      event: OPEN_SETTINGS_EVENT,
      upstreamGap: false,
    }
  }
  return {
    ok: true,
    capability: 'event',
    hostService: null,
    event: OPEN_SETTINGS_EVENT,
    upstreamGap: true,
  }
}

export function tryInvokeHostOpenSettings(host: HostSettingsProbe):
  | { ok: true; invoked: true; via: 'settings.open' | 'ui.openSettings' }
  | { ok: false; invoked: false; via: null; event: typeof OPEN_SETTINGS_EVENT; code: 'SETTINGS_OPEN_UNSUPPORTED' } {
  if (typeof host.settings?.open === 'function') {
    host.settings.open()
    return { ok: true, invoked: true, via: 'settings.open' }
  }
  if (typeof host.ui?.openSettings === 'function') {
    host.ui.openSettings()
    return { ok: true, invoked: true, via: 'ui.openSettings' }
  }
  return {
    ok: false,
    invoked: false,
    via: null,
    event: OPEN_SETTINGS_EVENT,
    code: 'SETTINGS_OPEN_UNSUPPORTED',
  }
}
