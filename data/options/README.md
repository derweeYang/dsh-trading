# ETF 期权 5 分钟 K 账本

本目录是期权智能体的项目内数据面。规格见 `docs/specs/2026-09-08-option-bar-agent.md`。

| 子目录 | 内容 |
|---|---|
| `cycles/YYYY-MM-DD.jsonl` | L0 每标的每桶一行（forecast，下一桶再追加带 score 的同行） |
| `recommendations/YYYY-MM-DD.jsonl` | 每桶一条推荐或跳过桩 |
| `packets/YYYY-MM-DD.jsonl` | 每桶一包 ContextPacket（宿主打标；落盘校验用） |
| `paper/` | 本地纸账户：账户、持仓与按日成交 JSONL（运行时生成，不入库） |
| `iv-daily.jsonl` | 日终 / 回放 ATM IV / HV20（append-only；满 60 点后给本机分位）。历史种子：`node --experimental-strip-types scripts/seed-iv-daily.mjs`（网关 `replay_atm_iv`，已有行不覆盖） |
| `reviews/YYYY-MM-DD.md` | 当日首次进入 `close5` 的确定性复盘 |
| `seed-cards.json` | 初始化知识卡片草稿；`source.url` 必须是 `manual:…` 去重键（`file:` 过不了校验） |

覆盖路径：环境变量 `DSH_TRADING_OPTIONS_DATA`。

投影进本机 DSH 库（`~/.dsh/knowledge/cards.json`）：

```text
node --experimental-strip-types scripts/ingest-option-seed-cards.mjs
```

同源文件用 `#` 片段区分 URL，避免十张卡互相覆盖。流水 jsonl / md 已 gitignore。不要把权利金当制度写进 `seed-cards.json`。
