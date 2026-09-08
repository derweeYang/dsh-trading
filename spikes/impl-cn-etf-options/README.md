# Spike: CN ETF 期权数据面

第一期后端：`tradingCnOptions` → `http://127.0.0.1:8090` → `python/options`。

离线证据：connector / kit / bridge 单测用 synth 形状的 mock JSON（不触网）。
本机 Python 3.14 + numpy/pandas 已跑通 `handle_chain(synth, 910050, 2612)`，摘要见
`synth-910050-chain.json`（9 call / 9 put，样本长代码 `910050C2612M02800`）。

实网证据（本机有网关 + akshare 时留下原始响应）：

```powershell
cd python\options
uv sync
uv run python -m dsh_options.gateway
```

```
POST http://127.0.0.1:8090/v1/chain
{"source":"akshare","underlying":"510050","expiryMonth":"<当月YYMM>"}
```

把 stdout JSON 存进本目录 `akshare-510050-chain.json`。深市 `159915` 期望
`NO_DATA` / `szse_static_only`，不要用空 calls/puts 冒充成交。

2026-09-08 本机网关已留下实网证据：`akshare-510050-chain.json`（2609，14×14，
样本 `510050C2609M02650`）；深市 `akshare-159915-nodata.json` 为 `NO_DATA` /
`szse_static_only`。
