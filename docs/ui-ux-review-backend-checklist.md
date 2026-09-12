# 页面操作流程复盘 · 后端任务清单（仅登记，不执行）

> 来源：2026-09-12 全页面操作流程复盘（前端实测截图 + 代码审查）。
> 分工纪律：WorkBuddy（本助手）只做前端（`client-ui-trading/src/client/**` + `index.ts` 壳接线）；
> 后端 / 桥部分（`lib/`、`packages/api`、connector/kit/bundle、`python/**`、client-ui 的 node 半桥）
> 只登记，不执行，归 Cursor/Claude 会话完成。
> 对应前端已落地/待做项的 file:line 见 `.workbuddy/memory/2026-09-12.md` 与本文档「关联」列。

## 后端待办（2026-09-12 Cursor 已落地，见 bug-fix note）

### B1 · 定时任务服务在 ledger 锁冲突时优雅降级 ✅
- **现象**：`SessionRail` 时钟按钮常驻，打开后面板红字「定时任务服务不可用」。
- **根因**：`packages/client-ui-trading/lib/tasks/service.js:28` 构造 `TradingTasksService` 时
  `TasksLedger.acquireLock` 抛 `LedgerLockedError`（另一存活宿主持锁）→ 抛到 fiber 构造，
  整个服务不可用，UI 无可用性信号。
- **要求**：服务构造失败改为「可用性=false」而非抛错；暴露 `isAvailable()`/availability 事件，
  供 UI 禁用入口 + tooltip（前端 P0-1 配套）。
- **关联**：前端 `SessionRail.tsx:100-109`、`ScheduledTasksPanel.tsx`。

### B2 · 暴露稳定的「打开设置」宿主 API ✅
- **现象**：前端 `index.ts:98-106` 用 `document.querySelector("div:has(> [data-shell-overlay]) > div:nth-child(1) [aria-haspopup='dialog']").click()`
  程序化点击宿主隐藏设置触发器，实测有时点不开、甚至误折叠侧栏。
- **根因**：宿主未向插件暴露稳定的设置打开服务/事件，前端被迫走脆弱 DOM hack。
- **要求**：宿主（@deepseek-ai/dsh）或本仓库桥暴露 `openSettings()` 服务或 window 事件；
  前端改用之（前端 P0-2 配套）。若宿主当前无此能力，登记为上游能力缺口。
- **关联**：前端 `index.ts:98-106`、`MarketDock.tsx:143-153`。

### B3 ·（可选）定时任务 ledger 多宿主隔离 ✅
- **现象**：本机同时跑多个 trading-web 宿主时 ledger 锁互斥，第二个宿主任务服务直接挂。
- **要求**：ledger 锁按 profile 隔离或支持只读降级；非阻塞主流程。
- **关联**：`packages/client-ui-trading/lib/tasks/ledger.js`。

## 明确判定为「纯前端、本助手已处理/将处理」的项（不进后端）
- 盘口缺数据降级（P0-3）、行情二级 tab 记忆（P1-3）、期权 T 板直达 tab（P1-1）、
  下单入口增强（P1-2）、期权总览空态聚合（P2-8）、预测 track 轮询（P2-9）、
  知识库/策略与标的关联（P1-4）。均无后端契约新增，桥面已具备。
