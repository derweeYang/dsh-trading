# Agent Note: ETF 期权 5 分钟 K 智能体（落盘 + 交易时段推荐）

Status: proposed

## Problem

5 分钟箱体闭环已在宿主心跳里打分，但账本在内存、重启即丢；L3 策略推荐仍靠人手或 `scanPrompt` 开会话。要做「交易时段每根 5 分钟 K 跑一次智能体、写清赚哪类钱、盘后复盘」时，若用右侧栏 cron 每 5 分钟扫箱体，会重开已否决的路径：会话烧上下文、分数不可复现。复盘若写到 `knowledge-stock` L5，DSH `knowledge_search` 也读不到。

## Proposal

规格见 [docs/specs/2026-09-08-option-bar-agent.md](../../../../docs/specs/2026-09-08-option-bar-agent.md)。要点：

1. 本仓 `data/options/` 落 cycles / recommendations / reviews；L0 打分仍是纯函数。
2. LLM 只在 `sessionFlag === 'regular'` 的**新桶**触发，全市场一次 trader 会话；非 regular 只写桩。
3. 推荐字段闭集 `opportunity`（赚哪类钱）+ `logic` + `playbook`；模板必须来自 `candidates`。
4. 盘后复盘确定性汇总，不开 LLM。
5. knowledge-stock 只投影初始化卡片；每日账不进 stock。

## Context & Efficiency Impact

每个交易日约 30–35 次短会话（regular 5 分钟 K）。用 trader、禁委派、禁 1m K、重叠跳过，避免 master 三叉把 Token 打满。静态 prompt 放 Layer 2；`bucketStart` / 上一桶 score 沉底 Layer 3。cycles jsonl 按标的×桶追加，读时按 id 取最后一条，Schema 与现有 `OptionCycle` 对齐。

## Alternatives considered

- **右侧栏 `*/5` cron 拉会话算箱体**：与 [option-cycle-loop](../../implemented/feature/2026-09-08-option-cycle-loop.md) 已否决方案相同。败。
- **一天 2–3 次稀疏推荐**：节奏不够「每根 K 决策」。用户否决。
- **no_trade 时段也开会话**：午休/盘后空转。用户要求仅交易时段。
- **15:05 再开一轮写复盘**：用户选确定性汇总（方案 A）。
- **复盘写入 knowledge-stock L5**：智能体召回不到；每日流水也不该进长文库。败。
- **让模型改箱体公式或自造模板**：不可复现，且与 option-intraday-workflow 冲突。败。

## Verification & Gates

规格 §9 单测 + 现有 box/cycle 测试全绿。人工：regular 一根 K 一行推荐；`open15`/`lunch`/`close5` 无会话；收盘后一篇 reviews md。

## Risks

- 会话偶发超过 5 分钟 → 本桶 overlap 跳过，当日推荐出现空洞。
- 节假日 `sessionFlag` 仍可能 regular，靠行情 `insufficient` 挡腿。
- 卡片与 stock 双写可能漂移；以 stock 长文为准、卡片只摘要。
