# Agent Note: 删除 crypto/us/hk 市场切片，仓库收敛为 cn 单市场（阶段 1/2/2b）

Status: implemented

## Problem

用户裁决（2026-09-08）：dsh-trading 聚焦 CN 市场，删除加密货币、香港、美国三个市场切片，后续把期权重构为与普通 A 股交易同等地位的核心模块。三市场合计 16 个连接器包（binance/bybit/ccxt/okx、futu/longbridge/tiger、alpaca/finnhub/fmp/ibkr/polygon/yahoo/stooq）、3 个 kit、3 个 bundle、相关 skills 与文档，且词汇表/种子/夹具/注释全链路都有四市场假设残留。删除是 breaking change，但仓库不发布 npm（README 铁律），破坏面收敛在仓内。

## Decision

**成建制删除 + 全链路 cn 化，测试语义保持**：

- 删 16 连接器 + kit-crypto/kit-hk/kit-us + crypto/us/hk bundle + `docs/okx-integration.md` 等 + crypto/hk/us skills（`sync:skills` 后 `.agents/skills/` 一致）；
- `connector-tencent` 拆除 hk 分流（原 cn/hk 单包双市场多实例模式，`config.market` 保留单值 `cn`），README 与 cn bundle 两处 yml 留历史注记；
- 词汇收缩：`MARKET_SERVICE_KEYS` 只剩 `cn`、`HoldingMarket = 'cn'`（`HoldingCurrency` 多币种枚举保留——B 股 USD 等场景仍合法）、router 供应商词汇表收缩为 6 家 cn 供应商、watchlist 种子改 cn 4 行、`crypto_get_indicators` → `cn_get_indicators`；
- `connector-template` 参照系从 connector-okx 切到 connector-qmt（模板不再指向已删包）；
- 注释/示例清理：api/holdings/watchlist/indicators/strategies/knowledge/kit-cn/base 测试与源码中的市场词汇、`600519.SH`/`510050.SH` 示例体系；
- 测试修复原则：删掉的用例是「已删除市场」专属的；保留用例只换市场词汇/夹具（如「两级隐藏互证」需两个市场，用假想新市场 jp 占位并加注释）；「跨市场 edit 重推导 currency」在 cn-only 下不可构造，改写为「edits 应用 + currency 维持推导值」；
- typecheck 棘轮基线 286 → 272。

## Alternatives considered

- **保留连接器包、只下线 bundle**：半死代码仍要过 typecheck/测试/评审，违背「聚焦」诉求。败。
- **connector-tencent 保留 hk 分流以备将来恢复**：hk 半的测试/词汇/normalize 全链路都在拖累收敛，且恢复可从 git 历史找回。败。
- **HoldingCurrency 一并收缩为 CNY**：B 股（美元计价）是 cn 市场的真实场景，多币种枚举与 fx 端点（frankfurter 兜底链）独立于市场删除。败。

## Consequences

- 全仓 build 零失败；非 client-ui 包测试全绿（base presets symlink 用例 Windows EPERM 为既有环境限制）；client-ui-trading node 半 65 用例全绿（bridge 50 + holdings 11 + smoke 4）。
- client-ui client 半（`store.test.ts` 3 + `symbol-catalog.test.ts` 3 失败、`MarketId`/衍生品页签/market-status 等删除涟漪）归前端交接（workbuddy），清单见 docs/specs/2026-09-08-refactor-cn-focus.md 与交接文档。
- python/options 的 6 个 pytest 失败（`volsurface` 可选依赖未装）为 HEAD 既有问题，与本删除无关，留阶段 3 处理。
- 阶段 3（期权交易契约）/阶段 4（ETF↔期权互联）在 cn-only 基线上展开，不再需要四市场兼容分支。
