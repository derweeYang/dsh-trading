# Agent Note: 深实值期权贴水扫描与纸面撮合（intrinsic discount 线）

Status: implemented

## Problem

2026-09-17 套利质量复盘结论：parity/box 可执行机会在沪深 ETF 期权近乎不存在
（做市商主导），而深度实值档因库存/流动性摩擦**常态存在低于欧式下界的贴水**
——这是检测器能持续出真信号的第一梯队结构。要求：内核纯函数、仅真实盘口行
（last 价回退在本结构上是伪影高发区，09-17 复盘实证）、接入现有 arbitrage
纸面账本复用全部闸门，且不得打断 `ArbitrageKind/Direction` 联合的 UI 穷举
switch 与 api 手工镜像。

## Decision

- **内核**（`strategies/src/arbitrage/intrinsic.ts`）：`scanIntrinsicDiscount`
  扫 C/P 两侧欧式下界 `max(S·e^{-qT} − K·e^{-rT}, 0)` / `max(K·e^{-rT} − S·e^{-qT}, 0)`，
  硬闸 = executable（真实买一卖一）+ 实值度 ≥3%（bound/spot，滤近 ATM 噪声）
  + 价差闸（ask−bid < 贴水，防盘口内噪声）+ 费后净边 >50 元/张（与 parity/box 同口径）。
  独立类型 `IntrinsicDiscount`，**不并入 scanArbitrage**（同 verticals 先例：收敛型
  类套利非瞬时无风险）。`intrinsicSignedEdge`（再入场边 = bound − ask）供持仓监控。
- **出口**（api + connector-options）：`includeIntrinsic` 查询旗标 opt-in 附
  `intrinsic[]`，零破坏现有消费者；`OptionIntrinsicDiscount` 手工镜像（api 零包依赖惯例）。
- **纸面引擎**（kit-cn option-arb-paper）：template `intrinsic_call/intrinsic_put`
  透传（direction 留空，right 编码进模板——不动 api 类型）；`decideIntrinsicOpen`
  复用 90s 快照闸/去重/strict 对手价/on-hit refresh 双确认，纯买腿零保证金；
  平仓轮 `positionCurrentEdge` 加 intrinsic 分支（spot 注入同 parity 路径），
  `decideArbClose` 到期/反转/收敛语义直接复用。子帽
  `OPTION_ARB_MAX_INTRINSIC_POSITIONS = 3` 防高频贴水信号挤占共享 6 组上限。
- **活性哨兵回归**：`spot:null` + 无盘口生产形态链 → 贴水扫描空转不炸不落账
  （09-17 parity 失明事故的 intrinsic 版防线）。

## Alternatives considered

- **并入 ArbitrageKind 联合**：编译期会打断前端穷举 switch 与 api 镜像同步，
  且贴水非无风险，语义上更接近 verticals 的独立出口——弃。
- **开仓时才核边（无 on-hit refresh）**：缓存前视偏差，parity 路径已有教训——沿用双确认。

## Impact

- strategies 7 用例、connector-options 6 用例、kit-cn 21 用例全绿；
  T 板 `includeIntrinsic=true` 即取；纸面账本 09-18 起与 parity/box 同轮扫描。
- 验收锚点：arb-heartbeat 的 `intrinsicDiscounts` 计数与首笔 `intrinsic_call`
  纸面成交（openEdgePerShare = 链现算贴水）。
