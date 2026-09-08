# CN ETF 期权桥契约（workbuddy 交接）

后端已挂只读面。T 型报价板与 QuoteStage「期权」页签由 **workbuddy** 做，不要改
`packages/client-ui-*/src/client/**` 以外的桥/连接器。

认证与其它 `/dshtrading/api/*` 相同（cookie / token URL）。业务错误是 HTTP 200 +
`{ ok: false, code, message }`。

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dshtrading/api/options/underlyings?source=akshare\|synth` | 注册标的名册（**静态，不打网关**；页签显隐用这个） |
| GET | `/dshtrading/api/options/expiries?underlying=&source=` | 标准四季月（当月/次月/+3/+6，第四个周三；**不打网关**） |
| GET | `/dshtrading/api/options/chain?underlying=&expiryMonth=&source=` | T 型报价 |
| GET | `/dshtrading/api/options/implied-vol?underlying=&expiryMonth=&rate=&source=&priceField=` | 链截面 IV |
| POST | `/dshtrading/api/options/strategy` | 多腿模板 / 保证金（JSON body） |

`underlying` 接受 `510050.SH`、`510050`、`510050C2609M02850`。
`expiryMonth` 为 `YYMM`（如 `2609`）。

## 成功形状

```json
{
  "ok": true,
  "chain": {
    "underlying": "510050",
    "expiryMonth": "2609",
    "expiryDate": "2026-09-23",
    "snapshotAt": "2026-09-08T02:00:00+08:00",
    "source": "akshare",
    "calls": [{ "code": "510050C2609M02850", "strike": 2.85, "last": 0.12, "prevSettle": 0.11, "changePct": 0.09, "volume": 123 }],
    "puts": [{ "code": "510050P2609M02850", "strike": 2.85, "last": 0.08 }]
  }
}
```

`code` 是规范长代码。不要把新浪短码当 symbol。

## 错误码

| code | 含义 | UI |
|---|---|---|
| `TRADING_NOT_IMPLEMENTED` | 未挂 `connector-options` | 隐藏期权页签 |
| `TRADING_NO_DATA` | 深市 akshare 无行情等 | 空态 + 原文 message |
| `TRADING_NETWORK` | 网关 `127.0.0.1:8090` 未起 | 提示启动 `uv run python -m dsh_options.gateway` |
| `TRADING_UNSUPPORTED_SYMBOL` | 不是注册标的 / 缺 expiryMonth | 400 或缺参提示 |
| `TRADING_UPSTREAM_ERROR` | 网关非 JSON / HTTP 失败 | 重试 |

## 页签建议（不代写 UI）

1. `GET /options/underlyings`：仅 `market === 'cn'` 且名册含当前 6 位码时显示「期权」
2. `GET /options/expiries?underlying=`：画到期月胶囊（不依赖网关）
3. `GET /options/chain?underlying=&expiryMonth=`：填 T 表（需要网关）
4. 点某一档不要切换图表标的
5. 类型从 `@dshtrading/api` 取，不要在 client 另造一份

本页不构成投资建议。
