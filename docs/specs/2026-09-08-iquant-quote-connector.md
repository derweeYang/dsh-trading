# Spec：国信 iQuant 主行情（删除 MiniQMT）

- 日期：2026-09-08
- 状态：implemented（删 MiniQMT 含交易；iQuant 作 CN 主行情；腾讯/东财可手动切、不自动回落；期权链默认 `source=iquant`）
- 决策记录：[`.agents/notes/implemented/feature/2026-09-08-iquant-quote-connector.md`](../../.agents/notes/implemented/feature/2026-09-08-iquant-quote-connector.md)
- SDK：`D:\workspace\myquant\iquant_market_clean_fresh`（`iquant.quote.QuoteClient`）
- 分工：后端（Cursor）做连接器 / 网关 / 路由默认 / 删 QMT；设置候选文案归 workbuddy

## 0. 2026-09-08 live 更正

国信行情 **有** 期权合约簿。官方 `ContextInfo` 用 `10002235.SHO`。

| 市场 token | 品种 | 2026-09-08 登录后 |
|---|---|---|
| `SH` / `SZ` / `BJ` / `HK` | 股票 / ETF / 债 | `510050` last=3.017 |
| **`SHO`** | 上证期权（`100xxxxx`） | 名单 12416；`10011255` 日 K 通 |
| **`SZO`** | 深证期权（`900xxxxx`） | 名单 8034 |
| `OPT` / `OP` | — | 空，不要用 |

订错市场（期权短码订 `SH`）会空。长代码不是行情主键。

## 1. 范围

做：

- slug `iquant`，包 `@dshtrading/connector-iquant`，只 `MarketDataService`
- 默认 `dshtrading.markets.cn.provider = iquant`
- 默认期权 `source=iquant`
- 常驻 Python 行情网关 `127.0.0.1:5810`
- 合约 live 订 `SHO`/`SZO`，标的现货仍 `SH`/`SZ`
- **删除** `@dshtrading/connector-qmt` 与 router 词汇 `qmt`
- 期权交易 live 路径 fail-closed：`TRADING_NOT_IMPLEMENTED`（dry-run 预览回执保留）
- 腾讯 / 东财 dataplane 行保留，失败不回落

不做：

- 不加 iQuant `TradeService`
- 不改 `packages/client-ui-*/src/client/**`
- 不在行情网关内算 IV

## 2. 数据流

```
GUI / cn_get_ticker / options chain
        │
        ▼
cn.provider 默认 iquant
        │
        ▼
connector-iquant → http://127.0.0.1:5810
        │
        ▼
python/iquant-quote   cwd=bin.x64
  现货 SH/SZ    合约 SHO/SZO
```

期权内核 `source=iquant` 无 `iquantArgvPrefix` 时 POST 同一网关 `/v1/<subcommand>`。

## 3. Python 网关

路径：`python/iquant-quote/`。Windows 双击仓库根 `start-iquant-quote.bat`（实现在 `scripts/start-iquant-quote.ps1`）。手工：`python -m dsh_iquant_quote.gateway`。

| 变量 | 缺省 |
|---|---|
| `IQUANT_SDK_ROOT` | `D:\workspace\myquant\iquant_market_clean_fresh` |
| `IQUANT_API_DLL` | `{SDK}/build/native/Release/iquant_quote.dll` |
| `IQUANT_QMTQUOTE_DLL` | 国信 `bin.x64\qmtquote.dll` |
| `IQUANT_QUOTE_CONFIG` | 国信 `config\xtquoterconfig.xml` |
| `IQUANT_QUOTE_GATEWAY_PORT` | `5810` |

| 方法 | 路径 |
|---|---|
| GET | `/health` |
| GET | `/v1/ticker?symbol=` |
| GET | `/v1/klines?symbol=&interval=&limit=` |
| GET | `/v1/instruments?market=` |
| POST | `/v1/snapshot` / `history_bars` / `option_chain` / `option_instruments` |

长代码 → `BAD_REQUEST`。网关不可达 → `NETWORK` / `TRADING_NETWORK`，不编造。

## 4. TypeScript

- `packages/cn` 依赖改挂 `connector-iquant`，去掉 `connector-qmt`
- `PROVIDER_VOCABULARY`：删 `qmt`，加 `iquant`
- `DEFAULT_MARKETS.cn.provider = 'iquant'`
- `connector-options` 默认 source `iquant`；删 `QmtOptionTradeRestClient`

## 5. workbuddy

设置 UI：加「国信 iQuant」(`:5810`)，去掉 MiniQMT 候选，默认选中 iQuant。
本变更不改 `src/client/**`。

## 6. 验收

- 假网关：`510050.SH` → SH；`10011255.SHO` → SHO；宕机 → `TRADING_NETWORK`
- live：`510050.SH` ticker；`10011255.SHO` 日 K
- `pnpm --filter @dshtrading/connector-iquant test`、`pnpm test`、`pnpm build`
- 无 `packages/connector-qmt`

## 7. 非目标

- iQuant 股票 / 期权下单
- 把厂商 DLL 推进 git
