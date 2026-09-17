# Agent Note: 套利周期心跳台账（arb-heartbeat）与复盘「套利跟踪」节

Status: implemented

## Problem

2026-09-17 事故复盘的直接教训：parity 检测缺 spot 注入导致整链瘫痪 4 天，
而审计粒度是「成交-only」、日复盘只覆盖 strategy 账本——「零成交」既可能是
市场无边也可能是引擎坏了，**连续 4 天没有任何信号能区分**。可观测性必须
与功能同一变更落地，不再事后补。

## Decision

- **心跳行**：`tryArbPaperCycle` 每 30s 周期写一行到
  `data/options/arb-heartbeat/<date>.jsonl`（gitignore，沿 17497e9 运行时台账政策）：
  扫描标的/月次数、链失败数、parity/box 机会数与 executable 数、深实值贴水数、
  开仓尝试/成交数、skip 原因分布、时长。**只记总数不记明细**（30s×14 链，
  明细会洪水化 jsonl）；catch 路径也落错误行（引擎故障不再静默）。
- **复盘节**：`foldDailyReview` 加可选 `arbHeartbeats`（缺省不出节，既有消费者
  零感知）+ `cbScans` →「## 6. 套利跟踪」：心跳聚合、机会计数、纸面开仓数、
  skip 分布、转债行；**哨兵口径落进文案**：零机会+链失败/错误 → 「先查引擎再谈
  市场无边」，零机会+零失败 → 「按市场无边处理」。免责顺延为第 7 节。
  `option-bar-agent.maybeWriteReview` 读两个台账喂参（node 半，归后端）。
- **类型归属**：`ArbCycleHeartbeat` 定义在 option-bar-ledger（账本模块拥有
  路径/读取/折叠），引擎只 import——避免 engine↔ledger 循环。

## Alternatives considered

- **写 skip 桩 fill**（像 strategy 账本那样）：30s×14 链×多机会会洪水化
  fills jsonl 且污染账本对账——心跳计数行是密度与可观测的折中。
- **只在 review 折叠层做哨兵**（不落心跳行）：跨日重启即丢证据，且无法定位
  「哪一轮开始坏」——逐周期行是事故取证的最小单元。

## Impact

- kit-cn 测试：心跳计数与行为一致（开仓数/链失败/error 行）、错误行照落、
  复盘节聚合与哨兵文案、向后兼容（缺省不出节）。
- 09-18 验收锚点：首个 regular 会话 arb-heartbeat 落账 ≥1 行/30s；
  日报出现「## 6. 套利跟踪」。
