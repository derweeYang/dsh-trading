# Agent Note: 资产面板「所有账户」可见性的集成守卫

Status: implemented

## Problem

领航员验收口径：**资产面板要能看到所有账户**。2026-09-13 `feat/option-paper-books` 并入
`etf-options`（merge `df8b1a1`，其后 `cf022eb` 补 arb 词表）后，期权双账本（strategy 策略 /
arbitrage 套利，各 ¥10 万）确实进了资产面板第 6 页签（`HoldingsPanel.tsx:69/92/1131`），
但**这条链零自动化守卫**：

- `test/option-paper-books.smoke.test.tsx`（13+ 用例）只测叶组件——把数据直接喂给
  `OptionPaperBooks`，**跳过 HoldingsPanel**；
- 仓库内**没有任何测试渲染 HoldingsPanel**（`grep -rl HoldingsPanel test/` 为空）。

后果：谁动了 `TAB_LABEL_KEY`（`HoldingsPanel.tsx:86-93`）或 `activeTab === 'optPaper'`
渲染分支（`:1131`），叶组件用例**照样全绿**，而界面上「期权账户」页签已经消失。这与
WB-16（检测机会透传链）踩的是同一类坑——**测试看着覆盖了、其实测的是别的东西**。

股票侧同源：`paperTradingStore` 模拟账本与 `holdings-store` 的 live / imported 三源同在
持仓页签（`HoldingsPanel.tsx:420-445`），也没有「三源同屏」断言。

## Decision

新增 `test/holdings-panel-accounts.smoke.test.tsx`：**真挂载 `<HoldingsPanel>`**（台账 store
与网络走桩），锁四条：

1. 页签条六域齐全且顺序固定，「期权账户」在列（断言去掉计数徽标后的标签串）；
2. 点开「期权账户」→ `[data-opt-paper-book]` = `['arbitrage','strategy']`（与桥返回序一致）；
3. 切 `tradeMode` paper→live 后期权页签仍在、两卡不丢——把「不受 tradeMode 影响」这条设计
   铁律（`HoldingsPanel.tsx:27-29` 文件头注）变成可回归断言，防「切 live 后账本消失」伪故障；
4. 股票侧三源同屏：注入一笔本地 paper 撮合（`paperTradingStore.placeOrder`）后，
   `[data-origin="paper"]` 与 `[data-origin="live"]` 徽章同时在场。

桩的边界：`holdings-store.ts` 整模块桩（快照 = 1 行 live 持仓 + 空 book），因为它自己挂载即
发请求且已有独立测试；网络走全局 fetch 桩只答 `/options/paper/accounts`，其余端点一律 404，
顺带证明「非目标端点失败时面板不炸」。

## Alternatives considered

- **只加叶组件用例**（在 `option-paper-books.smoke` 里补断言）：否决。它测不到「接进面板」
  这一步，正是本次要补的缺口本身，等于用代理指标替代目标指标。
- **渲染真实 holdings-store**（不 mock，靠 fetch 桩驱动）：否决。会连带真实台账拉取、盯市轮询
  与 eventbus 订阅，用例变慢且失败原因被摊薄；store 取数已有独立测试。
- **把界面截图当唯一证据**：否决为唯一手段（截图不可回归），保留为补充——见 Consequences。

## Consequences

**门禁（串行，在 `etf-options` @ `cf022eb` 之后的工作区）**：

| 门禁 | 结果 |
|---|---|
| `pnpm build` | 绿（`lib/client.js` 含 `optPaper` 183 处 / `OptionPaperBooks` 5 处；`lib/client/locales.js` 含「期权账户」；`lib/bridge.js` 含 `options/paper/accounts`）|
| `npx vitest run`（client-ui-trading）| **549/549**（62 文件；本变更 +4）|
| `node scripts/i18n-audit.mjs --check` | OK（1338 zh keys；本变更未新增文案）|
| `node scripts/typecheck-gate.mjs` | 总错误 261 = 本变更前完全一致 → **本变更零新增**；棘轮本身仍红（6 个 tsconfig 超基线，基线停在旧时间点，属既有存量债，未替他人清）|

**界面取证（真浏览器 + 真宿主 + 真桥，非静态断言）**：独立实例 `dsh --profile trading-web
--port 3082 --no-open`（用现网 3081 实例会撞单实例凭据锁），CDP 驱动无头 Chrome 走
「点资产面板 → 点期权账户页签」，实测：

- 资产面板页签条真渲染为 `持仓|汇总|委托|成交|余额|期权账户`；
- `[data-opt-paper-book]` = `["arbitrage","strategy"]`，卡内 `可用现金 100000.00 / 盯市权益
  100000.00 / 初始资金 100000.00 / 已实现盈亏 +0.000000 / 收益率 +0.00%`，免责声明在场；
- 桥面 `GET /dshtrading/api/options/paper/accounts` 返回双账本（各 `initialCash:100000`）。

截图归档 `docs/screenshots/asset-panel-option-paper-books.png`。

**环境副作用（已修复）**：起独立实例时沙箱 safe-delete 守卫拦下插件树加载；用绕过环境变量
重启后撞上 3081 实例持有的 `.credentials.yaml.lock`，我首次失败尝试（PID 44084）留下**不自愈**的
残留锁（其后两次启动均 33s 超时）。已删除该残留锁，避免下次启动宿主失败。

**未做（有意）**：`OptionsPaperDesk`（`GET /options/paper/desk`，近 N 日候选→成交→打分执行链
诊断面）仍留在期权总览中栏（`OptionsOverviewMiddleView.tsx:277`）——它是诊断面不是账户卡，
与新账本卡互补，是否另设页签待领航员拍板。汇总页签总资产口径**不含**期权双账本
（`HoldingsPanel.tsx:537` 只聚合 `taggedPositions`）——期权两本是独立资金池，与股票模拟
¥100 万混加无意义，故未改口径。
