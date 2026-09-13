# Agent Note: WB-14 检测到的期权机会并入实时总览页（前端消费侧）

Status: implemented

- 关联任务：数据聚合见 `data/options/opportunities-summary.json` + `docs/option-opportunities-overview.html`（2026-09-13 离线交付）。
- 后端待办：见 `docs/backend-handoff-2026-09-13.md` 任务 #11（加 `OptionOverview.opportunities`，bridge/kit-cn 聚合 `recommendations/*.jsonl`）。

## Problem
领航员要求「将发现检测到的所有期权交易机会，汇总到期权总览中」。离线聚合已产出 9 条去重机会
（2 已定价 / 7 未定价），但要并进**实时总览页** `OptionsOverview.tsx`（只读展示后端 `overview.json`），
存在分工边界：UI（`src/client/**`）归 WorkBuddy，后端数据层（`@dshtrading/api` / bridge / kit-cn）归 Cursor/Claude。
后端 `overview.opportunities` 字段当时尚未落地（task #11 pending），前端不能等后端才动工。

## Decision
前端**提前把消费侧做完**——定义本地视图模型类型 + cast 透传 `overview.opportunities`，后端一发货零改动渲染：
1. **i18n 键**（`contract.ts` `MarketLocaleKey` 联合类型 + `locales.ts` 中/英字典）：新增 `options.detected.*` 共 18 键
   （title/hint/edge/logic/playbook/invalid/disclaimer/expandMore/collapse/bucket/sell/buy/struct/
   netCredit/maxLoss/breakeven/legs/unpriced）。字典文件豁免 CJK 扫描，中文文案落在 `locales.ts`。
2. **新组件** `src/client/OptionsDetectedOpportunities.tsx`：定义 `DetectedOpportunity/DetectedPick/DetectedLeg`
   + `OverviewDetectedShape`；渲染一节标题 + 9 张机会卡（卡头含标签/标的/检测桶/定价状态徽章）+ 四段
   （钱在哪/可证伪假设/操作计划/失效条件，取自 `edgeZh/logicZh/playbookZh/invalidIfZh` 运行时 JSON）+ 已定价标的的
   腿表与风险指标（净权利金/最大亏损/盈亏平衡）。未定价只出状态徽章 + 「须经实时预填闸门」提示，**不编造价位**。
3. **接线** `OptionsOverview.tsx`：导入新组件；`const detected = (overview as OverviewDetectedShape | null)?.opportunities`；
   在机会卡之后、明细表折叠按钮之前渲染 `<OptionsDetectedOpportunities t={t} opportunities={detected} />`。
   后端字段缺省时 `detected` 为 `undefined`，组件整体返回空片段，**不整页空白、不影响现有门禁**。
4. **CSS** `options-overview.module.css`：新增 `.detected*` 系列类（复用既有 `.section/.metrics/.blocker/.sourceBadge` 等）。
5. **冒烟测试** `test/options-overview.smoke.test.tsx`：新增 describe 锁「无 opportunities 不渲染」「有则渲染检测区/定价腿表/未定价闸门提示」。

## Alternatives considered
- **A. 直接读 `recommendations/*.jsonl` 前端自己聚合**：违反交接单（前端只读，重复打上游 + 口径漂移），否。
- **B. 等后端字段落地再写组件**：拖慢交付；选当前方案——本地视图模型 + cast，解耦前后端节奏。
- **C. 中文文案写死在组件**：触发 i18n 审计 `scanCjk`（源码 CJK 字符串字面量被禁）；故全部走 `t(key)`，
  仅数据字段（`edgeZh`/status/code）以运行时变量渲染（审计只扫字面量，不扫变量值）。

## Consequences
- 前端 100% 就绪：后端 task #11 把 `opportunities` 加进 `OptionOverview` 并聚合后，前端自动渲染，零改动。
- 门禁：`pnpm --filter @dshtrading/client-ui-trading build` 绿｜`npx vitest run` **503/503** 通过（含新增 2 case）｜
  `node scripts/i18n-audit.mjs --check` OK **1238** keys（新增 18 键中/英键值对齐 + 占位符）。
- 类型棘轮门禁：当前全仓红（client 44>33 等，基线 2026-09-09 存量债），本变更**零新增**——
  `tsc --noEmit -p tsconfig.client.json` 报错文件仅 `index.ts/HomeHistory.tsx/TvChart.tsx/...`，
  不含 `OptionsDetectedOpportunities.tsx/OptionsOverview.tsx/contract.ts/locales.ts`（grep 验证）。
- 风险：视图模型字段名须与后端 task #11 约定对齐（见 handoff 文档 11.3）；后端改字段名需同步改本组件解构。
- 不擅自改后端代码（AGENTS.md 分工）；后端 task #11 仅登记，待 Cursor/Claude 泳道执行。
