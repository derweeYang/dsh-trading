---
name: option-intraday-workflow
description: Use when scanning China ETF option underlyings for timing, 5-day relative strength, 1-minute boxes, 5-minute range, or LLM strategy recommendations.
---

# ETF 期权盘中工作流（option-intraday-workflow）

三层漏斗。数字只来自工具 JSON。本流程是技术研究预填，不是投资建议；禁止实盘下单。

**REQUIRED BACKGROUND:** Use cn-risk-checklist before any obligation-leg discussion.

## Output (this order)

1. `opportunity` + `edge`（赚哪类钱；闭集见仓内 spec）
2. L1 选场表（最多 3 只）
3. L2 箱体行（只引用 `cn_get_option_intraday_box` 或 loop.forecast）
4. 内核 `cn_get_option_strategy` 摘要
5. `invalidIf`（抄 JSON）+ 反方
6. `playbook` 或 `no_trade`

定时桶先调用 `cn_put_option_bar_recommendation` 再写六段。

## L1 选场

1. 读总览：`GET /options/overview?sort=strength&includeIv=1` 或行内 `scanPrompt`。
2. 同源双挂先合并再留一只（链更厚者）：`510300`/`159919`，`510500`/`159922`，`588000`/`588080`。箱体行的 `twinUnderlying` 是权威对侧。
3. `weak_rally` 不做多头卖方；`accelerating_sell` 不做无保护短 put。
4. 5 日强弱只选标的；IV 分位 / HV20 只标制度。最多 2–3 只进 L2。
5. **定时桶**：只引用宿主注入的 `ContextPacket`。不要重算 IV / HV / 箱体 / 量比；`ivRegime=unknown` 时不得声称分位。禁止再打 `vol_analytics` 改制度标签。

## L0 定时闭环（不要用右侧栏 cron 扫箱体）

宿主每 30s 对齐 5 分钟上海时间桶：`POST /options/cycles/tick`（幂等）。
读 `GET /options/cycles/loop` 看上一桶 `score.verdict`（hit/partial/miss/skipped）。
下一周期只引用已打分的 JSON，禁止用裸 1 分钟 K 线自己复盘。
连续 miss 会 `calibrated=suppressed`——尊重 `no_trade`，不要强行给模板。

**LLM 只在 `sessionFlag === regular`（09:45–11:25、13:05–14:55 Asia/Shanghai）的新桶开一轮。**
开盘 15 分 / 午休边 / 尾盘 / 周末不开会话。一根 K 全市场一次，禁止每标的各开一轮。
禁止 `*_get_klines` 与下单。先 `cn_put_option_bar_recommendation`。
盘后复盘是 `data/options/reviews/` 确定性汇总，不再开会话。

## L2 箱体

对入围标的调用 `cn_get_option_intraday_box`（可 `underlying=all`），或直接读 loop 里的 `latest.forecast`。

- 只引用 `boxLow` / `boxHigh` / `regime` / `candidates` / `invalidIf`。
- `regime=no_trade` → 该标的结束，写 `noTradeReason`。
- 禁止用「最近 5 根高低」当未来箱体；禁止把 1 分钟 K 线贴进回复。

## 内核

按候选 `template` 调 `cn_get_option_strategy`（Greeks / 到期损益 / 义务仓保证金）。行权价相对箱体与 ATM，不要自编权利金。

## L3 评审

**提案者**（五段论）：制度假设 → 为何此模板 → 行权价相对箱体 → 失效条件（抄 `invalidIf`）→ 义务仓 / 乘数 10000。

**反方**（任一项成立 → `no_trade`）：5 分钟半宽小于买卖价差；T+1 现货腿；临近到期 theta；深市流动性；双挂选错腿。

## Red flags

| Excuse | Reality |
|---|---|
| "I can see the range on the klines" | Box JSON is the only range. |
| "Overview is enough" | Overview is L1 only. |
| "I'll just recommend a straddle" | Template must come from `candidates` unless L3 flips to `no_trade`. |