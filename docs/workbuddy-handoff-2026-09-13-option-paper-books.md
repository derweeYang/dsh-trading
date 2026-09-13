# workbuddy 前端交接（2026-09-13 期权双虚拟账户 → 资产面板）

> 起草人：后端（分支 `feat/option-paper-books`）｜交接对象：workbuddy（前端）
> 背景：期权纸账户已升级为**双账本**（`strategy` 策略 + `arbitrage` 套利），各 10 万初始资金，
> 由 30s 心跳 `optionCycleTick` 全自动驱动（捕捉到机会立即以对手价成交，收敛/反转/到期自动平仓）。
> 本文件给三部分：A 账本机制速览、B 桥路由与 wire JSON 全形状（权威契约）、
> C 资产面板（HoldingsPanel）对接需求。**交接面 = 桥 JSON，账本逻辑全部在后端，前端只读展示。**

---

## A. 双账本机制速览（前端只需知道展示什么）

| | strategy（策略账户） | arbitrage（套利账户） |
|---|---|---|
| 驱动 | 5 分钟桶 LLM 策略推荐（`tryPaperOpen`/`tryPaperManage`，旧行为不变） | 平价 parity + 箱型 box 套利扫描（`tryArbPaperCycle`，30s 心跳、7 标的×近/次月、60s 链缓存） |
| 开仓 | 推荐信号 → 链价成交 | `executable` 机会 → **立即以对手价成交**（buy 吃 ask / sell 吃 bid），开仓前 on-hit 重拉链二次确认 |
| 平仓 | invalidIf 破位 / close5 / 跨日 session | 边收敛（< 开仓边一半）/ 边反转（<0）/ **到期日强平**（`arb_expiry`） |
| 现货腿 | 无 | parity 有：1 张 = 10000 份 ETF，`asset:'spot'`，卖空按 50% 融券近似收保证金 |
| 风控 | 现金约束限仓 | 另有 ≤6 组合并存、单组合 ≤10 张 |
| 费用 | 1.7 元/张/腿（双边） | 同左 + 现货腿万 1 佣金 |

数据落盘 `data/options/paper/<book>/{account.json,positions.json,fills/<date>.jsonl}`，
旧单账户数据已惰性迁移到 `paper/strategy/`（realizedPnl 保留）。

**审计口径**：strategy 账本会写 `reason:'skipped'` 桩 fill（qty=0）；arbitrage 账本**只写成交**（无 skip 桩）。

---

## B. 桥路由与 wire JSON（权威契约）

类型全部在 `@dshtrading/api`（`OptionPaperBookId` / `PaperAccount` / `PaperPosition` /
`PaperFill` / `PaperLegFill` / `OptionPaperBookWire` / `OptionPaperAccountsWire` /
`OptionPaperFillsWire`），前端直接 import type，勿手抄。

### B1. 路由表（4 条）

| 路由 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `GET /options/paper/accounts` | — | `OptionPaperAccountsWire` | **资产面板主入口**：两账本一次拉全 |
| `GET /options/paper/account` | `book=strategy\|arbitrage`（缺省 strategy） | `OptionPaperBookWire` | 单账本视图 |
| `GET /options/paper/fills` | `book=`（缺省 strategy）、`limit=`（缺省 48，正整数） | `OptionPaperFillsWire` | 成交流水（倒序，最新在前） |
| `POST /options/paper/reset` | `book=`（query 或 body `{"book":...}`，缺省 strategy） | `OptionPaperBookWire` | 重置账本回 10 万（**需二次确认**） |

错误：`book` 非法 → HTTP 400 `{message:"options paper: book must be strategy|arbitrage"}`；
`limit` 非正整数 → 400。挂载点同其他期权端点（`/dshtrading/api/` 前缀、同源 fetch）。

### B2. wire JSON 全形状（arbitrage 账本示例，含全部新字段）

```jsonc
// GET /options/paper/accounts
{
  "ok": true,
  "books": [
    {
      "ok": true,
      "book": "arbitrage",
      "account": {
        "currency": "CNY",
        "initialCash": 100000,
        "cash": 72755.4,
        "realizedPnl": 154.8,
        "updatedAt": "2026-09-08T06:56:00.000Z",
        "id": "arbitrage"
      },
      "equity": 100154.8,          // 见 B3 公式
      "positions": [
        {
          "id": "arb:parity:510050:2609:2850",   // 套利持仓键（方向无关）
          "underlying": "510050",
          "template": "parity",                   // strategy 账本是 'vertical' 等；套利是 'parity'|'box'
          "openedBucketStart": "2026-09-08T03:00:00.000Z",
          "invalidIf": "",
          "qty": 2,                               // 张
          "marginCny": 30000,
          "legs": [
            { "code": "510050C2609M02850", "side": "buy",  "qty": 2,     "fillPrice": 0.05,   "priceSource": "ask" },
            { "code": "510050P2609M02850", "side": "sell", "qty": 2,     "fillPrice": 0.0184, "priceSource": "bid" },
            { "code": "510050", "side": "sell", "qty": 20000, "fillPrice": 2.9,
              "priceSource": "spot", "asset": "spot", "spotSymbol": "510050.SH" }
          ],
          "openFeeCny": 12.6,
          "book": "arbitrage",
          "expiryMonth": "2609",
          "expiryDate": "2026-09-23",
          "direction": "buy_synthetic_sell_spot",
          "strikes": [2.85],                      // parity=[K]；box=[K1,K2] 升序
          "openEdgePerShare": 0.02072             // 收敛/反转平仓基准（元/股）
        }
      ]
    },
    { "ok": true, "book": "strategy", "account": { /* 同形状 */ }, "equity": 100000, "positions": [] }
  ]
}
```

```jsonc
// GET /options/paper/fills?book=arbitrage（最新在前）
{
  "ok": true,
  "fills": [
    {
      "id": "arb:parity:510050:2609:2850:close:2026-09-08T06:56:00.000Z",
      "bucketStart": "2026-09-08T03:00:00.000Z",
      "asOf": "2026-09-08T06:56:00.000Z",
      "underlying": "510050",
      "template": "parity",
      "offset": "close",
      "qty": 2,
      "legs": [ /* 反向腿，同 PaperLegFill 形状 */ ],
      "premiumCny": -57188,
      "marginCny": 0,
      "cashAfter": 100154.8,
      "reason": "arb_converge",
      "feeCny": 12.6,
      "book": "arbitrage"
    }
  ]
}
```

**词汇表**（前端渲染用）：

- `reason`（strategy）：`signal` 开仓 / `invalidIf` 破位平 / `close5` 尾盘平 / `session` 跨日平 / `skipped` 桩；
  （arbitrage）：`arb_open` / `arb_converge` 收敛平 / `arb_reverse` 反转平 / `arb_expiry` 到期强平。
- `priceSource`：`ask`/`bid`（对手价）/ `spot`（现货现价）/ `last`/`prev_settle`（回退）/ `pick`。
- **现货腿单位**（关键）：`asset:'spot'` 的腿 `qty` 是 **ETF 份**（1 张 = 10000 份），金额 =
  `fillPrice × qty`（**不乘 multiplier**）；期权腿 `qty` 是张，金额 = `fillPrice × qty × 10000`。
  后端 `premiumCny` / `equity` 已按此口径算好，前端展示直接用，**勿再乘/除 multiplier**。

### B3. equity 公式（盯市权益，后端已算好）

```
equity = account.cash + Σ position.marginCny（占用保证金返还）
       + Σ markLegValue(leg)   // 多头为正：markPrice × qty × (spot 腿不乘 10000)
mark 回落链：期权腿链价（缺 → fillPrice）；现货腿现价（缺 → fillPrice）
```

### B4. 驱动说明（无需前端做什么）

双账本都由宿主 30s 心跳自动驱动（`optionCycleTick` 内 fire-and-forget，含 60s 链缓存与
in-flight 闸），前端**不需要**任何触发动作；`POST /options/cycles/tick`（可选 body `{"asOf":ISO}`）
仅供回放/调试，资产面板不调。

---

## C. 资产面板对接需求（HoldingsPanel）

现状：HoldingsPanel 只有股票三源（paper 模拟 / live 实盘 / imported 导入），
`GET /options/paper/*` 前端零消费。需求：新增「**期权虚拟账户**」分区（或页签），
把两个账本卡位展示。建议实现：

1. **数据**：`src/client/api.ts` 加三个 fetch（`optionPaperAccounts` / `optionPaperFills` /
   `resetOptionPaper`）；分区挂载后 **30s 轮询** `GET /options/paper/accounts`（一条请求两账本），
   卸载清定时器。
2. **两账户卡**（strategy / arbitrage 各一）：账本名、`cash`（可用现金）、`equity`（盯市权益）、
   `realizedPnl`（已实现盈亏，正绿负红）、持仓数（`positions.length`）、
   收益率 = `(equity − initialCash) / initialCash`。
3. **持仓表**（每账户下方）：套利持仓额外列 `direction`（中文释义）、`strikes`（box 显示
   K1-K2）、`expiryDate`（临期 ≤3 天高亮）、`openEdgePerShare`（元/股）；腿明细可展开
   （期权腿显示张数，现货腿显示份数 + `spotSymbol`）。
4. **成交 tab**：`GET /options/paper/fills?book=` 按 reason 徽标着色（开仓/平仓/强平/桩），
   `cashAfter` 列展示落账后现金。
5. **重置**：`POST /options/paper/reset?book=` 按账本单独重置（回 10 万），**必须二次确认**。
6. **免责口径**（分区底部固定一行）：
   > 纸面模拟账户：假设一档盘口全量成交、卖空现货为融券近似，绩效偏乐观；量化信号，非投资建议。

### 验证口径

- `npx vitest run`（client-ui-trading）全绿；`pnpm i18n:check`（新增文案 zh/en 两侧同步）；
  `node scripts/typecheck-gate.mjs` 不超基线。
- 视觉冒烟：trading-web profile → 资产面板 → 两账户卡均显示 equity=100000（未交易时）；
  盘中数轮心跳后 arbitrage 卡持仓数可能 >0，成交 tab 出现 `arb_open`。
- curl 冒烟（网关在跑时）：
  `curl "http://127.0.0.1:<port>/dshtrading/api/options/paper/accounts"` → 双 `initialCash:100000`；
  `curl ".../options/paper/fills?book=arbitrage"` → 休市时 `{"ok":true,"fills":[]}`。
