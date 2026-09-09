# ETF 期权 5 分钟 K 账本

本目录是期权智能体的项目内数据面。规格见 `docs/specs/2026-09-08-option-bar-agent.md`。

| 子目录 | 内容 |
|---|---|
| `cycles/YYYY-MM-DD.jsonl` | L0 每标的每桶一行（forecast，下一桶再追加带 score 的同行） |
| `recommendations/YYYY-MM-DD.jsonl` | 每桶一条推荐或跳过桩 |
| `reviews/YYYY-MM-DD.md` | 当日首次进入 `close5` 的确定性复盘 |
| `seed-cards.json` | 初始化知识卡片草稿（`knowledge_ingest`） |

覆盖路径：环境变量 `DSH_TRADING_OPTIONS_DATA`。

流水 jsonl / md 已 gitignore。不要把权利金当制度写进 `seed-cards.json`。
