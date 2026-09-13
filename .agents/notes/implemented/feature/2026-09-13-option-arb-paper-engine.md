# Agent Note: 套利纸面引擎（option-arb-paper.ts）

Status: implemented

## Problem

arbitrage 账本需要自动交易内核：executable 机会 → 对手价立即成交（buy 吃 ask /
sell 吃 bid）、收敛/反转/到期自动平仓。引擎必须防三类事故：陈旧盘口伪 executable
（前视）、同标的同桶多机会 position id 撞车、缓存链与成交价的 TOCTOU。

## Decision

C3（本 commit）——`packages/kit-cn/src/option-arb-paper.ts`（新文件，kit-cn 首次
依赖 `@dshtrading/strategies`，走 `./arbitrage` 深导出避 cordis 污染）：

- **takerFillPrice(row, action, mode)**：strict（开仓，盘口不健全宁可不交易）/
  fallback（平仓，盘口撤了也得能平，回退 last→prevSettle）；0/负价一律无效。
- **arbPositionKey**：`arb:<kind>:<u>:<m>:<K1>[-<K2>]`，strikes 升序归一 ×1000 编码，
  **方向无关**——同 strikes 反向机会走平仓路径不叠仓。
- **decideArbOpen 八步**：executable 闸 → snapshotAt ≤90s 新鲜度闸（缺失=不可证新鲜）
  → duplicate 闸 → 腿价**从链重推** strict（不信 opportunity 数字）→ parity 现货腿
  （1 张=10000 份，qty 存份数）→ 期权保证金+卖空现货 50% 融券近似 → sizeQty 现金约束
  → fill（reason 'arb_open'、book 'arbitrage'、openEdgePerShare 基准）。
- **decideArbClose 优先级**：到期强平（today ≥ expiryDate）> 边缺 hold（下轮重试）
  > 反转（edge<0）> 收敛（edge<openEdge/2）。
- **tryArbPaperCycle**：root 锁内、顶层吞错；平仓轮任何 session（到期强平跨休市
  可重试）、开仓轮仅 regular；开仓前 **on-hit refresh**——绕缓存强制新拉链重扫，
  同 key 同向仍 executable 才落账（削 60s 缓存前视偏差）。
- 审计粒度裁定：**不写 skip 桩 fill**（30s×14 链会洪水化 jsonl），成交-only。

## 已知坑

- **手算口径混淆**：测试期望值两次算错——mid 口径(C_mid−P_mid)与 taker 口径
  (buy 吃 ask/sell 吃 bid)差整个 spread；端到端净价差必须按 taker 双边重算
  （开仓 C@ask 0.05、平仓 C@bid 0.164 → 0.114/股，不是 0.098）。
- `shanghaiCalendarDate` 在 option-bar-ledger.ts 而 `shanghaiBucketStartMs` 在
  option-cycles.ts，跨文件 import 别想当然。

## Next

C4 bridge 接线（30s 心跳 + 60s 链缓存 + in-flight 闸）。
