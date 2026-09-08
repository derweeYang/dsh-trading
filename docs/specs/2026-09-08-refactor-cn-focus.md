# Spec：聚焦 CN 市场——删除 crypto/hk，期权核心化与 ETF↔期权互联

- 日期：2026-09-08
- 分支：`feat/refactor-cn-focus`（自 `feat/etf-options` @ e4fc422 开出，含期权只读接入 e5e6385）
- 交付流：跨多包联动 + 改公共契约（packages/api）+ 交易安全语义 → 按 PR flow 走 PR 合并
- 用户决策（已确认）：
  1. 删除加密货币模块
  2. 删除香港市场模块
  3. 期权全链路核心化（含真实下单，双闸铁律），与 A 股交易同等
  4. 互联四项全做：标的双向跳转 / 现价拼接 / 备兑对冲组合视角 / T 板直接下单

## 分工边界（2026-09-08 用户重申）

- **本 agent（后端半）**：`packages/api`、`connector-*`、`kit-*`、bundle（crypto/us/cn/hk/all）、`python/**`、`scripts/`、`desktop/scripts/`、client-ui 的 node 半桥（`src/bridge.ts`、`src/index.ts` host 面）及非 UI 包（router/holdings/watchlist/strategies/indicators/base）
- **workbuddy（前端半）**：`packages/client-ui-*/src/client/**`。本 spec 附精确交接清单与桥契约；client 未改完前 `pnpm build` 在 client-ui 包会红，属预期中间态。

## 阶段 1：删除加密货币

### 1a. 整删目录（后端）
- `packages/crypto`、`packages/kit-crypto`、`packages/connector-binance`、`connector-bybit`、`connector-ccxt`、`connector-okx`（含 test/、preset 资产、cordis.patch.yml）
- `spikes/impl-crypto-derivatives/`、`impl-crypto-news/`、`impl-okx/`、`okx-research-PROMPT.md`、`impl-okx-PROMPT.md`
- `.agents/skills/crypto-instrument-analysis/`、`crypto-risk-checklist/`
- `docs/okx-integration.md`、`docs/archive/crypto-slice-plan.md`
- 保留 `.agents/notes/`（历史决策记录）与各 CHANGELOG（历史版本记录不改写）

### 1b. api 契约收缩（packages/api/src/index.ts）
- 删 `CryptoFundamentals`（:250-269）+ `FundamentalsPackage.crypto?`（:580）
- 删 `DerivativesData`/`DerivativesHistory`（:66-120）+ `getDerivatives`/`getDerivativesHistory`（:699-712）——crypto 永续专属
- 删 Context 服务键 `tradingCryptoMarketData`（:802-803）、`tradingCryptoTrade`（:810-815）
- 删 `AggregateNewsOptions.cryptoPanicKey`（:938-939）
- crypto 相关注释清理（:2、:14、:34、:69、:112、:731-736、:743、:859-861）

### 1c. 后端类型面/行为收缩
- `packages/base/src/presets.ts:15` `MARKETS → ['us','cn']`；`:71-73` KIT_SKILLS crypto 分支删；persona/EVIDENCE 文案
- `packages/base/src/research-tools.ts:8,10` 联合收缩
- `packages/base/src/index.ts:46-50` `ORDER_GATE_PATTERN → /^(?:us|cn)_(?:place|cancel)_order$/`
- `packages/router/src/index.ts`：PROVIDER_VOCABULARY 删 binance/okx/bybit/ccxt；`DEFAULT_MARKETS.crypto` 删；`news.cryptoPanicKey`/`newsKey()` 删
- `packages/router/src/tools.ts:11` MARKETS 数组；`catalog.ts:14` CatalogMarket + `:23-74` SYMBOL_CATALOG.crypto 删
- `packages/holdings`：types.ts:8 HoldingMarket、normalize.ts:18,40 crypto→USDT、tool.ts 文案
- `packages/watchlist/seeds.ts:16-21` crypto 种子删
- `packages/strategies/plugin.ts:54` 服务键删
- `packages/indicators/tool.ts:19,45` market 默认 `'crypto'` → `'cn'`；chart-tools 文案
- `packages/all/package.json`：删 `@dshtrading/crypto` 依赖、description 改
- `kit-us/src/news.ts:33-34`、`kit-cn/src/news.ts:41-42`：cryptoPanicKey 透传参数删
- `packages/client-ui-trading/package.json:44` 删 kit-crypto 依赖；`src/bridge.ts:21` import 删 + news 分支（:1094,:1111）+ 基本面分支（:1288,1351,1359）+ MARKET_IDS/MARKET_SERVICE_KEYS 的 crypto 行（:48-58）+ `/derivatives` 桥端点（若在 bridge）
- `packages/client-ui-settings` 的 node 半（settings 读写若在 client 则归 workbuddy）

### 1d. 脚本/构建
- `desktop/scripts/build-runtime.mjs:38,55` 删 `@dshtrading/crypto`
- `scripts/sync-skills.mjs`：`crypto-*` 路由删
- `scripts/new-connector.mjs`：`--market` 默认 `crypto` → `cn`，示例改
- `scripts/typecheck-baseline.json`：删 6 个 crypto 包条目
- 根 `package.json` description

### 1e. 后端测试
- `packages/base/test/gate.test.ts`（18 处 crypto_place_order）、`presets.test.ts`、`research-tools.test.ts`
- `packages/router/test/router.test.ts`（70 处）、`tools.test.ts`
- `packages/holdings/test`、`watchlist/test`、`strategies/test`、`indicators/test` 中 crypto 夹具/用例

### 1f. client 半交接清单（workbuddy）
见 §5 交接文档。要点：client/types.ts:9 MarketId、store.ts（inferMarket 回退→'cn'、:206 interval）、QuoteStage（derivatives 页签整删、KLINE_LIMIT、CURRENCY_SYMBOL、计价币）、MarketSidebar、DerivativesPane/DerivativesStage/api.ts:62-79 衍生品面板整套、FundamentalsStage:145-292 crypto 渲染、OrderPanel:33 符号检测、market-status:32-36 指数与 24/7 分支、news-source 白名单、holdings-types、toolview.tsx ORDER_TOOL_RE、locales（tab.crypto/derivatives.*/index.btc 等）、client-ui-strategies（StrategyView:98 缺省）、client-ui-settings（provider 目录 4 条、凭证、CryptoPanic UI、market tab）。

## 阶段 2：删除香港市场

### 2a. 整删目录
- `packages/hk`、`kit-hk`、`connector-futu`、`connector-longbridge`、`connector-tiger`
- `spikes/impl-cn-hk/` 中纯 hk 切片（保留 cn 部分若有）
- `.agents/skills/hk-risk-checklist/`

### 2b. 后端收缩（与阶段 1 对称）
- base：presets MARKETS（16 组合测试 → 4）、research-tools、ORDER_GATE_PATTERN、EVIDENCE 文案
- router：PROVIDER_VOCABULARY 删 futu/longbridge/tiger、`DEFAULT_MARKETS.hk` 删、catalog 38 条 HK 目录 + CatalogMarket、tools MARKETS
- holdings：HoldingMarket、`case 'hk': return 'HKD'`、测试
- watchlist seeds:34-37、strategies/plugin.ts:57 服务键、indicators 文案
- client-ui-trading node 半：bridge.ts:19 kit-hk import、:57 服务键、:1092 新闻、:1349 基本面；package.json:42
- **connector-tencent hk 分支清理**：index.ts `Schema.union(['cn'])`、marketDataKey、hk 文案分支；rest.ts TencentMarket、hk 归一化（:118-127）、r_hk 前缀、parseHkTicker；测试删 hk 用例（dataplane.test.ts:27,54-65、market-data.test.ts:52,118）
- `connector-template` 注释改参照物（okx/binance 删除后指向 tencent/akshare）

### 2c. client 半交接清单（workbuddy）
market-status HK 指数/交易时段、MarketSidebar 补零 `.HK`、QuoteStage inferMarket/HK$、holdings-types HKD、toolview 正则、locales（tab.hk/hangSeng* 等）、client-ui-settings（futu/longbridge/tiger 目录+凭证+market.hk tab、yahoo/ibkr/tencent/eastmoney/tushare/akshare 的 markets 数组去 'hk'）、测试 10 个文件。

## 阶段 3：期权核心化（全链路）

### 3.1 契约扩展（packages/api/src/index.ts）
- `OptionStrategyResult` 强类型化（legs/payoff/greeks/margin 替换 `unknown`）
- 新增期权交易契约（照 tradingTradeRegistry 双闸范式）：
  - `OptionOrderRequest`：symbol（长代码）、right、quantity（张）、price、orderType、dryRun（缺省 true）
  - `OptionOrder` 回执（含 multiplier 换算的权利金金额）
  - `OptionPosition`：underlying、right、strike、expiry、quantity、avgPrice、义务仓保证金占用
  - `CnOptionsTradeService`：placeOptionOrder/cancelOptionOrder/listOptionPositions
  - Context 服务键 `tradingCnOptionsTrade`
- `UnderlyingLink`：现货 symbol ↔ 期权名册关联（510050 ↔ 510050.SH + 长代码前缀）

### 3.2 连接器（connector-options + connector-qmt）
- `connector-options` 加交易半：Config 加 `qmtGatewayUrl`（默认 `http://127.0.0.1:5800`，复用 QMT 网关 REST）+ `dryRun` 默认 true / `liveTrading` 默认 false 双闸（照 connector-qmt/src/index.ts:43-47,105-131 模式）+ `test/trade-gate.test.ts`
- 桥新端点：`POST /dshtrading/api/options/order`、`DELETE .../order/:id`、`GET .../positions`（错误码沿用 options-bridge.md 表）
- dry-run 模式：不报 QMT，返回构造回执；paper 撮合由 client 侧 paper-trading-store 扩展（workbuddy 半，契约我出）

### 3.3 内核能力上桥（python/options + kit-cn）
- `OptionSource` 加 `'iquant'`（解深市 NO_DATA；python iquant.py 已有，注册表 510050/159915）
- 网关 `vol_analytics`、`fetch_underlying_daily`、`price`、`parity_check` 上桥 → kit-cn 新 agent 工具（`cn_get_option_vol_analytics` 等，只读声明）
- TS/Python 两份静态名册（rest.ts STATIC_ROWS 与 python data/underlyings.json）加同步校验测试

## 阶段 4：ETF↔期权互联（桥契约先行，UI 归 workbuddy）

1. **现价拼接**：`OptionChain.spot` 由桥侧回填——bridge 的 optionChain 装配时从 CN 行情 registry（tradingCnMarketData）拉标的 ticker 填 spot。纯后端，UI 自动受益。
2. **标的双向跳转**：桥加 `GET /dshtrading/api/options/resolve?symbol=`（现货↔长代码双向规范化，复用 normalizeCnUnderlying + 名册）；页面跳转状态（stageTab 上提）是 client 半，workbuddy 做。
3. **组合视角**：`POST /options/strategy` 请求体加可选 `holdingQty`（按真实持仓数预填 covered_call/collar 现货腿）；`GET /options/underlyings` 响应加 `heldQty?`（从 holdings 聚合）。契约我改，Python expand_template 已支持。
4. **T 板直接下单**：桥 `POST /options/order`（3.2 已建）；下单面板组件（张数/乘数换算/义务仓保证金预估 12%/7%）归 workbuddy，预估公式经 `POST /options/strategy` 现成返回。

## 验证

- 每阶段后端半：`pnpm build` + `pnpm test`（client-ui 包在 workbuddy 完成前允许红，其余包必须绿）
- `python/options`：offline pytest 全绿
- `scripts/typecheck-baseline.json` 同步
- 期权下单：dry-run 单测 + trade-gate 三态测试（未显式 liveTrading 必须 fail-closed）
- 终验：trading-web profile 冒烟 + 无头 Chrome 截图（workbuddy 完成后）

## 提交切分

1. `feat!: remove crypto market slice`（阶段 1 后端半）
2. `feat!: remove hk market slice`（阶段 2 后端半）
3. `feat(api,connector-options): option trading contract + dual-gate execution`（阶段 3）
4. `feat(kit-cn,bridge): option analytics bridge + underlying link`（阶段 4 后端半）
5. `docs: client handoff spec for workbuddy`
