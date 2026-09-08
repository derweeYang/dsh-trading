# CN ETF 期权桥契约（workbuddy 交接）

后端已挂只读面（阶段 0）+ 交易面与互联（阶段 3/4）。T 型报价板、下单面板、
标的互联跳转由 **workbuddy** 做，不要改 `packages/client-ui-*/src/client/**`
以外的桥/连接器。

认证与其它 `/dshtrading/api/*` 相同（cookie / token URL）。业务错误是 HTTP 200 +
`{ ok: false, code, message }`。

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dshtrading/api/options/underlyings?source=akshare\|iquant\|synth` | 注册标的名册（**静态，不打网关**；页签显隐用这个；阶段 4 起带 `heldQty?`） |
| GET | `/dshtrading/api/options/resolve?symbol=` | 现货 ↔ 长代码双向规范化（阶段 4，纯本地不打网关） |
| GET | `/dshtrading/api/options/expiries?underlying=&source=` | 标准四季月（当月/次月/+3/+6，第四个周三；**不打网关**） |
| GET | `/dshtrading/api/options/chain?underlying=&expiryMonth=&source=` | T 型报价（阶段 4 起桥侧回填 `spot`） |
| GET | `/dshtrading/api/options/implied-vol?underlying=&expiryMonth=&rate=&source=&priceField=` | 链截面 IV |
| GET | `/dshtrading/api/options/vol-analytics?underlying=&expiryMonths=&asOf=&rate=&dividendYield=&source=` | 波动率分析（期限结构/skew/IV 分位/HV，透传） |
| GET | `/dshtrading/api/options/overview?source=&sort=strength\|iv\|holdings&includeIv=0\|1` | 九标的总览（C1：现货/T-5/底仓/持仓聚合；`includeIv=1` 才打网关） |
| POST | `/dshtrading/api/options/strategy` | 多腿模板 / 保证金（JSON body；阶段 4 起支持 `holdingQty`） |
| POST | `/dshtrading/api/options/order` | 期权下单（阶段 3 交易面） |
| DELETE | `/dshtrading/api/options/order?id=` | 期权撤单（阶段 3） |
| GET | `/dshtrading/api/options/positions` | 期权持仓（阶段 3，只读） |

`underlying` 接受 `510050.SH`、`510050`、`510050C2609M02850`。
`expiryMonth` 为 `YYMM`（如 `2609`）。默认 `source=iquant`，走国信 iQuant：
标的现货市场 `SH`/`SZ`，**期权合约市场 `SHO`/`SZO`**（短码 `100xxxxx.SHO` /
`900xxxxx.SZO`）。长代码不是行情主键，须先映射短码。深市别只依赖
akshare（`szse_static_only` → `TRADING_NO_DATA`）。

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
    "spot": 2.912,
    "calls": [{ "code": "510050C2609M02850", "strike": 2.85, "last": 0.12, "prevSettle": 0.11, "changePct": 0.09, "volume": 123 }],
    "puts": [{ "code": "510050P2609M02850", "strike": 2.85, "last": 0.08 }]
  }
}
```

`code` 是规范长代码。不要把新浪短码当 symbol。`spot` 由桥侧从 CN 现货行情
（tradingCnMarketData）回填——ATM 高亮 / 实值虚值分色直接用；行情缺席时该键
可能缺失或为 python 链自带快照，UI 要容错。

## 阶段 4 互联

### resolve（双向跳转）

```json
GET /options/resolve?symbol=510050c2609m02850
{
  "ok": true,
  "input": "510050C2609M02850",
  "underlying": "510050",
  "link": { "underlying": "510050", "spotSymbol": "510050.SH", "exchange": "SSE",
            "callPrefix": "510050C", "putPrefix": "510050P" },
  "contract": { "code": "510050C2609M02850", "optionType": "C", "strike": 2.85, "expiryMonth": "2609" }
}
```

- 现货输入（`510050.SH`）→ 有 `link` 无 `contract`；长代码输入 → 两者都有。
- 名册外 6 位码（如股票 `600519.SH`）→ `underlying` 正常返回、`link` 缺席
  （UI 据此隐藏期权入口）；非 CN 格式（`AAPL`）→ 400。
- 现货页 → 期权：`resolve` 拿 `underlying` 打开 T 板；T 板 → 现货：
  `link.spotSymbol` 切行情标的。

### 名册 heldQty（底仓视角）

`GET /options/underlyings` 每行多一个可选 `heldQty`（从统一资产台账聚合的
ETF 持仓份额，多账户求和）。有底仓的标的高亮「备兑可用」；无持仓键缺席。
heldQty ÷ multiplier(10000) 向下取整 = 可覆盖备兑张数。

### strategy holdingQty（组合预填）

```json
POST /options/strategy
{ "underlying": "510050.SH", "template": "covered_call",
  "expiryMonth": "2612", "holdingQty": 25000,
  "templateParams": { "strike": 3.0 } }
```

`holdingQty` = 真实持仓份额。仅 `covered_call` / `collar` 有效：python 内核按
`floor(holdingQty / 10000)` 张同时预填现货腿与期权腿（两腿自动匹配）；不足
1 张或配错模板 → `TRADING_UNSUPPORTED_SYMBOL` + message。响应的
`legs[].qty` 就是匹配后的张数（现货腿是份额）。

### vol-analytics（波动率分析，报告透传）

```json
GET /options/vol-analytics?underlying=510050&expiryMonths=2609,2612&rate=0.02&source=akshare
{
  "ok": true,
  "volAnalytics": { "underlying": "510050", "iv_percentile": { "w252": 0.62 }, "...": "python vol_analytics 报告原样" }
}
```

- `underlying` 必填；`expiryMonths` 逗号分隔 YYMM（缺省 = 标准四季月全集）；
  `asOf`（YYYY-MM-DD）/ `rate` / `dividendYield` / `source` 可选。
- `volAnalytics` 是 python 内核报告 **JSON 透传不解释**（形状由
  `python/options` 的 `vol_analytics` handler 定义；agent 工具
  `cn_get_option_vol_analytics` 同源）。总览页 IV 分位排序直接读
  `iv_percentile`；显示前对缺键容错。
- 显式给出但非法的数值（如 `rate=abc`）→ 400，不静默换默认值。

### overview（九标的总览，C1/C2）

```json
GET /options/overview?sort=strength&includeIv=0
{
  "ok": true,
  "overview": {
    "source": "akshare",
    "sort": "strength",
    "asOf": "2026-09-08T09:00:00.000Z",
    "scanAllPrompt": "Scan these China ETF option underlyings… not investment advice.",
    "rows": [{
      "underlying": "510050",
      "name": "华夏上证50ETF",
      "exchange": "SSE",
      "spotSymbol": "510050.SH",
      "last": 2.91,
      "changePct": 0.4,
      "return5d": 1.2,
      "volumeRatio": 0.8,
      "strengthScore": 0.96,
      "days": [{ "date": "2026-09-04", "changePct": 0.3, "volumeSurge": false }],
      "divergence": "weak_rally",
      "heldQty": 20000,
      "optionQty": 2,
      "scanPrompt": "Scan China ETF option underlying 510050…"
    }]
  }
}
```

- 名册来自 `listUnderlyings`；**SYNTH 行不进表**。现货 / 日 K 走 `tradingCnMarketData`，
  单行失败键缺席，不整页失败。未挂 `connector-options` → `TRADING_NOT_IMPLEMENTED`。
- `sort`：`strength`（默认，5 日动量 × 量能比）、`iv`（需 `includeIv=1`）、`holdings`
  （`heldQty` 再 `optionQty`）。
- `includeIv=1` 才打 `vol_analytics`；IV 失败该行无 `ivPercentile`。默认不打网关。
- `days` 最多 5 格：`changePct` 做色深，`volumeSurge`（当日量 / 5 日均量 > 1.5）做边框。
- `scanPrompt` / `scanAllPrompt` 给 C2：`fillComposer` 原样预填。文案含
  「technical analysis / not investment advice / do not place live orders」。
  点行进 T 板仍用 `GET /options/resolve`。

## 阶段 3 交易面

### POST /options/order（下单）

```json
{ "symbol": "510050C2609M02850", "side": "buy", "offset": "open",
  "orderType": "limit", "quantity": 1, "price": 0.0856, "dryRun": false }
```

- `quantity` 单位**张**（正整数）；`price` 元/张权利金（limit 必填正数）。
- **默认请求实盘**（`dryRun` 缺省 false，与股票交易台一致）；安全由服务缝
  双闸兜底：连接器 `dryRun` 缺省 true（本地模拟回执）、实盘需宿主显式开
  `liveTrading`。闸门拒绝 → `TRADING_LIVE_TRADING_DISABLED`，UI 原文展示。
- 成功回执 `order.premiumAmount` = price × quantity × multiplier（0.0856×1×10000
  = **856 元**）——权利金金额直接显示，别再乘乘数。
- `offset`：`open`（开仓：义务仓收保证金 / 权利仓付权利金）/ `close`（平仓）。

### DELETE /options/order?id=（撤单）

撤单与真实下单同门槛（服务缝闸门）；成功 `{ ok: true, canceled: true }`。

### GET /options/positions（持仓）

```json
{ "ok": true, "positions": [
  { "symbol": "510050C2609M02850", "underlying": "510050", "optionType": "C",
    "strike": 2.85, "expiryMonth": "2609", "quantity": 2,
    "avgPrice": 0.081, "marginOccupied": 6840 } ] }
```

`quantity` 正 = 权利仓、负 = 义务仓。义务仓的 `marginOccupied` 是网关回报值；
**下单前预估**用 `POST /options/strategy` 的 `margin` 块（沪深标准 12%/7%，
covered short call 现货抵扣 0）。

## 错误码

| code | 含义 | UI |
|---|---|---|
| `TRADING_NOT_IMPLEMENTED` | 未挂 `connector-options` | 隐藏期权页签 |
| `TRADING_NO_DATA` | 深市 akshare 无行情等 | 空态 + 原文 message（可切 source=iquant） |
| `TRADING_NETWORK` | 网关 `127.0.0.1:8090` 未起 | 提示启动 `uv run python -m dsh_options.gateway` |
| `TRADING_UNSUPPORTED_SYMBOL` | 不是注册标的 / 缺 expiryMonth / holdingQty 非法 | 400 或缺参提示 |
| `TRADING_LIVE_TRADING_DISABLED` | 双闸拒绝实盘（缺省态点实盘） | 原文展示 + 提示需开 liveTrading |
| `TRADING_AUTH_FAILED` | live 期权未配 accountId | 提示配 `accountId` |
| `TRADING_EXCHANGE_ERROR` | QMT 网关报单失败 | 原文展示 |
| `TRADING_UPSTREAM_ERROR` | 网关非 JSON / HTTP 失败 | 重试 |

## 页签建议（不代写 UI）

1. `GET /options/underlyings`：仅 `market === 'cn'` 且名册含当前 6 位码时显示「期权」
2. `GET /options/expiries?underlying=`：画到期月胶囊（不依赖网关）
3. `GET /options/chain?underlying=&expiryMonth=`：填 T 表（需要网关）；`spot`
   有值时高亮 ATM 行、实/虚值分色
4. 点某一档不要切换图表标的
5. 类型从 `@dshtrading/api` 取，不要在 client 另造一份
6. 交易台与下单面板：dry-run 回执与 live 回执同形（`dryRun` 字段区分），
   T+0 期权但义务仓有保证金占用，下单面板同时展示 premiumAmount 与预估保证金

本页不构成投资建议。
