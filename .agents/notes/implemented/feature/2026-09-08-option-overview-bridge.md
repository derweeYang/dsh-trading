# Agent Note: CN ETF 期权总览桥（C1/C2 后端缝）

Status: implemented

## Problem

workbuddy 交接 C1 要求 9 标的一屏强弱榜（现货、T-5 量价、底仓、期权持仓、
可选 IV 分位）。若 UI 自己拼 `/tickers` + `/klines` + `/positions` +
`/vol-analytics`，排序公式和背离规则会在前后端各写一份，且默认轮询就会打
期权网关。C2 的扫描 prompt 也不能让 client 自己拼英文纪律句。

## Decision

桥新增 `GET /dshtrading/api/options/overview`。计算在 node 半纯函数
`src/option-overview.ts`（不进 `src/client/**`）：

- 名册 `listUnderlyings`，剔除 SYNTH；现货符号按交易所推 `.SH` / `.SZ`。
- GET 读 `data/options/overview.json`（5 分钟桶 `snapshotBarFacts` 活牌采集后覆写）；
  无快照则名册骨架、键缺席。ticker / 日 K / `implied_vol` 不在 GET 路径。
- T-5：`changePct`、`volumeSurge`（当日量 / 5 日均量 > 1.5）。
- `strengthScore = return5d × volumeRatio`；背离 `weak_rally` / `accelerating_sell`。
- `heldQty` 复用台账聚合；`optionQty` 为该标的期权张数绝对值之和。
- `includeIv` 查询参数保留兼容，GET 不再打 `vol_analytics`；分位来自快照或 `iv-daily.jsonl`。
- `scanPrompt` / `scanAllPrompt` 预填 C2，含「非投资建议 / 不得实盘下单」。
- `row.strategy`（可选）：读当天 recommendations jsonl 最新一行，投影到各标的
  （有 pick 带 template；其余 / stub 为 `no_edge` + `skipReason`）。无账本不写键。
  总览不现场算箱体。

类型在 `@dshtrading/api`（`OptionOverview` / `OptionOverviewStrategy`）。契约见
[docs/options-bridge.md](../../../../docs/options-bridge.md)。

## Alternatives considered

- **UI 多接口拼总览**：排序与背离会双写，默认 IV 轮询打爆网关。败。
- **放进 python/options**：总览依赖 CN 现货与 holdings，不是期权内核职责。败。
- **GET 现场拉 ticker/日 K/implied_vol**：九标的串行网关，总览当快数据会卡首屏。败（2026-09-12 改为读 `overview.json`）。
- **默认带 IV**：9 次 vol_analytics 依赖网关，首屏会 TRADING_NETWORK。败。
- **总览现场重算箱体当推荐**：与 5 分钟账本双写，且会在 regular 外冒出假信号。败。
  推荐只投影当天 jsonl 最新一行。

## Consequences

- workbuddy 总览只 fetch 这一条；点行仍走 `GET /options/resolve`。
- 「推荐策略」列读 `row.strategy`，缺席出「—」；词典与表头归 workbuddy（WB-7）。
- C1/C2 页面与词典仍归 workbuddy，本变更不改 `src/client/**`。
- `feat/etf-options` 交付，不合 `main`。
