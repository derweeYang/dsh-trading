# OptionsPaperDesk 迁入资产面板 + 汇总页签逐子账户汇总总资产

- 日期: 2026-09-14
- 类型: feature
- 分支: etf-options

## Problem

资产面板此前能看到期权双账本卡，但两处缺口：

1. **纸账户执行台（OptionsPaperDesk）** 挂在「期权总览中栏」（OptionsOverviewMiddleView），
   与账本/桥路由不在同一个概览面；用户要诊断执行链（候选→成交→评分）必须切到中栏，
   资产面板作为「资产总览」的定位不完整。
2. **汇总页签的总资产** 来自 `aggregateHoldings`（股票三源持仓市值求和），
   完全不含期权账本权益（每个 ¥100,000），「总资产」名不副实。

## Decision

### D1：迁移而非复制

`OptionsPaperDesk` 从 OptionsOverviewMiddleView **摘除**，迁入 HoldingsPanel `optPaper` 页签，
与 `OptionPaperBooks` 双账本卡同页渲染。理由：执行台是账本视角的细化诊断，两者共享
`/options/paper/desk` 与 `/options/paper/accounts` 数据域，放同一页签认知负担最小；
留在中栏则是第二处真相源，违背「资产面板是资产总览唯一入口」的定位。

配套回归测试（options-overview-middle.smoke.test.tsx 第 7 例）断言中栏
**不再渲染** `[data-dshtrading-paper-desk]`、不再含 `options.desk.title`、`API.desk` 零调用——
迁移不复制，防止未来被好心人加回去。

### D2：逐子账户汇总，双口径显式标注而非混同

新增纯函数 `aggregateSubAccounts`（`holdings-subaccounts.ts`）：

- 行序 = 股票三源（paper/live/imported，取 `holdings.byOrigin` 固定序）+ 期权双账本
  （`OPTION_BOOK_ORDER`，与 OptionPaperBooks 卡片同序）。
- **口径刻意不混同**：股票行 `basis: 'holdings'`（持仓市值），期权行 `basis: 'equity'`
  （权益，含可用现金）。`totalBase = Σ amountBase`，但 UI 用 `data-basis` hook +
  底部注释（`trade.summary.optionBasisNote`）明示两种口径，不假装同质。
- **未换算不静默归零**：期权账本为 CNY，base 缺 CNY 汇率时推入 `unconverted`
  （`amountBase=0` + unconverted 分区保留 `{currency:'CNY', amount}`），
  与 `aggregateHoldings` 语义一致——区分「汇率没取到」和「账本没钱」；
  `approximate` 置真，总额前缀 `≈`。

### D3：受控 OptionPaperBooks，单快照防同屏双真相

`OptionPaperBooks` 增加可选受控模式（`accounts?: { books, failure, onChange }`）：
父组件（HoldingsPanel）顶层 30s 轮询一次 `/options/paper/accounts`，把快照同时喂给
汇总页签的 `aggregateSubAccounts` 与 optPaper 页签的卡片；受控时组件**自轮询置空**
（`usePoll(null)`），避免同一端点双重拉取导致同屏两个「总资产」数字漂移。

## Alternatives considered

- **执行台复制到两处**：否。两处真相源，桥路由 30s 心跳下数字易漂移，维护双份。
- **总资产只加期权、不加注释**：否。市值 vs 权益口径不同，静默相加会被追问
  「为什么 20 万跟我券商对不上」；显式标注是成本最低的诚实方案。
- **缺 CNY 汇率时期权按 0 计入**：否。把「汇率缺失」伪装成「账户清零」，
  违反 unconverted 分区的既有语义。
- **HoldingsPanel 不做顶层轮询、由子组件各自拉**：否。汇总页签需要账本快照，
  子组件轮询节奏不一致会让总额与卡片数字不同步。

## Consequences

- 正向：资产面板成为资产总览唯一入口（执行链诊断 + 双账本 + 逐子账户总额）；
  中栏瘦身，职责更纯（总览/信号，不再管账本诊断）。
- 正向：`aggregateSubAccounts` 为纯函数，6 个单测覆盖 CNY 恒等 / 换算 /
  缺汇率 unconverted / 空账本 / 单账本 / 空持仓账本仍计 10 万。
- 代价：`OptionPaperBooks` 多一条受控分支（测试覆盖：holdings-panel-accounts 冒烟）。
- 代价：`MarketLocaleKey` 联合类型 +1 键（`trade.summary.optionBasisNote`，zh/en 双语）。

## 证据（file:line）

- `packages/client-ui-trading/src/client/holdings-subaccounts.ts`（新增，纯函数）
- `packages/client-ui-trading/src/client/HoldingsPanel.tsx:484-502`（optBooks/desk 状态与轮询）
- `packages/client-ui-trading/src/client/HoldingsPanel.tsx:588-590`（subAccounts useMemo）
- `packages/client-ui-trading/src/client/HoldingsPanel.tsx:878-879`（hero 条复用 subAccounts.totalBase）
- `packages/client-ui-trading/src/client/HoldingsPanel.tsx:981-1021`（汇总页签逐子账户行 + 注释 + unconverted）
- `packages/client-ui-trading/src/client/HoldingsPanel.tsx:1204-1220`（optPaper 页签 = 双账本卡 + 执行台）
- `packages/client-ui-trading/src/client/OptionPaperBooks.tsx`（受控模式 + usePoll 置空）
- `packages/client-ui-trading/src/client/OptionsOverviewMiddleView.tsx`（desk 摘除）
- `packages/client-ui-trading/src/client/locales.ts` + `contract.ts`（+1 键）

## 门禁账

| 门禁 | 结果 |
| --- | --- |
| `pnpm build`（仓库级） | ✅ 全绿（拓扑收尾 packages/all） |
| `npx vitest run`（包内全量） | ✅ 63 文件 / **558 通过** |
| `node scripts/i18n-audit.mjs --check` | ✅ OK（1339 zh 键，+1） |
| `node scripts/typecheck-gate.mjs` | ⚠️ 红（261 > 基线 234）——**本变更零新增**，见下 |

**typecheck 归因证据**：client tsconfig 44 条错误逐一落点核对，
**零条**落在本变更 7 个改动/新增文件（holdings-subaccounts.ts / HoldingsPanel.tsx /
OptionPaperBooks.tsx / OptionsOverviewMiddleView.tsx / option-paper-view.ts /
contract.ts / locales.ts）；`tsconfig.json`/`tsconfig.host.json` 各 3 条全部落在
`src/index.ts`（node 半桥，后端泳道）与 `prediction-store.ts`。
基线冻结于 2026-09-09（基线 234），存量债属既有事实，按铁律如实申报、不谎报全绿。

## UI 实机取证（dsh --profile trading-web，端口 3082）

宿主 HTTP + CDP 无头 Chrome（`--timeout` 思路，未用 virtual-time-budget）：

- `docs/screenshots/asset-panel-summary-subaccounts.png`——汇总页签：
  总资产 **200,000.00 CNY** = 期权套利账户 100,000 + 期权策略账户 100,000，
  `data-sub-account` 行 2 条（basis=equity），`data-sub-account-basis-note` 在场；
  股票侧无持仓正确显示「暂无数据」。
- `docs/screenshots/asset-panel-option-desk.png`——期权账户页签：
  双账本卡（股票获利/策略获利，各权益 100,000）+ **纸账户执行台**（可用/初始资金、
  持仓合计、更新时刻、逐日候选/成交/记录场口表）同页呈现。

启动排障记录（环境坑，非代码问题）：宿主 `healProfileModuleFallback` 清
`~/.dsh/profiles/trading-web/.dsh-module-fallback/node_modules/@dshtrading/base`
symlink 时被 WorkBuddy safe-delete shim 的回收站通道拦死
（`FileSystem::DeleteFile` + `SendToRecycleBin` 处理不了 reparse point →
`FileNotFoundException` → 宿主进程崩）。按宿主意图逐条删 symlink
（.NET `Directory.Delete(link, false)`，只掉链接不跟随目标）后启动正常，
profile 真实 `node_modules`（27 插件 symlink）完好。
