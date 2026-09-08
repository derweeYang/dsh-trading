# Agent Note: CN ETF 期权第一期（只读内核 + 桥，T 板 UI 另交）

Status: implemented

## Problem

本仓 CN 只有现货 ETF / 指数，没有期权链、IV、保证金分析。
`trading-agent_v3/deepseek-harness` 已有只读 Python 内核（O1–O5），
但 TS 插件与研究台不能整包搬进 dsh-trading。前端 T 板由 workbuddy 做，
后端必须先交出稳定桥契约。

## Decision

第一期范围 = 只读分析 + 给 T 板用的 HTTP 桥。不下单、不行权、不接 iQuant
实盘、不编造深市期权行情。不新开第五市场。

1. **独立服务** `tradingCnOptions`（`@dshtrading/connector-options`），
   不挂在当前 CN 行情 provider 上。
2. **内核**：`python/options`（vendor）+ `dsh_options.gateway`（`:8090`）。
3. **符号**：合约主键长代码 `510050C2609M02850`；现货仍是 `510050.SH`。
4. **工具**：`kit-cn` 的 `cn_get_option_expiries` / `cn_get_option_chain` /
   `cn_get_option_iv` / `cn_get_option_strategy`。
5. **桥**：`GET /dshtrading/api/options/{underlyings,expiries,chain,implied-vol}` 与
   `POST /options/strategy`。`underlyings` / `expiries` 本地算，不打网关。
   交接说明见 [docs/options-bridge.md](../../../../docs/options-bridge.md)。
6. **数据**：akshare 上交所 510050/510300/510500/588000/588080；深市
   1599xx 报 `TRADING_NO_DATA`；CI 走 mock/synth 形状。

T 板 UI 仍归 workbuddy，本变更不改 `src/client/**`。

## Alternatives considered

- **第五市场 `cn-options`**：落选——爆破面与「中国上市 ETF 期权」不匹配。
- **`getOptionChain` 挂在 `MarketDataService`**：落选——CN 现行 provider
  是腾讯，方法会落空。
- **源仓 tool-options 整包搬**：落选——每调用 spawn `uv`，不适合 T 板轮询。
- **第一期含 MiniQMT 下单**：落选——源仓无期权执行模块。

## Consequences

- 新包 `@dshtrading/connector-options` 进 `@dshtrading/cn` dependencies 与
  host dataplane 行 `dsh-trading-cn-dataplane-options`。装过本仓的 profile
  的 pnpm overrides 需加一行（坑 #15），刷新前先停实例。
- `GET /options/underlyings` 走连接器静态名册，网关未启动时 T 板仍能判断显隐；
  链/IV/策略在网关未启动时返回 `TRADING_NETWORK`，不空转假成功。
- 桥 JSON 字段一经发布只加可选字段、不改名（workbuddy 并行）。
- 检索目录补齐注册 ETF 期权标的（`510050.SH` 等）；CN 种子自选加一行
  `510050`（上证50ETF），未定制过自选的用户左栏能直接点进现货再开 T 板。
  「删光自选不复活种子」用例按当前种子表逐行删，不再写死三只 A 股。
- kit-cn 期权工具把可选 `source` / `expiryMonth` / `template` / `rate` 缺席时整键
  省略（`exactOptionalPropertyTypes`），不把类型债抬过棘轮基线 23。
- `cn-risk-checklist` 增补义务仓 / 乘数·张 / 临近到期 / 深市 `NO_DATA` /
  长代码纪律；Windows 上该文件曾是断裂 symlink，现改为随包正文。
- 本机网关冒烟：`GET /health`、synth `910050/2612`、akshare `510050/2609`
  均成功；原始 JSON 在 `spikes/impl-cn-etf-options/`。
- Windows `trading-web` 用 `scripts/link-trading-web-workspace.ps1` 把本仓全部
  `@dshtrading/*` junction 进 profile（只挂 api/cn 会留下 0.1.4 连接器实拷，
  dataplane 双 apply），再跑 `refresh-trading-web-profile.ps1` 把 `cordis` 等
  宿主核心包挂到 `.local`；不跑会重物化影子拷贝的 `dsh plugin install`。
