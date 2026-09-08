# @dshtrading/connector-options

CN ETF 期权只读连接器：在 host 面 provide `tradingCnOptions`，经本地 HTTP 网关调用
`python/options` 内核。不注册 `tradingMarketDataRegistry`（CN 行情 provider 默认腾讯，
没有期权链）。不下单。

## 配置

| 键 | 缺省 | 说明 |
|---|---|---|
| `enabled` | true | 关闭则不 provide 服务 |
| `gatewayUrl` | `http://127.0.0.1:8090` | 期权网关；环境变量 `DSH_OPTIONS_GATEWAY_URL` |
| `source` | `akshare` | `akshare` 上交所研究级 / `synth` 离线确定性链；`DSH_OPTIONS_SOURCE` |

启动网关（仓库根）：

```powershell
cd python\options
uv sync
uv run python -m dsh_options.gateway
```

## 符号

- 现货：`510050.SH`（与 CN 规范形一致）
- 合约主键：长代码 `510050C2609M02850`
- 新浪短码只存在于内核内部，本连接器不输出

深市 1599xx 在 akshare 上是 `szse_static_only`：链报价返回 `TRADING_NO_DATA`，不编造。

T 型报价板 UI 由 workbuddy 消费桥路由，见 `docs/options-bridge.md`。
