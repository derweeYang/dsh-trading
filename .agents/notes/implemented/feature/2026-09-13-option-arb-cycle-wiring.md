# Agent Note: 套利纸面周期桥接线（optionCycleTick + 60s 链缓存）

Status: implemented

## Problem

套利引擎（C3）需要挂到 30s 心跳上自动运转：拉链要有节流（7 标的×近/次月，
30s 一轮 = 14 链/分会挤兑期权网关），且上轮周期未完时不能叠新一轮。桥侧还要
为引擎注入行情依赖（spot、每张保证金、现货全符号）。

## Decision

C4（本 commit）——`packages/client-ui-trading/src/bridge.ts`：

- **`#arbChainCache` + `#arbChain`**：key `u:m`，TTL 60s（`OPTION_ARB_CHAIN_TTL_MS`）；
  失败（resolve undefined）**不缓存**当轮删除，下轮重试；`refresh:true` 强制新拉覆盖
  （引擎 on-hit refresh 专用，削缓存前视偏差）。拉到后经 `#withSpot` 用 ticker 现价
  覆盖链 spot（与 GET /options/arbitrage 同款）。
- **`#arbCycleInFlightSince` 闸**：记 tick asOf；非 0 = 在跑 → 本轮跳过；超 5min
  视为僵死强制放行（防异常泄漏后永久卡死）。
- **optionCycleTick 尾部接线**（tryPaperManage 之后，fire-and-forget + 错误日志
  `[dsh-trading/options-paper-arb] cycle failed:`；返回形状不动）：
  - underlyings 复用 tick 已拉的 roster（滤 SYNTH）；
  - expiryMonthsFor = getOptionExpiries 滤过期月 → 按到期日升序取近/次两月；
  - getSpot = `#spotPriceOf`；spotSymbolFor 由 roster exchange 映射 SH/SZ；
  - getOptionLegMarginPerContract = getStrategy({underlying, legs}) 的
    `margin.totalInitial`（option-bar-agent getMargin 同款，每张口径，不传
    premium 由内核自取链价）。
- 集成测试（bridge.test.ts）：fake Date 只冻结墙钟（Promise/定时器真实），
  第一次 tick（regular，BJT 周二 11:00）落 arb_open qty=2 + cash 守恒；拨过
  60s TTL 后换收敛链、第二次 tick 走 **close5**（收敛边 0.00872 仍过 0.005 扫描
  阈值，regular 会立即再开仓）→ arb_converge 平仓，realizedPnl=154.8；
  strategy 账本同 tick 驱动但隔离（仍 100k）。

## 已知坑

- **贴现随日历漂移**：同一条链 fixture 在 2026-09-08（距到期 15 天）扫出的边
  （0.02072）比 C3 测试的 2026-09-13 口径（0.01996）厚 0.00076——收敛阈值
  openEdge/2 随之移动，收敛链价格要按**实际 asOf 日期**重算，不能照抄 C3 数值。
- **exactOptionalPropertyTypes**：`{ key: maybeUndefined }` 显式传 undefined
  不进 optional 属性，必须条件展开 `...(x === undefined ? {} : { x })`；
  vitest 不做类型检查，这类错误只有 typecheck-gate 能拦住——C3 引入的 4 处
  在 C4 门禁时才暴露（已修，两包错误数回到基底存量水平）。
- 主仓基底本身已超 typecheck 基线（kit-cn 27>21、strategies 45>42、
  client-ui 3>0，均 fundamentals/engine/predictions 等旧文件存量债）；
  本分支原则 = 不高于基底，不动存量。

## Next

C5 workbuddy handoff 文档（五条路由 + 资产面板对接需求）。
