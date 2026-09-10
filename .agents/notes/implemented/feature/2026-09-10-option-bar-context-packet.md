# Agent Note: 5 分钟桶 ContextPacket 与 IV/量价落盘闸门

Status: implemented

## Problem

IV × 量价交叉表只写在 skill / 口头纪律里时，定时桶智能体仍可「读了总览就编结构」：
`cn_put_option_bar_recommendation` 只校验 `opportunity ↔ regime ↔ template`，
不校验 `ivRegime` / `divergence`。活牌又常无 IV 分位，模型会把 `atmIv` 当成分位。

## Decision

5 分钟定时桶（不另开按需会话）由宿主组 `ContextPacket` 并落盘，模型只引用：

- 打标纯函数 `tagIvRegime`：分位 ≥0.8 / ≤0.2 → `rich`/`cheap`；无分位则 `atmIv` 对 `hv20`（>1.3× / <0.7×）；只有点估 IV → `unknown`。
- `buildBarContextPacket`：箱体来自 `loop.forecast`；5 日量比 / 背离 / `atmIv` 只来自 `snapshotBarFacts`（总览口径、`includeIv=0`、复用 5 分钟 ATM 缓存）。**不抄箱体 1 分钟量比**。
- launch 前写入 `data/options/packets/YYYY-MM-DD.jsonl`，prompt Layer 3 附 `ContextPacket=`。
- `normalizeRecommendation` 在磁盘 packet 存在时：`theta_rent` 仅 `rich|event_front`；`rv_vs_iv` 拒 `rich`；`covered_yield` 拒 `weak_rally`；`mean_reversion` 拒 `accelerating_sell`；pick 改写 `ivRegime` 拒收。
- 无 packet 文件时保持旧校验（手工 / 单测）。不打九路 `vol_analytics`。

类型在 `@dshtrading/api`（`OptionIvRegime` / `OptionBarContextPacket`）。skill `option-intraday-workflow` 同步一句「定时桶只信 packet」。

## Alternatives considered

- **只加长 prompt**：箱体禁令已证明模型会跳步。败。
- **每桶现打 vol_analytics**：打爆网关，且 iQuant 分位仍常 `insufficient`。败。
- **拆研究子代理**：与「一根 K 一次 trader」和禁止 master 三叉冲突。败。
- **无 packet 也强制 IV 闸**：旧单测与手工 `no_edge` 桩全断。败。

## Consequences

活牌默认 `ivRegime=unknown`，`theta_rent` 在定时桶写不进，直到有分位或 HV20。这是降级，不是缺陷。`packets/` 已 gitignore。

总览与 `snapshotBarFacts` 用日 K 算 `hv20`（与 python `realized_vol` 同口径：对数收益样本标准差 × √252），再交给 `tagIvRegime`。只有点估 IV 不再永远 `unknown`：`atmIv > 1.3×hv20` → `rich`。

`tagIvRegime` 在有次月 ATM 且近/次 ≥ 1.15 时打 `event_front`（优先于分位/HV）。总览缓存同一 5 分钟窗拉近月+次月 implied_vol，不打 vol_analytics。

活牌 `implied_vol` 不支持 asOf（akshare/iquant 明文拒绝）。历史 IV **不能**从行情网关回放。回填只重放已落盘的 `packets/*.jsonl` 进 `iv-daily.jsonl`（每文件最新一包；launch 与 close5 都跑）。满 60 个交易日后才有本机分位。

总览行现写 `ivRegime`（及可选 `hv20`）；`GET /options/bar-packet` 透出当天最新包。前端工单见
[workbuddy-handoff-2026-09-10-iv-packet](../../../../docs/workbuddy-handoff-2026-09-10-iv-packet.md)。
