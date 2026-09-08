# @dshtrading/connector-options

CN ETF 期权只读连接器：在 host 面 provide `tradingCnOptions`，经本地 HTTP 网关调用
`python/options` 内核。默认 `source=iquant`。不注册 `tradingMarketDataRegistry`。
live 下单已随 MiniQMT 删除。

## 配置

| 键 | 缺省 | 说明 |
|---|---|---|
| `enabled` | true | 关闭则不 provide 服务 |
| `gatewayUrl` | `http://127.0.0.1:8090` | 期权网关；环境变量 `DSH_OPTIONS_GATEWAY_URL` |
| `source` | `iquant` | `iquant` 国信（合约 `SHO`/`SZO`）/ `akshare` / `synth`；`DSH_OPTIONS_SOURCE` |

启动网关（仓库根）：

```powershell
cd python\options
uv sync
uv run python -m dsh_options.gateway
```

## 符号

- 现货：`510050.SH`（与 CN 规范形一致；国信现货市场 token 是 `SH`/`SZ`）
- 桥 / API 合约主键：长代码 `510050C2609M02850`（本连接器输出这个）
- 国信行情簿主键：短码 + **`SHO`/`SZO`**（上证 `100xxxxx.SHO`，深证 `900xxxxx.SZO`）。长代码不是行情主键，内核须先映射。把短码订到 `SH`/`SZ` 会空。
- 新浪短码只存在于 akshare 内核内部，本连接器不输出

深市 1599xx 在 akshare 上是 `szse_static_only`：链报价返回 `TRADING_NO_DATA`，不编造。
`source=iquant` 解这个缺口（适配器默认仍 `synth`；`iquantSource: live` 才登录 DLL）。

T 型报价板 UI 由 workbuddy 消费桥路由，见 `docs/options-bridge.md`。
