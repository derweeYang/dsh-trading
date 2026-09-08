# Agent Note: 期权升格为对等双透镜 + ETF 现货/期权互联（前端，workbuddy）

Status: implemented

## Problem

上一期（[2026-09-08-cn-etf-options-t-board-ui.md](./2026-09-08-cn-etf-options-t-board-ui.md)）
把期权做成了 `QuoteStage` 的**第六个次级页签**，且只在标的命中期权名册时才出现——
非 ETF 的普通 A 股根本看不到它。这导致两个产品问题：

1. **期权不突出**：埋在「图表 | 基本面 | 期权 | 新闻 | 公告」里，权重视觉权重与 A 股
   现货严重不对等，违背「期权与 A 股交易同等重要」的产品定位。
2. **ETF 现货 ↔ 期权零互联**：T 板是只读的，既不能回看标的 ETF、也不能交易现货，
   选中的合约也无下单通路——期权分析与 ETF 现货交易是两条断裂的链路。

按[前后端分工](../process/2026-09-08-frontend-backend-agent-split.md)，界面半由 workbuddy
完成；期权下单的 node 半桥（`POST /trade/order` 接 connector-options）属后端范围，
本次不在前端越界，改用「查看标的 / 交易现货 / 把合约发给 Agent 下单」三路联动打通。

## Decision

**对带期权的 ETF 引入「现货 ⇄ 期权」对等双透镜，期权不再埋在次级页签里。**

改动全部落在 `packages/client-ui-trading/src/client/`：

1. **一级双透镜（`QuoteStage.tsx`）**：新增 `lens` 状态（`'spot' | 'options'`），
   `activeLens = optionsAvailable ? lens : 'spot'`。报价头在价格/涨跌后渲染
   `lensToggle` 胶囊组（现货 | 期权），与次级下划线页签视觉区分；期权与 A 股现货
   平级。次级 `stageTabs`（图表/基本面/新闻/公告）在期权透镜下整体隐藏。
2. **期权透镜即一级视图**：渲染链首条件 `activeLens === 'options'` 直接挂
   `OptionsStage`（不再是 `viewTab === 'options'` 次级分支），删去旧期权页签按钮。
3. **ETF ↔ 期权互联（`OptionsStage.tsx` + `QuoteStage.tsx`）**：
   - 顶部联动操作条「标的 ETF」chip → `onViewSpot` 回现货透镜（切 chart）；
   - 「交易现货 ETF」→ `onTradeSpot` 打开现货交易台（`setTradeDeskOpen(true)`，预填该 ETF）；
   - T 表任意一档（认购/认沽）可点选为待下单合约（`selectedLeg`），「将合约发给 Agent 下单」
     经 `fillComposer` 把合约要素（标的/认购认沽/行权价/最新价/IV）交给 Agent 评估下单
     （dry-run 优先）。前端即把期权下单链路与现货交易打通，不碰后端。
4. **locale / 样式**：`contract.ts` + `locales.ts`（zh/en）新增 `lens.*`、`options.underlying`、
   `options.viewSpot`、`options.tradeSpot`、`options.sendLegToAgent`、`options.legSelected`、
   `options.side.call/put`、`options.spotLinkHint`；`quote-stage.module.css` 加 `.lensToggle/.lensTab`
   胶囊样式，`options-stage.module.css` 加联动条与可点选合约单元样式。

## Implementer note（踩坑）

- **oxc 解析坑**：JSX 表达式里 `cond ? ( ... )` 的分组 `( ... )` 内若放 `{/* ... */}`
  JSX 注释，oxc 会把那对 `{` `}` 当成 JS 块而非 JSX 注释，导致后续 `<div>` 报
  `Expected ',' or ')' but found 'Identifier'`。修复：删除该内联 JSX 注释（说明已写入
  文件头 docstring），分支内不再放 JSX 注释。
- 把 `onSendLegToAgent` 的内联箭头（含嵌套模板字符串）抽成 `sendLegToAgent` 局部常量，
  既避开解析器嵌套怪癖，也提升可读性。

## Verification

- `pnpm --filter @dshtrading/client-ui-trading build`：node 半 + client 半均 ✔ 通过。
- `pnpm --filter @dshtrading/client-ui-trading test`：307 passed / 35 files ✔。
- 视觉验证建议走 `trading-web` profile + 无头 Chrome 截图（AGENTS.md UI 验证手法），
  选中 510050/510300 等带期权 ETF，确认「现货 ⇄ 期权」胶囊与联动条。

## Follow-ups（后端范围，非本次）

- `connector-options` 接 `POST /trade/order` 后，「发给 Agent 下单」可升级为直连期权下单
  （或 Agent 经现有桥下单），无需前端再改。
- 期权透镜可加「ETF 期权概览条」（ATM IV / 最活跃合约）回链到现货透镜，进一步双向化。
