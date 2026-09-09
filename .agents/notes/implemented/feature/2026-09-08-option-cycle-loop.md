# Agent Note: ETF 期权 5 分钟闭环（打分上一桶 + 宿主心跳）

Status: implemented

## Problem

箱体若只靠人手或 Agent 扫描，下一根 1 分钟走完后没有对照；右侧栏 cron
会拉起整段 LLM 会话，不适合每 5 分钟打分。需要确定性的「预报 → 等待 →
对照已实现路径 → 校准」闭环，并给页面一条只读 JSON。

## Decision

独立周期账本，不复用 `TradingTasksService`。

1. **桶**：Asia/Shanghai 墙钟 5 分钟（无夏令时，epoch±8h 对齐）。
2. **tick**：宿主 `setInterval(30s)` 调 `optionCycleTick`。同桶幂等。
   先给上一桶补 `score`（上一桶 `bucketStart` 到本桶之间的 1m K），
   再在 `session=regular` 时开本桶 `forecast`（可经连续 miss 加宽/抑制）。
3. **打分**：`closeInside` / `regimeHit` → `hit` | `partial` | `miss`；
   `no_trade` 或不足 3 根 → `skipped`。不看实盘成交。
4. **校准**：近 3 次有效 miss → `suppressed`（`noTradeReason=calibrated`）。
5. **桥**：`GET /options/cycles`、`GET /options/cycles/loop`、
   `POST /options/cycles/tick`。内存环每标的 48 桶。
6. **页面**：workbuddy 画时间线，工单 WB-6。不在 client 半打分。

## Alternatives considered

- **右侧栏 Agent cron 每 5 分钟扫一遍**：会开会话、烧上下文，分数不可复现。败。
- **浏览器 setInterval 自己算箱体并对账**：SSOT 漂移，多标签双写。败。
- **1 分钟一桶**：噪声大，和 5 分钟箱体视界不对齐。败。

## Consequences

- 进程重启丢历史；要落盘再开文件账本。
- 闭环是研究预填，不是自动交易。miss ≠ 下单。
- 契约见 [docs/options-bridge.md](../../../../docs/options-bridge.md)「cycles / loop」。
- workbuddy 可视化见交接文档节 D **WB-6**。
