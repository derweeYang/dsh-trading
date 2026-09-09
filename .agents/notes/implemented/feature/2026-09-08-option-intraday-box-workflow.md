# Agent Note: ETF 期权盘中箱体缝 + 三层工作流 skill

Status: implemented

## Problem

九标的 T-5 总览（C1）和 scanPrompt（C2）已经能选场，但没有确定性的 1 分钟 → 5 分钟箱体。Agent 若自己读 K 线会把 60 根 1m 推进上下文，并发明高低点当「未来箱体」。策略推荐也缺少「提案者 / 反方」输出契约。

## Decision

L2 箱体是 kit-cn 纯函数，桥与 agent 工具同源；L3 只读 JSON。

1. **类型** `@dshtrading/api`：`OptionIntradayBox` / `OptionIntradayBoxRow` / `regime` 五态。
2. **计算** `packages/kit-cn/src/intraday-box.ts`：近 30 根 1m 对数收益 σ×√5 与 ATR(14)×√5 取宽；Donchian15 + 量比判定 `range_hold` / `mean_revert` / `breakout` / `vol_expand`；Asia/Shanghai 开盘 15 分、午休边、尾盘 5 分、盘后 → `no_trade`。同源双挂写 `twinUnderlying`。最多 2 个 `candidates`。
3. **桥** `GET /dshtrading/api/options/intraday-box?underlying=&horizon=5&asOf=`。现货 1m 走 `tradingCnMarketData`；不打期权网关。单行失败 `no_trade`，不整页失败。`horizon` 只接受 5。
4. **工具** `cn_get_option_intraday_box`。输出箱体 JSON，不回传原始 K 线。
5. **C2 prompt** 要求先调该工具、禁止自编箱体。
6. **skill** `option-intraday-workflow`（kit-cn 随包 + `.agents/skills`）：L1 overview → L2 箱体 → strategy → 提案者 / 反方。

本变更不改 `src/client/**`。总览页若要展示箱体，workbuddy 只拉这一条 JSON。

## Alternatives considered

- **只写 skill、agent 自己算箱体**：60 根 1m 进上下文，公式不可复现。败。
- **放进 python/options 网关**：箱体依赖 CN 现货 1m，不是期权内核职责；还要打 :8090。败。
- **总览页每分钟刷九路 1m**：对期权权利金价差不划算，且是 UI 工作。败。
- **箱体中心用现价、再用现价距箱沿判状态**：现价永远在正中，状态机失效。改用 Donchian15 判状态，σ/ATR 只做未来 5 分钟半宽。

## Consequences

- 1m 数据源必须是 iquant；腾讯 `TRADING_UNSUPPORTED_INTERVAL` 该行 `no_trade`。
- 5 分钟箱体是执行滤网，不是定价主因；主因仍是 IV 制度 + 到期日。
- 下单纪律不变：预填腿，实盘双闸。不构成投资建议。
- 契约见 [docs/options-bridge.md](../../../../docs/options-bridge.md)「intraday-box」。
- workbuddy 工单拆成 WB-0…WB-5，见
  [docs/workbuddy-handoff-2026-09-08.md](../../../../docs/workbuddy-handoff-2026-09-08.md) 节 D。
  Cursor / Claude 不实施这些 client 半任务。
