# Agent Note: ETF 期权 5 分钟 K 智能体（落盘 + 交易时段推荐）

Status: implemented

后续增量：[5 分钟桶 ContextPacket](./2026-09-10-option-bar-context-packet.md)。编排上层：[TraderDirector](../architecture/2026-09-09-trader-director.md)。

## Problem

5 分钟箱体闭环已在宿主心跳里打分，但账本在内存、重启即丢；L3 策略推荐仍靠人手或 `scanPrompt` 开会话。要做「交易时段每根 5 分钟 K 跑一次智能体、写清赚哪类钱、盘后复盘」时，若用右侧栏 cron 每 5 分钟扫箱体，会重开已否决的路径：会话烧上下文、分数不可复现。复盘若写到 `knowledge-stock` L5，DSH `knowledge_search` 也读不到。

## Decision

规格见 [docs/specs/2026-09-08-option-bar-agent.md](../../../../docs/specs/2026-09-08-option-bar-agent.md)。宿主 `optionCycleTick` 之后由 `TraderDirectorHost` 走机会车道（`OptionBarAgentHost`）。

1. 本仓 `data/options/` 落 `cycles/` / `recommendations/` / `reviews/`（另有 `packets/`、`iv-daily.jsonl`）；L0 打分仍是 `kit-cn` 纯函数。路径可用 `DSH_TRADING_OPTIONS_DATA` 覆盖。启动回放当天 cycles jsonl。
2. LLM 只在 `sessionFlag === 'regular'` 的**新桶**触发，全市场一次 trader 会话；非 regular / 全市场 calibrated / 上一轮未结束只写桩（`skipReason` = `session` | `calibrated` | `overlap` | `launch_failed`）。
3. 推荐闭集 `opportunity` + `logic` + `playbook`；`template` 必须 ∈ 该行 `forecast.candidates`，否则整单改 `no_edge`。定时桶另受 ContextPacket 闸门约束。
4. 当日首次进入 `close5`（或当天从未 regular 而后 `closed`）写一篇 `reviews/YYYY-MM-DD.md`，已存在不覆盖；过程无 LLM。
5. `data/options/seed-cards.json` 是初始化卡片草稿（`manual:` URL，同文件用 `#` 片段去重）；每日账不进 knowledge-stock。本机投影：`scripts/ingest-option-seed-cards.mjs`（走同一套 `knowledge_ingest` 校验）。

静态 prompt 在 Layer 2（`OPTION_BAR_AGENT_PROMPT`）；`bucketStart` / 上一桶 score / ContextPacket 沉底 Layer 3。预设 trader，禁委派、禁 1m K、禁自动下单。

## Alternatives considered

- **右侧栏 `*/5` cron 拉会话算箱体**：与 [option-cycle-loop](./2026-09-08-option-cycle-loop.md) 已否决方案相同。败。
- **一天 2–3 次稀疏推荐**：节奏不够「每根 K 决策」。用户否决。
- **no_trade 时段也开会话**：午休/盘后空转。用户要求仅交易时段。
- **15:05 再开一轮写复盘**：用户选确定性汇总（方案 A）。
- **复盘写入 knowledge-stock L5**：智能体召回不到；每日流水也不该进长文库。败。
- **让模型改箱体公式或自造模板**：不可复现，且与 option-intraday-workflow 冲突。败。

## Consequences

- 会话偶发超过 5 分钟 → 本桶 overlap 跳过，当日推荐出现空洞。
- 节假日 `sessionFlag` 仍可能 regular，靠行情 `insufficient` 挡腿。
- 卡片与 stock 双写可能漂移；以 stock 长文为准、卡片只摘要。草稿 URL 已改成可校验的 `manual:` 键；各机仍须跑一次 ingest 脚本，不把 `~/.dsh/knowledge` 提交进仓。
- 规格 §10 交易日人工验收（regular 一根 K 一行推荐、非 regular 零会话、收盘一篇 reviews）仍待跟盘，不挡代码路径。
- 页面展示推荐卡 / `ivRegime` 归 workbuddy，见 [IV packet 交接](../../../../docs/workbuddy-handoff-2026-09-10-iv-packet.md)。
