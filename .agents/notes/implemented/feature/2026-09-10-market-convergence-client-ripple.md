# Agent Note: 市场收敛涟漪清偿（client 半：settings / strategies / trading）+ 策略解读强类型化

Status: implemented

## Problem

后端 `remove crypto/us/hk market slices`（`e2b76f9`）与 `cn` preset 收敛后，中心化
provider 词汇表只剩六源（`packages/router/src/index.ts:57-64`：tencent/eastmoney/
tushare/akshare/**iquant**/hithink，cn 默认 `iquant`）。但前端三个包仍停在四市场形态，
与交接单 A2 / B.5 / spec §1f §2c 的 client 半清单不符：

1. **设置面板（用户可见死 UI）**：`client-ui-settings` 仍注册 crypto/us/cn/hk 四个市场
   tab；provider 目录 21 条里有 4 条纯 crypto、多条 us/hk-only、**保留后端已删的 `qmt`
   （MiniQMT）**、**缺默认源 `iquant`**；CryptoPanic key 是随 crypto 市场一起消失的死设置。
   即：cn 面板里能看到选不中的 provider，而真正生效的 iQuant 无法在 GUI 里选。
2. **残留词汇**：`client-ui-strategies/StrategyView.tsx:98` 兜底 `'crypto'` / `'BTCUSDT'`；
   `client-ui-trading` 的 toolview 四市场注册与正则、`OrderPanel` 稳定币单位分支、
   `holdings` 默认基准币 `USD`。
3. **`StrategyExtras` 宽容类型**：WB-9 时为「后端尚未投影 logic/playbook」加的兼容层，
   后端 2026-09-09 已给 `OptionOverviewStrategy` 补上 `logic?` / `playbook?`
   （`packages/api/src/index.ts:477-480`），兼容层已成冗余。

## Decision

只动 `packages/client-ui-*/src/client/**`（+ 本包 client 半测试），不碰桥 / api / kit：

- **settings**：`MARKET_TABS` 收敛为 cn 单 tab（order 0）；`PROVIDER_LABELS` 重写为
  六条 cn 源、iquant 置首且标 gateway；`PROVIDER_CREDENTIAL_SPECS` 只留
  iquant/tushare/akshare/hithink（tencent/eastmoney 免密故无凭证面）；
  **整删 CryptoPanic 链路**（`TradingSettings.news` / `state.newsKey` / `newsOverridden` /
  `setNewsKey` / `resetNewsKey` / 面板 news 区块 / 对应 CSS）——crypto 市场已不在，
  留着只是让用户去配一个没有任何消费方的 key。
- **词典**：删 `market.crypto/us/hk`、14 条非 cn provider 键与它们的凭证字段键、
  4 条 news 键；加 `provider.iquant` / `field.label.iquantUrl` / `field.placeholder.iquantUrl`；
  zh/en 同步。`market.cn` 文案改为「中国 A 股 / ETF 期权」以覆盖期权主场景。
- **strategies**：兜底改 `'cn'` / `'600519'`（与 watchlist cn 种子同词汇）。
- **trading**：toolview 只注册 `cn_place_order`、`ORDER_TOOL_RE` 收敛 `^cn_place_order$`；
  `resolveAssetUnit` 恒返回「股」（cn 无币本位标的），随之删除孤儿键 `trade.unit.coin`；
  `DEFAULT_HOLDINGS_BASE_CURRENCY` 改 `CNY`、`HOLDINGS_BASE_CURRENCIES` CNY 置首，
  `fetchFx` 未知 base 回落从 USD 改 CNY（USD/HKD 保留作历史台账多币种显示）。
- **option-insight**：删 `StrategyExports`／`StrategyExtras` 与 `strategyExtras()`，
  改私有 `strategyText()` 直读强类型 `row.strategy.logic` / `.playbook`
  （空白串视作缺席，语义与旧宽容层一致）。

## Alternatives considered

- **只删 tab、保留 21 条 provider「以备复辟」**：面板仍列出选不中、也没连接器注册的
  条目，比删掉更误导；且 router 是开放词汇，第三方连接器自注册即上榜，无需预置。败。
- **保留 CryptoPanic 只是隐藏**：设置 schema 与状态里仍有一个无消费方的字段，
  属于「死设置」而非「暂不展示」。败。
- **默认基准币留 USD 以兼容历史台账**：台账行本身带 currency，基准币只是汇总口径；
  cn-only 下默认用美元汇总会把人民币盈亏按 USD 基准再折一次。败。
- **`strategyText` 保留导出并写单测**：内部 helper 无外部消费点，通过 `composeReading`
  / `composePlan` 的行为测试覆盖即可（已补空白串回落两例）。败。

## Consequences

- 设置面板只剩一个「中国 A 股 / ETF 期权」tab，六个 provider 与 router 词汇表一一对应，
  iQuant（默认源）可被显式选择/回退。
- 基准币默认 CNY 是**行为变更**：`holdings-aggregate.test.ts` 的原 `expect(agg.base)
  .toBe('USD')` 已同步为 `CNY` 并注明原因。浏览器里旧键存过 USD 的用户不受影响（显式值保留）。
- 门禁：`client-ui-trading` 44 文件 / 396 测试全绿；settings 6 测试、strategies 17 测试全绿；
  `typecheck-gate` 总错误 232 < 基线 234（删代码顺带降了 2）。
- 未做：trading-web profile 真机冒烟（宿主侧流程未变，需停宿主 → refresh 脚本 → 重启），
  本轮改动集中在设置面板，冒烟优先级低于前面的期权主线。
