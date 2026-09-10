# Spec：期权模拟盘 LLM 决策追溯补强

- 日期：2026-09-10
- 状态：implemented
- 依赖：[option-paper-account](2026-09-10-option-paper-account-design.md)、[option-bar-agent](2026-09-08-option-bar-agent.md)
- 非投资建议。只改模拟盘账本与追溯元数据，不触实盘。

## 1. 产品

每笔模拟成交可逐级回溯到「LLM 会话 + 宿主时钟 + 当时报价来源 + 含费盈亏」：

```
fill.feeCny / leg.priceSource      ← 成本与价格依据
  → rec.sessionId + rec.hostAsOf   ← 宿主时钟 + 会话回指（~/.dsh/sessions/ 按此 id 可翻）
    → sessions/{date}.jsonl        ← launch/settle 全生命周期，outcome 含 no_rec 失败模式
```

## 2. 范围

做：

- 推荐行注入 `sessionId`（工具 `exec.agent?.id`）与 `hostAsOf`（工具侧时钟），normalize 之后注入、模型不可 spoof
- `sessions/{date}.jsonl` 台账：bar agent 每桶 LLM 会话 launch/settle 事件，append-only
- `no_rec` 失败模式：会话 succeeded 但该桶 recommendations 无行（LLM 没调工具）显式留痕
- 手续费：默认 1.7 元/张（`OPTION_PAPER_FEE_PER_CONTRACT`），开/平仓双边计，可注入覆盖
- 成交价来源标记：`leg.priceSource ∈ {last, prev_settle, pick}`

不做：

- bid/ask（数据源 akshare/iquant 无盘口字段）
- model/token 用量记录（dsh-tools `ToolRunContext` 不携带；盲区仍在宿主会话存档）
- tasks 模块改动（任务账本每任务 20 条执行裁剪 + trigger 词汇限制，不适合逐桶记录）

## 3. 关键口径

- **fee = feePerContract × Σ(leg.qty)（每腿张数合计）**。`fill.qty` 是组合份数（vertical 1 组=2 张=3.4 元；butterfly 1:2:1 一组=4 张），与 `premiumCny` 按腿求和口径一致。`sizeQty` 资金约束不改。
- **开仓费随平仓结算**：`PaperPosition.openFeeCny?` 记录；`applyClose` 时 `realizedPnl += openPremium + closePremium − openFee − closeFee`；旧数据 `?? 0` 不追补（realizedPnl 增量记账，天然兼容）。
- **sessions 聚合 key = `bucketStart + '|' + (sessionId ?? '')`**（no_rec 时同桶会重 launch，一个桶可多会话）；字段级 last-wins；容忍乱序 / launch-only（in-flight）/ settle-only。
- **no_rec 时序安全**：inspect 非 pending ⟹ turn/end 已发生 ⟹ 工具的 recommendations 写入已 await 完成，settle 时读无竞态。failed/cancelled 不做 no_rec 检测（error 优先）。

## 4. 数据契约

- `OptionBarRecommendation` + `sessionId?: string`、`hostAsOf?: string`（skip 桩缺省）。
- `PaperFill` + `feeCny?: number`；`PaperLegFill` + `priceSource?: OptionPaperPriceSource`；`PaperPosition` + `openFeeCny?: number`。
- `OptionBarSessionEvent { kind: 'launch'|'settle', bucketStart, sessionId?, launchedAt?, settledAt?, outcome?: 'succeeded'|'failed'|'cancelled'|'no_rec', error? }`；读取用 `foldOptionBarSessions` 聚合为 `OptionBarSessionRecord`。

## 5. 旧数据兼容

- 旧 fills / recommendations / positions 无新字段 → 读取方与 HTTP 面按缺省（fee=0）容忍；`account.json` 是持久快照从不重算，历史盈亏原样。
- 兼容性金句：新成交从新口径增量，历史不追补费用。
