# Agent Note: ETF 期权虚拟账户（10 万市价记账）

Status: implemented

规格：[docs/superpowers/specs/2026-09-10-option-paper-account-design.md](../../../../docs/superpowers/specs/2026-09-10-option-paper-account-design.md)。上层智能体：[option-bar-agent](2026-09-08-option-bar-agent.md)。

## Problem

5 分钟桶会写推荐，但没有连续资金约束，无法回答「这信号若按市价做，10 万能不能活、平仓后赚不赚」。GUI 股票模拟盘不懂期权乘数与保证金；连接器 dry-run 没有跨桶现金账。宽闸（无完整腿也要补链成交）若人手点单，下午 overlap 与重复推荐会对不齐。

## Decision

在宿主 `data/options/paper/` 维护单一虚拟账户，初始 `OPTION_PAPER_INITIAL_CASH`（100_000 CNY）。`normalizeRecommendation` 成功且 `noTrade=false`、无 skip 桩、且会话不是 `close5|closed` 时开仓。仅 `vertical` 可用当桶链价自动补腿；其他模板必须提供含逐腿价格与数量比的完整 legs。`maxContracts`（缺省 1）经 `sizeQty` 得出 combo 张数，再乘各腿数量比；成交价 `fillPrice` 取链行 `last ?? prevSettle`（链 wire 无 bid/ask）。保证金服务缺失、异常或不返回有效值时按 `no_quote` 跳过，不以零保证金成交。

tick 上解释 `invalidIf`，否则当日 `close5` 平仓。同一 `bucketStart` 的首个 live 尝试（成交或 `no_quote` 等 skip）即消费该桶，后续推荐记 `duplicate_bucket`。open/manage/reset 的 load-modify-save 共用按 data root 的进程内串行锁。只读桥三条 GET/POST；权益为 `cash + lockedMargin + signed current leg market value`，因此开仓价不变时仍等于初始资金；不打 `/options/order`，不设 `liveTrading`。与 `paper-trading-store` 隔离；本轮不改 `packages/client-ui-*/src/client/**`。

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
- 只有 vertical 可自动补腿；显式 legs 保留各腿 ratio 并按 combo 张数缩放；保证金查询失败落 `no_quote`。
- `close5|closed` 不开仓；首个 live skip 也消费 bucket；同进程并发 open/manage/reset 串行化。
- cash 已净记权利金且扣除锁定保证金，桥权益按 `cash + lockedMargin + signed mark value` 计算，避免开仓权利金重复计入。
- 乘数常量 `OPTION_MULTIPLIER`（10_000）与 `OPTION_PAPER_INITIAL_CASH` 在 `@dshtrading/api` 与 kit-cn 导出。
- 宽闸会把 probe 行成交；靠 `duplicate_bucket` 与 `no_quote` 限损，不能消除烂推荐。
- `invalidIf` 自然语言解释失败会拖到 close5，盘中破箱可能晚平。
- 链快照若仍隔夜，市价会偏；规格禁止在有更新时用昨日 snapshotAt。
- 不修 L0 `barCount=0`，箱体命中率与纸面盈亏仍可能对不齐。
- workbuddy 以后只读展示；本轮无 client UI。
