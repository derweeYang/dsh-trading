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
| GET | `/dshtrading/api/options/overview?source=&sort=strength\|iv\|holdings&includeIv=0\|1` | 九标的总览（C1：现货/T-5/底仓/持仓聚合；`includeIv=1` 才打网关；行带 `ivRegime`） |
| GET | `/dshtrading/api/options/bar-packet` | 当天最新 ContextPacket（定时桶宿主打标；无文件则只有 `{ ok:true }`） |
| GET | `/dshtrading/api/options/intraday-box?underlying=&horizon=5&asOf=` | 1 分钟 → 5 分钟箱体（L2；现货 1m K，不打期权网关） |
| GET | `/dshtrading/api/options/cycles?underlying=&limit=` | 5 分钟闭环历史（先 forecast，下一桶补 score） |
| GET | `/dshtrading/api/options/cycles/loop` | 九标的最新周期 + 命中率（页面可视化 SSOT） |
| POST | `/dshtrading/api/options/cycles/tick` | 对齐当前上海 5 分钟桶（幂等；宿主 30s 心跳已在跑） |
| POST | `/dshtrading/api/options/strategy` | 多腿模板 / 保证金（JSON body；阶段 4 起支持 `holdingQty`） |
| POST | `/dshtrading/api/options/order` | 期权下单（阶段 3 交易面） |
| DELETE | `/dshtrading/api/options/order?id=` | 期权撤单（阶段 3） |
| GET | `/dshtrading/api/options/positions` | 期权持仓（阶段 3，只读） |

`underlying` 接受 `510050.SH`、`510050`、`510050C2609M02850`。
`expiryMonth` 为 `YYMM`（如 `2609`）。默认 `source=iquant`，走国信 iQuant：
标的现货市场 `SH`/`SZ`，**期权合约市场 `SHO`/`SZO`**（短码 `100xxxxx.SHO` /
`900xxxxx.SZO`）。长代码不是行情主键；行情网关从合约简称组 T 板后再写回长代码。
iQuant 名册覆盖九只 ETF 期权标的。深市别只依赖 akshare（`szse_static_only` →
`TRADING_NO_DATA`）。

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
      "ivRegime": "unknown",
      "heldQty": 20000,
      "optionQty": 2,
      "strategy": {
        "opportunity": "theta_rent",
        "template": "butterfly",
        "edge": "range_hold 收时间价值",
        "noTrade": false,
        "bucketStart": "2026-09-09T05:50:00.000Z",
        "invalidIf": "1-minute close outside box"
      },
      "scanPrompt": "Scan China ETF option underlying 510050…"
    }]
  }
}
```

- 名册来自 `listUnderlyings`；**SYNTH 行不进表**。现货 / 日 K 走 `tradingCnMarketData`，
  单行失败键缺席，不整页失败。未挂 `connector-options` → `TRADING_NOT_IMPLEMENTED`。
- `sort`：`strength`（默认，5 日动量 × 量能比）、`iv`（`ivPercentile`，缺席回落 `atmIv`）、`holdings`
  （`heldQty` 再 `optionQty`）。
- 默认回填近月 `atmIv`（`implied_vol`，进程内 5 分钟缓存）；`includeIv=1` 才打 `vol_analytics` 分位。
  同行写 `ivRegime`（近/次月 ATM ≥ 1.15 → `event_front`；否则分位 ≥0.8 `rich` / ≤0.2 `cheap`；否则 `atmIv` 对 `hv20`）。
  `nextAtmIv` 为次月 ATM。`hv20` 来自近 21 根日 K。`iv-daily.jsonl` 只从已落盘 packets 回填（活牌无 asOf 历史 IV）。满 60 日后补本机分位。
  **不要把 `atmIv` 当成分位。** iQuant 无历史 IV 路径，`ivPercentile` 常缺席。任一路失败该行键缺席，不整页失败。
  盘后标的现货走日 K 收盘（与 iquant `ticker` 同一回落），合约价走 T 板已有的日 K 回落。
- `days` 最多 5 格：`changePct` 做色深，`volumeSurge`（当日量 / 5 日均量 > 1.5）做边框。
- `scanPrompt` / `scanAllPrompt` 给 C2：`fillComposer` 原样预填。文案含
  「technical analysis / not investment advice / do not place live orders」。
  点行进 T 板仍用 `GET /options/resolve`。
- `scanPrompt` / `scanAllPrompt` 要求先调 `cn_get_option_intraday_box`，禁止自编箱体。
- `strategy`（可选）：当天 `data/options/recommendations/YYYY-MM-DD.jsonl` 最新
  一行投影到该标的。有 pick → `opportunity` + `template` + `edge`；无 pick /
  全市场 stub → `opportunity=no_edge` + 可选 `skipReason`。当天最新 ContextPacket
  同行会投影 `strategy.ivRegime`。无账本文件则**不写**该键。不是现场算箱体，也不改排序。

### bar-packet（定时桶 ContextPacket）

```json
GET /options/bar-packet
{
  "ok": true,
  "packet": {
    "bucketStart": "2026-09-10T01:45:00.000Z",
    "asOf": "2026-09-10T01:45:12.000Z",
    "rows": [{
      "underlying": "510050",
      "regime": "range_hold",
      "ivRegime": "unknown",
      "candidates": ["butterfly"],
      "volumeRatio": 0.8,
      "divergence": "weak_rally",
      "atmIv": 0.21
    }]
  }
}
```

- 无当天 `data/options/packets/` → `{ ok: true }`，不写 `packet` 键。
- `volumeRatio` 是总览 5d/20d，不是箱体 1 分钟量比。前端只展示，不算制度。

### intraday-box（1 分钟 → 5 分钟箱体，L2）

```json
GET /options/intraday-box?underlying=510050.SH&horizon=5&asOf=2026-09-08T02:30:00.000Z
{
  "ok": true,
  "box": {
    "asOf": "2026-09-08T02:30:00.000Z",
    "horizonMin": 5,
    "lookback": 60,
    "rows": [{
      "underlying": "510050",
      "spotSymbol": "510050.SH",
      "last": 3.0,
      "boxLow": 2.991,
      "boxHigh": 3.009,
      "regime": "range_hold",
      "session": "regular",
      "candidates": [{ "template": "butterfly", "bias": "neutral", "invalidIf": "…", "reason": "…" }]
    }]
  }
}
```

- `underlying` 可缺省或 `all` = 名册去 SYNTH 全表；指定未知名 → `TRADING_UNSUPPORTED_SYMBOL`。
- `horizon` 只接受 `5`（或缺省）。`asOf` 可选 ISO，供回放；会话门按 Asia/Shanghai。
- 计算在 `@dshtrading/kit-cn` 纯函数（σ√5 与 ATR√5 取宽、Donchian15、VWAP）。
  开盘 15 分 / 午休边 5 分 / 尾盘 5 分 / 盘后 → `regime=no_trade`。
- 现货 1m 走 `tradingCnMarketData`（iquant 支持 `1m`；腾讯会 `TRADING_UNSUPPORTED_INTERVAL`，该行 `no_trade`）。
  单行失败不整页失败。不打期权网关。
- agent 工具 `cn_get_option_intraday_box` 同源。编排见 skill `option-intraday-workflow`。
- 本页不构成投资建议；箱体是执行滤网，不是期权定价主因。

### cycles / loop（5 分钟闭环）

宿主 node 半每 30s 调一次 tick，对齐 Asia/Shanghai 5 分钟桶（幂等）。
**不要**用右侧栏 Agent cron 扫箱体——那是拉会话，不是打分引擎。

```json
GET /options/cycles/loop
{
  "ok": true,
  "loop": {
    "running": true,
    "horizonMin": 5,
    "lastBucket": "2026-09-08T02:30:00.000Z",
    "rows": [{
      "underlying": "510050",
      "stats": { "n": 4, "hits": 2, "misses": 1, "partials": 0, "skipped": 1, "hitRate": 0.67 },
      "latest": {
        "id": "510050:1757305800000",
        "bucketStart": "2026-09-08T02:30:00.000Z",
        "forecast": { "regime": "range_hold", "boxLow": 2.99, "boxHigh": 3.01 },
        "score": { "verdict": "hit", "closeInside": true, "barCount": 5 },
        "calibration": "none"
      }
    }]
  }
}
```

- 本桶只写 `forecast`；**下一桶**用已走完的 5 根 1 分钟 K 给上一桶补 `score`。
- `verdict`：`hit` / `partial` / `miss` / `skipped`（no_trade / K 线不足）。
- 连续 3 次 miss → 下一桶 `calibration=suppressed`，`regime=no_trade`，`noTradeReason=calibrated`。
- 内存环（每标的 48 桶），进程重启清空。不下单、不调 LLM。
- `POST /options/cycles/tick` body `{ asOf? }` 供回放；页面只读 GET。成功体另含 `asOf`。
- 新桶会追加 `data/options/cycles/YYYY-MM-DD.jsonl`。`regular` 时段事件触发一轮 trader（不是右侧栏 cron）。推荐写入 `data/options/recommendations/`；`close5` 写 `reviews/`（无 LLM）。见 [spec](specs/2026-09-08-option-bar-agent.md)。

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
