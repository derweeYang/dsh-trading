# Agent Note: 套利纸面引擎 parity 扫描缺 spot 注入，平价检测整链瘫痪

Status: implemented

## Problem

2026-09-17 盘后复盘发现套利账本（`paper/arbitrage`）自 09-14 上线以来四天
零成交、零信号。排查链路：

1. `tryArbPaperCycle` 开仓轮扫描调用
   `scanArbitrage(fromOptionChain(chain), { feePerContract })`——不注入 spot；
2. 生产链源 iquant `/v1/chain` 响应**不带 `spot` 键**（实测 `spot: null`，
   现货由桥侧 `#spotPriceOf` 单独拼接，仅 parity 成交腿用到）；
3. `parityMatrix` 首行 `if (chain.spot === undefined) return []`
   （`strategies/src/arbitrage/parity.ts`）。

⟹ 平价检测恒空——不是"市场无边"，是根本没扫。对照：T 板路径
`getArbitrageScan` 有 `query.spot ?? chain.spot` 拼接能正常出 parity 行，
唯独纸面引擎漏了。单测 `parityChain()` fixture 内嵌 `spot: 2.9`，恰好掩盖
生产链形态，测试一直绿。

平仓轮同病：`positionCurrentEdge` 的 `paritySignedEdge` 也依赖
`chain.spot`，parity 持仓残余边恒 undefined → 永远 hold（开了仓也平不了）。

当日信号质量侧写（同日诊断，另案处理）：检测层 mid 口径表观偏离巨大
（510050 净边 217–366 元/张、末月低流动标的 9000+ 元/张）但全是 last 价
假象，`executable` 闸门正确拦截——box 侧零成交是有效市场常态，非故障。

## Decision

- 新增 `arbChainOf(chain, spot)` 组装器：**桥侧现价优先、缺省回落链自带
  spot**，口径对齐 T 板 `scanOptionChainArbitrage` 的
  `query.spot ?? chain.spot`。非正有限数不落键（exactOptionalPropertyTypes）。
- 开仓轮：标的级 `getSpot` 取一次，扫描、on-hit refresh 双确认、
  `openInput.spotPrice` 三处同源复用（30s 周期内一致；拿不到时 parity 不可
  用、box 仍扫——优雅降级）。
- 平仓轮：`positionCurrentEdge` 加可选 `spot` 参数，仅 parity 持仓且链不带
  spot 时用桥侧现价补。
- 回归测试：`parityChain` fixture 支持 `spot: null` 构造 iquant 形态；新增
  "链无 spot + getSpot 可用 → parity 开仓落账（现货腿价与检测同源）"与
  "链无 spot 且 getSpot 失联 → 不开仓不炸"两条用例。

## Alternatives considered

- **网关侧给 `/v1/chain` 拼现货价**：iquant 链行来自逐合约 tick/日 K，网关
  不持有标的现货订阅；且 akshare/synth 源各有现货语义，桥侧注入一处收口
  更小。
- **decideArbOpen 里兜底**（开仓时才拿 spot）：太晚——扫描层已经把 parity
  全滤空，到不了开仓决策。

## Impact

- `packages/kit-cn/src/option-arb-paper.ts`：`arbChainOf` 组装器 + 开/平仓
  轮注入；对外接口零变更（`ArbPaperCycleInput` 不动）。
- `packages/kit-cn/test/option-arb-paper.test.ts`：fixture `spot: null`
  哨兵 + 2 条回归用例（15 文件 / 207 用例全绿）。
- typecheck 与基底持平（27=27，既有错误全在 option-predictions/sentiment）。
- 生效前提：宿主 `cycles/tick` 30s 心跳驱动（bridge 既有编排不变）。
