# Agent Note: 全 tab 常驻交易台入口（下单入口增强）

Status: implemented

## Problem

2026-09-12 全页面操作流程复盘的 P1-2：**下单入口仅在行情页存在**。

交易台（`QuoteStage` 右侧 `OrderPanel`，dry-run + 只读查询）的开关键 `trade.toggle` 长在
`QuoteStage` 的行情工具栏里（`QuoteStage.tsx` toolbarActions），而 `tradeDeskOpen` 是
`QuoteStage` 的**组件内 state**。中栏 `stageViews` 互斥挂载（切走即卸载），于是：

- 停在「期权总览 / 期权预测 / 期权 T 板 / 策略 / 知识库」任一 tab 时，页面上不存在任何
  下单/交易台入口——用户看到分析结论后无从下手，必须自己先切回「行情」tab 再找工具栏按钮；
- 更糟的是**没有可发现性**：工具栏按钮只在行情视图中出现，其它 tab 的用户不知道它存在。

## Decision

**1. 交易台开关抽成模块级共享 store（`trade-desk-store.ts`）。**

- 形态与 `chat-width-store` 同款：懒单例 `tradeDeskStore()` + `writeTradeDeskOpen()` +
  `toggleTradeDesk()`，底层 `createObservable<boolean>`。
- **沿用旧持久化键与旧格式**（`dshtrading.tradeDesk.open` = `'1'`/`'0'`），不重置用户已有偏好；
  存储访问走 `try/catch + 裸 localStorage`（同 `store.ts` 的 `readJson/writeJson`），node 测试
  环境 / 隐私模式下静默降级。
- `QuoteStage` 由组件内 `useState` + 局部 `read/write` 函数改为
  `useSyncExternalStore(tradeDeskStore().subscribe, tradeDeskStore().getSnapshot)`；三处写入点
  （paper 模式自动开、工具栏取反、面板 onClose、T 板「交易现货」）改走 store。

**2. `MiddleStage` 的 tab 条右侧新增全 tab 常驻「交易台」动作按钮。**

- `onTradeDeskEntry()`：**已在行情视图** → `toggleTradeDesk()` 就地取反；**在其它 tab** →
  `requestQuoteLens('spot')` → `writeTradeDeskOpen(true)` → `switchView('quote')`。
- 顺序是硬约束：交易台渲染在行情视图的**现货透镜**分支，而 `QuoteStage` 是切视图时新挂载的
  ——透镜请求必须先于 `switchView` 写入，否则 `useState` 初值消费不到该请求、落回 `spot` 之外
  （与期权总览 `onPickRow` 的「进 T 板」同款纪律，2026-09-11 已踩过）。
- DOM 结构：tab 按钮收进 `role="tablist"` 的内层 `.tabList`，动作按钮作 `role=tablist` 的**兄弟**
  节点（动作按钮不是 tab，混进 tablist 会污染 tab 语义/键盘导航）。
- i18n：新增 `stage.tradeDesk`（zh「交易台」/ en「Trade Desk」，入 `contract.ts` 联合类型）。

## Alternatives considered

- **在期权总览/预测/T 板三个薄壳各自加「下单」按钮**：能覆盖 options 系 tab，但（a）策略/知识库
  两个 tab 由**其它包**（`client-ui-strategies` / `client-ui-knowledge`）注册，改它们要跨包联动；
  （b）同一入口复制 N 份，后续再挂新 tab 又要补。tab 条一处改动即覆盖**全部** tab（含未来新注册的），
  故取 tab 条方案。
- **按视图 id 白名单决定是否显示入口**：贸易台支持「接入了交易注册面的各市场」，行情页现无市场
  门禁；凭空加白名单会引入与现有行为不一致的隐藏逻辑，不做。
- **跨 tab 直接内嵌交易台下单面板（不必切回行情视图）**：交易台需要标的/市场/建议价等行情上下文，
  且「实盘下单唯一通道是 Agent 会话」（铁律 #3，面板只做模拟与只读查询）——把它搬离行情上下文
  既难保证数据正确，也放大安全面。切回行情视图是架构上最小且最安全的路径。
- **复用 `trade.toggle`（「交易」）文案以省一个 i18n 键**：tab 条里「交易」与 tab 名并列易被误认成
  一个 tab，且语义不如「交易台」明确；单独加 `stage.tradeDesk`。

## Consequences

- 中栏 tab 条现为「tab 组（role=tablist） + 右侧交易台入口」，任何 tab（含策略/知识库）都能一键
  拉出交易台；`aria-pressed` 反映 store，跨 tab 保持展开态。
- 交易台开关成为**跨视图共享状态**：切走再切回行情视图不再需要重新开（旧行为下 state 随卸载丢失）。
- 回归护栏（CI 常驻，替代一次性 live 探针）：
  - `test/trade-desk-store.test.ts`（4 条）：旧值 `'1'` 恢复、写入持久化格式、无 localStorage 降级、
    toggle 逐次通知；
  - `test/middle-stage.smoke.test.tsx`（3 条，jsdom）：非行情 tab 下入口仍常驻且 `aria-pressed` 正确、
    点击后**真挂载** `QuoteStage`（不崩）且视图键切 `quote` + 交易台展开、行情视图内点击为就地取反。
  - 注：`MiddleStage` 此前无任何测试覆盖（无 test 引用）；本文件是它的首个渲染面护栏。
- 门禁账：包构建绿；`npx vitest run` **457/457**（49 文件）绿；`pnpm i18n:check` OK（1169 zh keys /
  26 exemptions）。本机 `pnpm test`（pnpm 包装器）仍会被沙箱 safe-delete 守卫拦，直跑 npx 通过。
- 未做 live 探针：本机 trading-web 宿主（3099）当时未运行，按「改动落在共享 tab 条」的风险面，
  以 jsdom 渲染冒烟（真挂载 QuoteStage）替代；如需端到端确认，起宿主后走 AGENTS.md 的
  「宿主 HTTP + 无头 Chrome 截图」流程。
