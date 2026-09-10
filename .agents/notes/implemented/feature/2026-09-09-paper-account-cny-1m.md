# Agent Note: 模拟账户默认 ￥100 万人民币

Status: implemented

## Problem

模拟盘初始资金为 100,000，余额资产标为 `USDT (Demo)`，已实现盈亏按 USD 折算基准币。A 股 / ETF 期权主场景下，资金与成交价天然是人民币，USDT/USD 记账会造成可用余额与汇总权益语义错位。

## Decision

- `DEFAULT_INITIAL_CASH` 改为 `1_000_000`；`getBalances()` 资产改为 `CNY`。
- localStorage 键升至 `dshtrading:paper:account:v2`，旧 v1（10 万 / USDT）不再加载，刷新后以新默认起账。
- 已实现盈亏折算由 `convertUsdToBase` 改为 `convertCnyToBase`（CNY 基准恒等，其他基准用 `rates.CNY`）。
- 重置确认文案与相关 hint 同步为 ￥1,000,000 / CNY。

承接此前引擎落点：[2026-09-03-paper-trading-engine-ui](../features/2026-09-03-paper-trading-engine-ui.md)。

## Alternatives considered

- **仅改默认金额、仍标 USDT**：金额对了，币种仍误导，且与 ￥ 错误提示不一致。
- **保留 v1 并原地改写 cash**：可能把已有模拟持仓与旧币种混在同一账本；升键更干净。
- **继续用 USD 折算函数只改标签**：汇总权益在 CNY 基准下会把人民币盈亏当美元再乘汇率，数值错误。

## Consequences

- 新会话 / 重置后模拟可用为 ￥1,000,000 CNY。
- 浏览器仍持有 v1 键的旧数据会被忽略（不迁移）；用户点「重置模拟金」或硬刷新后即见新默认。
- 需重建 `@dshtrading/client-ui-trading` 并刷新 trading-web profile 的 file: 副本后 UI 才生效。
