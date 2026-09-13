# Agent Note: 定时任务入口可用性门控与只读降级（前端 P0-1）

Status: implemented

## Problem

2026-09-12 全页面操作流程复盘的 P0-1：`SessionRail` 的时钟按钮**永远可点**，点开后拿到的
却是一句红字「定时任务服务不可用」（`tasks.loadFailed`）。

后端 B1 之前，`TradingTasksService` 构造时 `TasksLedger.acquireLock` 抛 `LedgerLockedError`
（另一存活宿主持锁）→ 整个服务不可用。B1 落地后新增 `GET /tasks/availability`，语义变成三态：

| availability | 含义 | 期望 UI |
|---|---|---|
| `available:true, writable:true, mode:'exclusive'` | 全功能 | 入口可用，面板可写 |
| `available:true, writable:false, mode:'readonly'` | ledger 被另一存活宿主持锁 | 入口可开，**面板标只读 + 禁改动** |
| `available:false, mode:'unavailable'` | 服务整个不在 | **入口禁用 + 说明原因** |

前端两处都没跟上：入口不看可用性（用户点进去才被拒），面板也不看 `writable`（只读态下
「新建/停用/运行/编辑/删除」全是可点的，点下去必然失败——而失败理由不解释「为什么」）。

## Decision

**1. `tasks-api.ts` 新增 `TasksAvailability` + `fetchTasksAvailability()`**（前端半，桥封装）。

**2. `SessionRail` 按可用性门控入口。**

- `usePoll(30s, deps:[tasksOpen])`：**面板收起时**才探测（面板开着时它自己带 reload 轮询，
  这里再探一次是重复请求）；tab 不可见时 `usePoll` 自动停。
- `available:false` → 按钮 `disabled` + `data-unavailable='true'` + `title` 改为
  `tasks.unavailable`（把「为什么不能点」放到悬停即可见处）。

**3. `ScheduledTasksPanel`：只读横幅 + 全部写动作禁用。**

- 只读时渲染 `[data-dshtrading-tasks-readonly]` 横幅（`role=status`）：人话（`tasks.readonly`）
  ＋ 后果（`tasks.readonlyHint`）＋ **原始 reason 留痕**（等宽小字，排查是哪个宿主持锁）。
- 禁用写动作：新建、启停排期、确认权限、立即运行、编辑、删除；**保留「查看历史」**——
  只读不等于把面板变死。
- `TaskEditor` 新增 `readonly` prop：保存按钮禁用 + `save()` 入口短路。正常情况下入口已被禁用，
  这一步是兜住状态竞态（面板先以可写渲染、`availability` 随后才落地为只读）。

**4. 探测失败一律按「未知」处理（fail-open）——这是本变更最关键的取舍。**

- 可用性面**单独取**（不与快照/元数据同 `Promise.all`）：否则旧 node 半没有这条路由时，
  整个面板会被打成 `loadFailed`——用一个辅助信号毁掉主功能。
- 回执失败 → `availability = null` → 按**可写**处理，不出横幅、不禁按钮。
  理由：探测不到 ≠ 不可用；把能用的打成不能用，比偶尔多一次失败点击严重得多。

## Alternatives considered

- **入口一探测失败就禁用**：表面「安全」，实际是拿最常见的场景（旧 node 半 / 桥抖动）
  换最严重的回归（功能被无理由锁死）。不取。
- **只禁用入口、面板不管只读**：`available:true, writable:false` 是最常见的降级态
  （双宿主同时开着），恰恰是面板最需要表态的场景——漏掉它等于漏掉主要病例。不取。
- **只读时连「查看历史」也禁**：历史是纯读，禁掉无收益且让用户连查都查不了。不取。
- **把 availability 并入 reload 的 `Promise.all`**：见 Decision 4，会连累主功能。不取。
- **只读横幅改用 `tasksError` 的红色样式**：只读是**降级**不是**故障**（服务活着、数据可读），
  红色会把「能用的面板」渲染成「坏了」；用 amber 提示色 + 辅助小字。

## Consequences

- 服务整个缺席时入口不可点并说明原因；只读降级时面板自解释且写动作不可误触。
- 新建 i18n 键 3 个：`tasks.unavailable` / `tasks.readonly` / `tasks.readonlyHint`（zh/en 全量）。
- 新增 `session-rail.module.css`：`.tasksReadonly` / `.tasksReadonlyReason` /
  `.button[data-unavailable='true']`（含 `:disabled` 通用降级）。**注意** `:disabled` 规则是
  全局生效的（本该如此，竖条上其余按钮目前无 disabled 用法）。
- 回归护栏 `test/scheduled-tasks-panel.smoke.test.tsx`（4 条 jsdom；该组件此前**零渲染覆盖**）：
  只读 → 横幅含 hint 与原始 reason 且 5 个写按钮全禁用、历史按钮仍可用；
  探测失败 → 无横幅且按钮可用（fail-open）；`exclusive` → 无横幅按钮可用；
  快照失败不连累可用性（横幅仍按 availability 渲染）。
- 门禁账：包构建绿；`npx vitest run` **493/493（56 文件）**绿；i18n OK（**1178 zh keys**）。
  类型棘轮门禁 `scripts/typecheck-gate.mjs` 仍红（client 44 > 基线 33），但**本变更零新增**：
  所改文件（`SessionRail.tsx` / `ScheduledTasksPanel.tsx` / `tasks-api.ts`）无一条类型错误，
  超基线项全部是基线（2026-09-09）之后累积的存量债与并行会话未提交的 node 半改动。
