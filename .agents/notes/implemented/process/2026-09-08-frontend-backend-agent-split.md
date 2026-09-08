# Agent Note: 前端归 workbuddy，后端归 Cursor / Claude

Status: implemented

## Problem

ETF 期权第一期同时要做只读分析内核和 CN 行情页 T 型报价板。若同一会话里
Cursor / Claude 既改连接器又改 `QuoteStage`，会和并行的 workbuddy 前端任务
抢同一批 client 文件，契约也容易在 UI 里就地发明。需要一条全仓可见的分工，
而不是只留在某次对话里。

旧协作习惯记在已归档的
[owner-collaboration-mode](../../archived/process/2026-08-30-owner-collaboration-mode.md)
（归档区冻结，不改原文）。本记录是 2026-09-08 起的现行分工。

## Decision

**界面 / client 半由 workbuddy 完成；后端由 Cursor 与 Claude 完成。**

| 侧 | 执行方 | 范围 |
|---|---|---|
| 前端 | workbuddy | `packages/client-ui-*/src/client/**`：React 页签与组件、CSS、词典 UI 文案、浏览器半 fetch 装配 |
| 后端 | Cursor / Claude | `@dshtrading/api`、connector / kit / bundle / router、`python/**`、client-ui 的 **node 半桥**（`/dshtrading/api/*` 路由）、Agent 工具与 skill、spike 证据 |

交接面是稳定的 JSON 契约：后端先落地类型 + 桥路由（例如
`GET /dshtrading/api/options/chain`），workbuddy 再挂 T 型报价板。
Cursor / Claude 不实现 `OptionsStage`、不改 QuoteStage 页签条。

本分工从 ETF 期权第一期开始执行，后续含 UI 的功能默认沿用，直到 owner
另写记录取代。

## Alternatives considered

- **同一 agent 做通前后端**：落选——owner 已指定 workbuddy 做前端；继续改
  `src/client` 会双写冲突。
- **只写进某次聊天 / Cursor 用户记忆、不入库**：落选——Claude 与新会话读不到；
  本仓非平凡流程必须进 Agent Note，并在 AGENTS.md 留一条指针。
- **改归档的 owner-collaboration-mode**：落选——`archived/` 永久冻结。

## Consequences

- AGENTS.md Development Workflow 增加「前后端任务分工」条目；Cursor 规则
  `.cursor/rules/frontend-backend-split.mdc`（alwaysApply）同步约束 IDE 会话。
- ETF 期权第一期：Cursor / Claude 只做 `tradingCnOptions`、Python 内核、
  kit-cn 工具、桥路由与符号词汇；T 板 UI 留给 workbuddy。
- 需要两边一起改时，后端先交缝、停住，并写明 workbuddy 该挂的路由与类型。
