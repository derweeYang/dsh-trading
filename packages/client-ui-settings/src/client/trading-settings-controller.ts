/**
 * Trading settings controller: a SnapshotStore over the dshtrading namespace
 * view (markets map + provider presence), with the write methods supplied as
 * plain inject fields (官方模式: hooks = 可观察状态, 普通字段 = 写操作)。
 * The Host (dsh-trading/router) owns the namespace and its schema; this
 * controller binds the client settings scope and translates user choices
 * into revision-fenced path mutations.
 */
import type {
  SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

export interface ProviderMeta {
  id: string
  /** 显示名词典键（dshtrading.settings，渲染处 t() 解析）。 */
  label: string
  url?: string
  env?: string
  type: 'public' | 'commercial' | 'gateway'
  markets: readonly string[]
}

/**
 * provider 候选显示名与指引（词典键 + 官网/API Key 申请链接 + 环境变量 + 支持市场）。
 * 市场收敛后与 router PROVIDER_VOCABULARY 一一对应（cn-only 六源，默认 iquant）；
 * 删掉的 crypto/us/hk 源随市场片一并移除（2026-09-10）。
 */
export const PROVIDER_LABELS: readonly Readonly<ProviderMeta>[] = [
  { id: 'iquant', label: 'provider.iquant', url: 'http://127.0.0.1:5810', type: 'gateway', markets: ['cn'] },
  { id: 'tencent', label: 'provider.tencent', url: 'https://finance.qq.com', type: 'public', markets: ['cn'] },
  { id: 'eastmoney', label: 'provider.eastmoney', url: 'https://eastmoney.com', type: 'public', markets: ['cn'] },
  { id: 'tushare', label: 'provider.tushare', url: 'https://tushare.pro/register', env: 'TUSHARE_TOKEN', type: 'commercial', markets: ['cn'] },
  { id: 'akshare', label: 'provider.akshare', url: 'https://akshare.xyz', env: 'AKSHARE_API_URL', type: 'public', markets: ['cn'] },
  { id: 'hithink', label: 'provider.hithink', url: 'https://fuyao.aicubes.cn', env: 'HITHINK_FINANCE_API_KEY', type: 'commercial', markets: ['cn'] },
]

export interface CredentialField {
  key: string
  /** 字段显示名词典键（dshtrading.settings，渲染处 t() 解析）。 */
  label: string
  /** 输入框占位词典键（可缺省；渲染处 t() 解析）。 */
  placeholder?: string
  secret?: boolean
}

export const PROVIDER_CREDENTIAL_SPECS: Record<string, readonly CredentialField[]> = {
  iquant: [
    { key: 'gatewayUrl', label: 'field.label.iquantUrl', placeholder: 'field.placeholder.iquantUrl' },
  ],
  tushare: [
    { key: 'token', label: 'field.label.token', placeholder: 'field.placeholder.tushareToken', secret: true },
  ],
  akshare: [
    { key: 'apiUrl', label: 'field.label.apiUrl', placeholder: 'field.placeholder.akshareUrl' },
  ],
  hithink: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'HITHINK_FINANCE_API_KEY', secret: true },
  ],
}

/** dshtrading namespace 下的值形状（router 侧同步；窄化后的子集契约）。 */
export interface TradingSettings {
  markets: Record<string, { provider?: string; tradeProvider?: string }>
  /** 各提供方 API 凭证。 */
  credentials?: Record<string, Record<string, string>>
  /** 涨跌配色模式：red-up = 红涨绿跌（国内），green-up = 绿涨红跌（国际）。 */
  colorMode?: 'red-up' | 'green-up'
}

/** 组件的可观察状态（SnapshotStore 值）：已解析 value + 覆盖标记。 */
export interface TradingSettingsState {
  status: 'loading' | 'ready' | 'unavailable'
  /** market id → 已解析 provider（undefined = 未解析到）。 */
  resolved: Record<string, string | undefined>
  /** market id → 用户是否覆盖（user 层 presence）。 */
  overridden: Record<string, boolean>
  /** provider id → credentials 字典。 */
  credentials: Record<string, Record<string, string>>
  /** 涨跌配色模式。 */
  colorMode: 'red-up' | 'green-up'
  /** 表单可写（mode=host 且 writable）。 */
  writable: boolean
}

/** 写路径（普通 inject 字段）。 */
export interface TradingSettingsActions {
  setProvider(market: string, provider: string): Promise<void>
  resetProvider(market: string): Promise<void>
  setCredential(provider: string, fields: Record<string, string>): Promise<void>
  deleteCredential(provider: string): Promise<void>
  /** 设置涨跌配色模式。 */
  setColorMode(mode: 'red-up' | 'green-up'): Promise<void>
}

/** 状态转化：从 settings 快照投射为组件的可观察视图。 */
export function projectSnapshot(snap: SettingsScopeSnapshot<TradingSettings>): TradingSettingsState {
  const value = snap.value ?? (snap.base as TradingSettings | undefined)
  const user = (snap.user ?? {}) as { markets?: Record<string, unknown>; credentials?: Record<string, unknown> }
  // 市场键 = value/base/user 的实际键并集（dict 开放：新市场的键出现即进入，无需改码）。
  const marketIds = new Set<string>([
    ...Object.keys(value?.markets ?? {}),
    ...Object.keys((snap.base as TradingSettings | undefined)?.markets ?? {}),
    ...Object.keys(user.markets ?? {}),
  ])
  const resolved: Record<string, string | undefined> = {}
  const overridden: Record<string, boolean> = {}
  const baseMarkets = (snap.base as TradingSettings | undefined)?.markets ?? {}
  for (const marketId of marketIds) {
    // 逐市场 value 优先、base 兜底：value 缺该市场键时（部分合并）仍能解析到实际 provider。
    resolved[marketId] = value?.markets?.[marketId]?.provider ?? baseMarkets[marketId]?.provider
    overridden[marketId] = user.markets?.[marketId] !== undefined
  }

  // 凭证字典
  const credentials = value?.credentials ?? {}

  return {
    status: snap.status,
    resolved,
    overridden,
    credentials,
    colorMode: value?.colorMode === 'green-up' ? 'green-up' : 'red-up',
    writable: snap.writable && snap.mode === 'host',
  }
}

/** 从 settings scope 构建 SnapshotStore（getSnapshot 稳定引用 + subscribe 转发）。 */
export function createTradingSettingsStore(scope: SettingsScope<TradingSettings>): SnapshotStore<TradingSettingsState> {
  let cached: TradingSettingsState = projectSnapshot(scope.getSnapshot())
  return {
    getSnapshot: () => {
      const current = projectSnapshot(scope.getSnapshot())
      // 引用稳定：值未变则复用缓存（bindSnapshotSelector 依赖引用稳定性做浅比较）。
      if (JSON.stringify(current) !== JSON.stringify(cached)) cached = current
      return cached
    },
    subscribe: (listener) => scope.subscribe(listener),
  }
}
