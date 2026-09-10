# Agent Note: 国信 iQuant 主行情（删除 MiniQMT）

Status: implemented

## Problem

CN 默认行情走腾讯，券商通道是 MiniQMT（`qmt`，`:5800`，行情+交易）。本机国信
iQuant `QuoteClient` 更稳，且已实证 `SHO`/`SZO` 期权合约簿。用户要求：删除
MiniQMT（含股票/期权实盘），把 iQuant 行情设成主行情。

## Decision

- `@dshtrading/connector-iquant` + `python/iquant-quote`（`:5810`）是 CN 主行情。
- 默认 `cn.provider = iquant`，期权默认 `source=iquant`。
- 合约 live 订 `SHO`/`SZO`，现货仍 `SH`/`SZ`。
- `packages/connector-qmt` 已删除；router 词汇无 `qmt`。
- 期权 live 下单 / 撤单 / 持仓 `TRADING_NOT_IMPLEMENTED`；dry-run 预览回执保留。
- 腾讯 / 东财仍可手动切，失败不回落。
- 不改 `packages/client-ui-*/src/client/**`。设置候选由 workbuddy 去掉 MiniQMT、加上国信 iQuant。

规格见 [docs/specs/2026-09-08-iquant-quote-connector.md](../../../../docs/specs/2026-09-08-iquant-quote-connector.md)。

## Alternatives considered

- **只删 MiniQMT 行情、保留 :5800 交易**：用户否决，交易一并删。
- **只留 iQuant、删腾讯/东财**：用户否决，公共源保留手动切换。
- **网关失败回落腾讯**：用户否决，空就报 `TRADING_NETWORK`。
- **进程内 ctypes**：Node 不能加载 `iquant_quote.dll`。败。

## Consequences

- 日常入口 `start-trading-web.bat` 会另开窗口起 `:5810`（iQuant）与 `:8090`（期权分析网关）；已在听则跳过。只重启行情：`start-iquant-quote.bat`；只重启期权网关：`start-options-gateway.bat`；只重启宿主：`start-trading-web.ps1 -SkipIquant -SkipOptions`。手工行情：`python -m dsh_iquant_quote.gateway`（cwd 会切到 `bin.x64`）。
- 期权内核无 `iquantArgvPrefix` 时 POST `:5810/v1/<subcommand>`。
- 设置 UI 在 workbuddy 改完之前仍可能显示 MiniQMT。
- 盘后期权 drain 可空，验收以日 K / 名单为准。`LiveBackend.option_chain` 已从
  `SHO`/`SZO` 合约简称组 T 板（`50ETF购9月2650` → `510050C2609M02650`）；有 tick
  用 tick，没有则回落日 K，不再空抛 `NO_DATA`。iQuant 名册与九只 ETF 期权标的对齐。
- 现货 `ticker` 同样：盘后 snapshot 空或 `last=0` 时回落日 K。否则模拟下单拿不到
  `ticker.price`，会报「未获取到有效成交价格」。期权内核 `fetch_spot`（`implied_vol`
  现货）同样回落，否则总览 `atmIv` 盘后全空。
- 本机若把 `~/.dsh/settings.yaml` 的 `cn.provider` 钉成 `tencent`，GUI `/markets`
  会显示腾讯；改回 `iquant` 后注册表热切换。总览默认回填近月 `atmIv`（见
  [overview ATM IV](../bug-fix/2026-09-09-options-overview-atm-iv.md)）。
- `QuoteClient.request_history` 形参名 `symbol/period` 实为 `(market, code)`，后面是
  `start_ms, end_ms, period_ms, kline_type, limit, callback`。网关不得再插入 `"1d"`
  周期字符串（会 TypeError 10 vs 8–9）；回调是 `(status, tag, bars)`。改完须重启
  `:5810`（旧进程仍跑错误 arity）。
