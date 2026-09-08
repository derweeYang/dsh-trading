# dsh-options

从 `trading-agent_v3/deepseek-harness` vendor 进 dsh-trading 的 ETF 期权内核。
本仓消费方是 `@dshtrading/connector-options`：常驻 HTTP 网关
`python -m dsh_options.gateway`（默认 `127.0.0.1:8090`），不要每次工具调用
`uv run` 拉进程。CLI（stdin JSON / stdout JSON）仍可用于手工冒烟。

experimental `tool-options` 插件（O 轨道，Phase O1–O5）的期权内核。TS 插件每次工具调用拉起 `dsh-options <subcommand>`，stdin 传入一个 JSON 请求文档，stdout 读回恰好一个 JSON 响应文档；诊断信息走 stderr。

## 子命令

- `underlyings` —— 已注册的 ETF 期权标的（代码 / 交易所 / 乘数 / tick），来自随包注册表（`data/underlyings.json`），不硬编码在代码里。
- `contracts` —— 合约静态表（长代码 / 行权价 / 到期日 / 乘数 / tick）。上交所从行情接口推导；深交所来自交易所静态表（合约单位 10000、到期日=第四个周三，2026-09-23 实测核对）。
- `chain` —— 单到期月的 T 型报价快照：calls/puts 按行权价对齐，交易所快照时间戳透传（Asia/Shanghai）。
- `fetch_daily` —— 单合约全历史日线 OHLCV，parquet 缓存（cache-first）。
- `fetch_underlying_daily` —— 标的 ETF 自身现货日线。`akshare` 走东财 `fund_etf_hist_em`（沪深通用）；`iquant` 走 `dsh-iquant-quote` `history_bars`（无 qfq/hfq）。无 synth。缺省或 `underlying=all` 拉该 source 注册表全表；单标的失败抛原始错误码，批量部分失败写入 `failures`，批量全失败传播首个错误，不把 `NETWORK` 降级为 `NO_DATA`。
- `price` —— 显式参数的欧式 BSM 定价 + 全 Greeks（delta/gamma/vega/theta/rho，双单位），响应 meta 携带显式 `dividendYield`（缺省 0）与 `priceBasis`。
- `implied_vol` —— 链快照逐合约 Brent 隐波反解。失败逐行分类列出、绝不丢行：`below-intrinsic`、`above-upper-bound`、`unconverged`、`no-data-on-asof`。
- `vol_analytics` —— 多月波动率汇总（O4-min / O4-pct / O4-smile / O4-svi）：ATM 期限结构、最近已收敛行的 25Δ skew（距离 >0.15 记 `insufficient`，不插值）、标的已实现波动率（缺省窗口 20/60/120；synth 走合成现货，akshare 走 `fetch_underlying_daily`）、ATM IV 百分位（缺省窗口 60/252，平均秩；synth 按日重选 ATM 反解，akshare 活牌无历史路径标 `insufficient`）、当日中点 IV 二次最小二乘微笑（残差与拟合价蝶形只打标；少于 3 档不足）、到期月 Raw SVI（`volsurface`；少于 5 档不足；残差、拟合价蝶形与 Gatheral–Jacquier 条件只打标）、离散蝶形权利金凸性（残差 < −2×tick 只打标）、可选 term/smile PNG（`vizDir` 缺失则 `charts=[]`）。已到期月标 `expired`，不让整次调用失败。`cacheDir` 必填。无 SSVI。
- `strategy` —— 显式腿与/或模板（`covered_call` / `collar` / `vertical` / `straddle` / `butterfly`）组成多腿书：到期损益网格、净 Greeks、沪深 ETF 标准义务仓保证金（12%/7%，备兑短 call 现金 0）。保证金是逐腿加总，不是券商上浮，也不是交易所组合策略净额。卖空标的腿 `unsupported`，不计入合计。可选 payoff/greeks PNG（`vizDir` 缺失则 `charts=[]`）。`cacheDir` 必填。无组合保证金、无强平。
- `parity_check` —— 同链同行权价 Call−Put 与远期价值检验：`deviation = (C−P) − (S·e^{−qT} − K·e^{−rT})`，阈值显式（缺省 `max(2×tick, 0.0005)`），偏离折算 tick 倍数并打标。

## 定价内核（O2）

Greeks 与 IV 全部自算（`bsm.py`，不引 QuantLib）：Merton 连续股息形态的 BSM、自实现 Brent 求根、基于单调性（BSM 价对 vol 严格递增——bracket 外无根、bracket 内唯一根）的无解分类。第三方 Greeks（新浪）仅作交叉验证——其模型、价格基准与快照时点是黑盒。2026-09-05 的 50ETF 近月实盘交叉验证：全部可解档 IV 一致（±0.026 内）；delta 的 moneyness 同侧 8/8，但数值差漂移 ±0.1——新浪快照与东财 spot 快照时点不同步所致；该漂移及其在真实盘面上制造的深度实值 `below-intrinsic` 行，如实报告、不隐藏。

价格基准全程显式（`priceField: last | prevSettle`）：akshare 侧的前结价是交易所结算价口径，synth 侧的 prevSettle 是前一日合成收盘——每个响应的 meta 都带 `priceBasisNote` 声明是哪一种，按结算价口径消费的下游（保证金、Greeks）不会张冠李戴。

`price` / `implied_vol` / `vol_analytics` 不含保证金；`strategy` 报沪深 ETF 标准义务仓逐腿加总（不是券商上浮，也不是组合策略净额），不含强平路径。

## 数据源

每个请求都要指明 `source`：

- `synth` —— 定种子的确定性合成期权链，不读时钟、不联网。刻意包含一个已摘牌合约（序列止于到期日）与一个故意的平价违反合约（供下游 parity 校验当靶子）。它证明管线，不证明市场事实。
- `akshare` —— 免费研究级数据。上交所系标的（50/300/500/科创50×2）：T 型报价走交易所接口，单合约全历史日线。深交所标的：**期权合约**仅静态表——行情与合约日线是已登记缺口（`szse_static_only`），按 `NO_DATA` 报告，不编造。标的 ETF 现货日线不受此限（`fetch_underlying_daily`，含 `159922`）。
- `iquant` —— 经本地 `dsh-iquant-quote` 网关（`:5810`）。注册表与 akshare 九只 ETF 期权标的对齐，`quotesSource=iquant_board`。适配器无 `iquantArgvPrefix` 时 POST 网关 `/v1/<subcommand>`。**行情市场 token**：标的现货 `SH`/`SZ`；期权合约必须 **`SHO`/`SZO`**。T 板由网关从合约简称（`50ETF购9月2650`）组链，盘后 drain 空则回落日 K。把期权短码订到 `SH` 会空——那是订错市场，不是「没有期权源」。深市在该源上不再是 `szse_static_only`。`UNSUPPORTED` 收成 `NO_DATA`。`asOf` 只属于 synth；定价 / IV 要求显式 `rate`。

合约存在两套代码体系：标准长代码（`510050C2609M02850`，桥/API 主键）与短代码（`10011255`）。akshare 日线走新浪短码映射（Greeks 接口懒建立、parquet 缓存；缺失报 `NO_DATA`，不猜测）。国信 live 行情簿主键是 **短码 + `SHO`/`SZO`**，不是长代码，也不是 `SH`/`SZ`。`EXCHANGE_MARKET` 现仍只映射现货 `SH`/`SZ`——live 合约订阅不得复用该表。

已到期月份的合约清单在新浪渠道**不可得**（2026-09-05 实测）；幸存者校正样本需要替代渠道（O 轨道计划 Task 9）。

## Wire 契约

```jsonc
// stdout, exactly one line
{ "ok": true, "result": { ... } }
{ "ok": false, "error": { "code": "BAD_REQUEST|NO_DATA|NETWORK|INTERNAL", "message": "..." } }
```

退出码与错误码对应（`0` 成功、`2` 请求错误、`3` 数据/网络、`4` 内部错误），但 TS 侧只信 stdout JSON。

## 开发

```sh
uv sync
uv run pytest                     # offline; network tests need DSH_OPTIONS_NETWORK_TESTS=1
uv run dsh-options chain < request.json
```
