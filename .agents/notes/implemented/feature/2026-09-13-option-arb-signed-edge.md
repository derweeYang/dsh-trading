# Agent Note: 套利签名边助手（paritySignedEdge / boxSignedEdge）

Status: implemented

## Problem

套利纸账户持仓监控需要「按开仓方向计算当前残余 edge（可正可负）」的判据：
收敛平仓（edge < openEdge/2）与反转平仓（edge < 0）。现有 `scanParityArbitrage`/
`scanBoxArbitrage` 只回正边过阈值的机会（供展示），无符号概念，不能直接用于
持仓方向监控。

## Decision

C2（本 commit）——`packages/strategies/src/arbitrage/`：

- `paritySignedEdge(chain, strike, direction, options?)`：
  sell_synthetic_buy_spot → `(C_bid − P_ask) − cashForward`；
  buy_synthetic_sell_spot → `cashForward − (C_ask − P_bid)`。
- `boxSignedEdge(chain, lowStrike, highStrike, direction, options?)`：
  long_box → `fair − 多箱成本`；short_box → `空箱收入 − fair`。
- **与 scan 同口径的关键**：无盘口时 `execPrices` 回退中间价（bid=ask=mid），
  两个方向的公式自然退化为 ±deviation / ±edgeLong——不复制 scan 的
  `executable ? exec : deviation` 分支，数学上天然同值同号。
- 缺行/缺 spot/缺到期 → `undefined`（引擎侧 hold 等下轮，不误判收敛）。
- 测试互证：scan 出的每个机会用 signedEdge 同方向复算，`toBeCloseTo(10)`
  同值 + executable 一致；无盘口/全盘口两套 fixture 都验。反向为负、
  缺行 undefined 各一测。130 全绿。

## Next

C3 套利纸面引擎（kit-cn option-arb-paper.ts）将用这两个助手算持仓残余边。
