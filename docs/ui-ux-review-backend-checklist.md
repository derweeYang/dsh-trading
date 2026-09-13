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

## 前端项状态（WorkBuddy 侧，与上列后端项解耦后逐个收口）

后端 B1/B2 落地前被阻塞的两项，已随 B1/B2 完成而解除阻塞并收口：

- ✅ **P0-1 定时任务入口可用性信号**：`SessionRail` 时钟按钮按
  `GET /tasks/availability` 门控（`available:false` → 禁用 + title 说明原因）；
  `ScheduledTasksPanel` 出只读横幅（`writable:false` = 另一宿主持锁）并禁用全部写动作。
  探测**失败按未知处理（fail-open）**——旧 node 半无此路由是常态，不能据此把入口打死。
- ✅ **P0-2 稳定「打开设置」通道**：浏览器半改为**宿主服务 → 契约 window 事件 → DOM 触发器**
  三级降序（`src/client/open-settings.ts` 编排 + `api.ts:requestOpenSettings`，1.2s 超时护栏）。
  DOM 触发器仅在上游仍缺 API 时兜底——这才是原先「有时点不开、甚至误折叠侧栏」的病根位置。

其余纯前端项（无后端契约新增，桥面已具备）：

- ✅ 盘口缺数据降级（P0-3）、行情二级 tab 记忆（P1-3）、期权 T 板直达 tab（P1-1）、
  下单入口增强（P1-2）、期权总览空态聚合（P2-8）、预测 track 轮询（P2-9）。
- ⏳ 知识库/策略与标的关联（P1-4）——涉及跨包（`client-ui-knowledge`/`client-ui-strategies`
  由其它包注册视图），需先做联动评估再动。

