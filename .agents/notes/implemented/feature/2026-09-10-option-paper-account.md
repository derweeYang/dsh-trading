# Agent Note: ETF 期权虚拟账户（10 万市价记账）

Status: implemented

规格：[docs/superpowers/specs/2026-09-10-option-paper-account-design.md](../../../../docs/superpowers/specs/2026-09-10-option-paper-account-design.md)。上层智能体：[option-bar-agent](2026-09-08-option-bar-agent.md)。

## Problem

5 分钟桶会写推荐，但没有连续资金约束，无法回答「这信号若按市价做，10 万能不能活、平仓后赚不赚」。GUI 股票模拟盘不懂期权乘数与保证金；连接器 dry-run 没有跨桶现金账。宽闸（无完整腿也要补链成交）若人手点单，下午 overlap 与重复推荐会对不齐。

## Decision

在宿主 `data/options/paper/` 维护单一虚拟账户，初始 `OPTION_PAPER_INITIAL_CASH`（100_000 CNY）。`normalizeRecommendation` 成功且 `noTrade=false`、无 skip 桩时，用当桶链价补腿、`maxContracts`（缺省 1）经 `sizeQty` 减张后开仓；成交价 `fillPrice` 取链行 `last ?? prevSettle`（链 wire 无 bid/ask）。tick 上解释 `invalidIf`，否则当日 `close5` 平仓。同一 `bucketStart` 全市场只成交第一笔过闸 combo，其余 pick 记 `one_fill`、后续推荐记 `duplicate_bucket`。只读桥三条 GET/POST；不打 `/options/order`，不设 `liveTrading`。与 `paper-trading-store` 隔离；本轮不改 `packages/client-ui-*/src/client/**`。

## Context & Efficiency Impact

- Token：不开新 LLM；补腿用已有 chain/strategy 调用，每成功桶一次。
- Schema：`@dshtrading/api` 增加 paper account/fill 类型；推荐 JSON 不强制新字段（`maxContracts` 已可出现在 pick 上）。
- 上下文：prompt 不必改；智能体仍只写推荐。

## Alternatives considered

- **复用浏览器 paper-trading-store**：页面关闭不成交；现货引擎无 10000 乘数。败。
- **每条推荐 POST /options/order dry-run**：无连续 10 万账，重复桶连打。败。
- **严闸（必须自带完整腿）**：用户已选宽闸 B。败。
- **张数永远 1 张 / 占用 10%**：用户已选 `maxContracts`。败。
- **下一桶即平 / 只开不平**：用户已选 invalidIf + close5。败。

## Consequences

- kit-cn 单测覆盖补腿、减张、幂等、平仓、reset、与 live 隔离；`pnpm --filter @dshtrading/api build` 与相关包 test 绿。
- `fillPrice` 用 `last ?? prevSettle`；`sizeQty` 按 `abs(premiumPer) + marginPer` 递减张数（与单测一致）。
- 乘数常量 `OPTION_MULTIPLIER`（10_000）与 `OPTION_PAPER_INITIAL_CASH` 在 `@dshtrading/api` 与 kit-cn 导出。
- 宽闸会把 probe 行成交；靠 `duplicate_bucket` 与 `no_quote` 限损，不能消除烂推荐。
- `invalidIf` 自然语言解释失败会拖到 close5，盘中破箱可能晚平。
- 链快照若仍隔夜，市价会偏；规格禁止在有更新时用昨日 snapshotAt。
- 不修 L0 `barCount=0`，箱体命中率与纸面盈亏仍可能对不齐。
- workbuddy 以后只读展示；本轮无 client UI。
