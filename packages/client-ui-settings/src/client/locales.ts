/**
 * client-ui-settings client 词典（纯数据模块：零运行时依赖）。
 *
 * 单一来源：本包 client apply 注册 zh/en（typed register 编译期校验键位）；
 * packages/dsh-i18n 语言包构建期 import 本模块注册 zh-CN；scripts/i18n-audit.mjs
 * 静态加载本模块做 zh/en 键对齐与占位符对齐门禁。
 */
/**
 * dshtrading.settings locale keys（单一来源 = locales.ts zh 块；contract/locale-keys.ts
 * 据此 augment LocaleNamespaceMap，PropsLocale 落 t 座位）。
 */
export type SettingsLocaleKey =
  | 'nav'
  | 'lead'
  | 'tabs'
  | 'empty'
  | 'save'
  | 'discard'
  | 'saved'
  | 'saveFailed'
  | 'current'
  | 'default'
  | 'custom'
  | 'colorMode.label'
  | 'colorMode.redUp'
  | 'colorMode.greenUp'
  | 'market.cn'
  | 'credential.btn'
  | 'credential.btnFold'
  | 'credential.configured'
  | 'credential.notConfigured'
  | 'credential.save'
  | 'credential.delete'
  | 'credential.saved'
  | 'credential.deleted'
  | 'credential.saveFailed'
  | 'credential.deleteFailed'
  | 'type.public'
  | 'type.gateway'
  | 'type.commercial'
  | 'field.action.hide'
  | 'field.action.show'
  | 'provider.docsLink'
  | 'provider.envPrefix'
  | 'provider.tencent'
  | 'provider.eastmoney'
  | 'provider.tushare'
  | 'provider.akshare'
  | 'provider.iquant'
  | 'provider.hithink'
  | 'field.label.apiKey'
  | 'field.label.token'
  | 'field.label.apiUrl'
  | 'field.label.iquantUrl'
  | 'field.placeholder.tushareToken'
  | 'field.placeholder.akshareUrl'
  | 'field.placeholder.iquantUrl'

export const zh: Record<SettingsLocaleKey, string> = {
      'nav': '交易',
      'lead': '选择每个市场使用的数据/交易所提供方。行情面板保存即生效；Agent 会话于新建会话生效（切换不中断当前会话）。',
      'tabs': '市场',
      'empty': '没有可配置的市场。',
      'save': '保存',
      'discard': '放弃',
      'saved': '已保存',
      'saveFailed': '保存失败',
      'current': '当前：{provider}',
      'default': '默认',
      'custom': '自定义（{provider}，由第三方连接器提供）',
      'colorMode.label': '涨跌配色',
      'colorMode.redUp': '红涨绿跌（国内习惯）',
      'colorMode.greenUp': '绿涨红跌（国际习惯）',
      'market.cn': '中国 A 股 / ETF 期权',
      'credential.btn': '配置 API 凭证',
      'credential.btnFold': '收起配置',
      'credential.configured': '已配置凭证',
      'credential.notConfigured': '未配置',
      'credential.save': '保存凭证',
      'credential.delete': '清除/删除凭证',
      'credential.saved': 'API 凭证已保存',
      'credential.deleted': 'API 凭证已删除',
      'credential.saveFailed': '凭证保存失败',
      'credential.deleteFailed': '凭证清除失败',
      'type.public': '免密公共源',
      'type.gateway': '本地网关',
      'type.commercial': '商业 API',
      'field.action.hide': '隐藏',
      'field.action.show': '显示',
      'provider.docsLink': '官方指引与文档',
      'provider.envPrefix': '环境变量：',
      'provider.tencent': '腾讯 (Tencent)',
      'provider.eastmoney': '东方财富 (Eastmoney)',
      'provider.tushare': 'Tushare Pro',
      'provider.akshare': 'AkShare (宏观/另类量化)',
      'provider.iquant': '国信 iQuant（默认行情源）',
      'provider.hithink': '同花顺问财 (Hithink)',
      'field.label.apiKey': 'API Key',
      'field.label.token': 'Pro Token',
      'field.label.apiUrl': 'HTTP 服务地址',
      'field.label.iquantUrl': 'iQuant 行情网关地址',
      'field.placeholder.tushareToken': 'TUSHARE_TOKEN',
      'field.placeholder.akshareUrl': 'http://127.0.0.1:8080 (默认内置)',
      'field.placeholder.iquantUrl': 'http://127.0.0.1:5810 (默认内置)',
}

export const en: Record<SettingsLocaleKey, string> = {
      'nav': 'Trading',
      'lead': 'Choose the data/exchange provider for each market. Quote panels take effect immediately; agent sessions pick it up in new sessions (running sessions are not interrupted).',
      'tabs': 'Markets',
      'empty': 'No configurable markets.',
      'save': 'Save',
      'discard': 'Discard',
      'saved': 'Saved',
      'saveFailed': 'Save failed',
      'current': 'Current: {provider}',
      'default': 'default',
      'custom': 'Custom ({provider}, provided by a third-party connector)',
      'colorMode.label': 'Price Color Scheme',
      'colorMode.redUp': 'Red Up / Green Down (Chinese)',
      'colorMode.greenUp': 'Green Up / Red Down (International)',
      'market.cn': 'China A-shares / ETF options',
      'credential.btn': 'Configure API Credentials',
      'credential.btnFold': 'Hide Configuration',
      'credential.configured': 'Configured',
      'credential.notConfigured': 'Not Configured',
      'credential.save': 'Save Credentials',
      'credential.delete': 'Clear / Delete Credentials',
      'credential.saved': 'API Credentials saved',
      'credential.deleted': 'API Credentials cleared',
      'credential.saveFailed': 'Failed to save credentials',
      'credential.deleteFailed': 'Failed to clear credentials',
      'type.public': 'Public source',
      'type.gateway': 'Local gateway',
      'type.commercial': 'Commercial API',
      'field.action.hide': 'Hide',
      'field.action.show': 'Show',
      'provider.docsLink': 'Official docs & guides',
      'provider.envPrefix': 'Env var: ',
      'provider.tencent': 'Tencent',
      'provider.eastmoney': 'Eastmoney',
      'provider.tushare': 'Tushare Pro',
      'provider.akshare': 'AkShare (macro / alt-data)',
      'provider.iquant': 'Guosen iQuant (default market data)',
      'provider.hithink': 'Hithink (Wencai)',
      'field.label.apiKey': 'API Key',
      'field.label.token': 'Pro Token',
      'field.label.apiUrl': 'HTTP endpoint',
      'field.label.iquantUrl': 'iQuant quote gateway URL',
      'field.placeholder.tushareToken': 'TUSHARE_TOKEN',
      'field.placeholder.akshareUrl': 'http://127.0.0.1:8080 (built-in default)',
      'field.placeholder.iquantUrl': 'http://127.0.0.1:5810 (built-in default)',
}
