# Agent Note: 定时任务锁冲突可用性 + 打开设置契约

Status: implemented

## Problem

全页面操作流程复盘登记后端 B1/B2/B3：多宿主抢同一 `trading-tasks` 账本锁时，`TradingTasksService` 构造抛 `LedgerLockedError`，桥层整服务缺席，UI 只有 503「定时任务服务不可用」、无可用性信号。设置入口没有稳定宿主 API，前端被迫 DOM hack。同 `$DSH_HOME` 多 profile 也互踩一把锁。

## Decision

- **B1**：锁冲突不再让服务构造失败。第二实例降级只读账本；`isAvailable()` / `isWritable()` / `availability()` 暴露 mode。`GET /dshtrading/api/tasks/availability` 始终 200。只读实例不启动 cron/poll，写入仍 503 `TASKS_LEDGER_READONLY`。只读 `dispose` 不摘写者锁。
- **B2**：桥登记 `GET /dshtrading/api/shell/settings` 与 `POST /dshtrading/api/shell/open-settings`。优先调用宿主 `settings.open` / `ui.openSettings`；当前 @deepseek-ai/dsh 无此服务时 `upstreamGap: true`，稳定事件名 `dshtrading:open-settings` 留给浏览器半。不改 `src/client/**`。
- **B3**：默认账本路径改为 `$DSH_HOME/trading-tasks/<profile>/ledger-v1.json`（`DSH_PROFILE` / `DSH_TRADING_PROFILE`，缺省 `default`）。`DSH_TRADING_TASKS_LEDGER` 仍覆盖。同 profile 双宿主走 B1 只读，不阻塞行情桥。

## Alternatives considered

- **继续构造抛错、仅桥层 catch**：服务对象不存在，UI 仍无法读 `isAvailable()`。败。
- **同文件双写者**：并发 rename 会互踩。败，锁仍单写者。
- **在 client 半实现 openSettings**：前后端分工禁止 Cursor 改 `src/client/**`；且 DOM hack 正是要退役的。败。

## Consequences

- 前端 P0-1 可消费 `/tasks/availability` 禁用入口或 tooltip；未改前端前，打开面板仍可能因写失败/旧 503 文案看到错误，但第二宿主至少能读快照。
- 前端 P0-2 应改用事件名或 `GET /shell/settings` 再 `window.dispatchEvent`；宿主补 `settings.open` 后桥会自动 `host-service`。
- 已有 `ledger-v1.json` 在 `~/.dsh/trading-tasks/` 根下的旧部署：新默认路径按 profile 分子目录，旧文件不会自动搬迁；可用 `DSH_TRADING_TASKS_LEDGER` 指回旧路径。
