# Spec：ETF 期权虚拟账户（10 万、信号市价成交）

- 日期：2026-09-10
- 状态：implemented
- 决策记录：[`.agents/notes/implemented/feature/2026-09-10-option-paper-account.md`](../../../.agents/notes/implemented/feature/2026-09-10-option-paper-account.md)
- 依赖：[option-bar-agent](../../specs/2026-09-08-option-bar-agent.md)、[options-bridge](../../options-bridge.md)
- 分工：Cursor / Claude 做 `@dshtrading/api` 契约、`kit-cn` 账本、tick 挂钩、node 桥 GET/POST。workbuddy 以后只读展示，本轮不改 `packages/client-ui-*/src/client/**`。
- 非投资建议。虚拟成交不是实盘，不设 `liveTrading`。

## 1. 产品

宿主在 LLM 写出有效推荐后，用当桶期权链行情**自动补腿并以市价记入虚拟账户**。账户初始 **100_000 CNY**。张数用推荐 `maxContracts`（缺省 1），现金或预估保证金不够则减张，减到 0 则跳过。持仓盯推荐 `invalidIf`（1 分钟收盘破箱等）；未触发则在当日首次 `close5` 市价平掉。不过夜、不行权交割模拟。

人要看到：现金、权益、持仓、开平流水、跳过原因。不自动打 `POST /options/order`，不复用 GUI 股票模拟盘（`paper-trading-store`，默认 100 万）。

## 2. 范围

做：

- `data/options/paper/` 文件账本（account / positions / 日 fills）
- 推荐规范化成功后的开仓尝试（同进程，不再开 LLM）
- 30s tick 上的 `invalidIf` 与 `close5` 平仓
- 链价补腿（无 `legs` 时）
- `GET /options/paper/account`、`GET /options/paper/fills`、`POST /options/paper/reset`
- kit-cn 纯函数单测

不做：

- 实盘、dry-run 连接器报单、审批闸门改语义
- 改 `src/client/**`、股票 paper store、初始资金改成 10 万（那是另一套账）
- 修 overlap、午夜复盘锁死、`barCount=0` 打分（另开变更）
- 隔夜持仓、到期行权、手续费/滑点模型（成交价只用 bid/ask/last）
- 每标的各开一轮 LLM

## 3. 成交闸门

在 `normalizeRecommendation` 写入 jsonl **之后**调用 `tryPaperOpen(rec)`。

不成交（可写 `reason=skipped` 的 fill 行，不改现金）：

| 条件 | `skip` |
|---|---|
| `skipReason` 非空 | 不写 fill（桩推荐静默） |
| `noTrade === true` 或 `opportunity === no_edge` | 不写 fill |
| 同 `bucketStart` 已有任意 `offset=open` 且非 skipped 成功 fill | `duplicate_bucket`（只在尝试成交时写一行） |
| pick 缺 `underlying` 或 `template` | 该 pick 跳过，记 `bad_template` |
| 当桶无该标的 forecast，或 `template` ∉ `forecast.candidates` | `no_forecast` / `bad_template` |
| 链或策略网关不可用，补不出合法腿 | `no_quote` |
| 减张后 qty=0 | `no_cash` |

`ivRegime=unknown` 不挡成交。`playbook=probe` 只要 `noTrade=false` 且过闸门仍成交（用户选宽闸 B）。

同一 `bucketStart`：**第一条**非桩推荐才允许开仓；其中按 picks 顺序只成交**第一笔**过闸的 combo（一根 K 全市场一笔）。其余 pick 写 `skip=one_fill`。其后推荐行写 `duplicate_bucket`。

## 4. 补腿与市价

每个 pick：

1. 若 `legs` 每条含 `code`、`side`（buy/sell）、`qty`，用这些腿。
2. 否则读当桶 forecast 候选的 `bias`，拉 `cn_get_option_chain`（当桶 asOf 的最新快照，禁止用昨日 `snapshotAt` 若链上有更新）。
3. `template=vertical`：与 bias 同向的垂直价差——`down` 为卖近行权看涨 / 买远行权看涨（熊市看涨价差）；`up` 为对称的看跌价差。行权价取 ATM 外侧相邻两档；档距或报价缺失 → `no_quote`。
4. 其他 template（butterfly 等）：本轮若无完整腿则 `no_quote`，不发明造腿。
5. 成交价：权利腿（buy）用 ask，义务腿（sell）用 bid；缺一边用 last；再缺则该腿 `no_quote`。
6. 乘数恒为 **10000**。`premiumCny` = Σ(signed last × qty × 10000)，买为负出现金、卖为正入现金。
7. 张数：`qty0 = max(1, floor(pick.maxContracts ?? rec.maxContracts ?? 1))`。用 `POST /options/strategy`（或现有 kit 保证金函数）估 `marginCny`。若 `cash + premiumIn - margin` 不够，qty 递减到能过或 0。
8. 写入 positions：每条腿一行或一个 combo 持仓（实现选 combo，平仓必须整组）。挂上 `invalidIf` 文本（推荐级，抄 JSON，不自编）。

## 5. 平仓时钟

挂在现有 `optionCycleTick`（30s），不另起 cron。

1. 对每个未平 combo：取该标的最新 1 分钟收盘（走已有箱体/行情路径，禁止 LLM、禁止 `*_get_klines` 工具会话）。用与 L0 相同的 `invalidIf` 解释：文本若含 Donchian/箱沿，则对照 forecast `boxLow`/`boxHigh` + `volumeRatio>=1.5`（与 candidate.invalidIf 字面一致）。解释不了的字符串：不在盘中误平，等到 `close5`。
2. 当日首次 `sessionFlag === close5`：市价平全部剩余仓（买平 ask、卖平 bid）。
3. 平仓 fill：`offset=close`，`reason=invalidIf|close5`，释放保证金，轧权利金差计入已实现。
4. `close5` 之后、周末、`closed`：不再开仓。进程跨日启动：若 `positions.json` 仍有仓且日历日已变，开盘前按**上一日收盘链价**强平并记 `reason=session` 的 close（防午夜账户脏仓）。这是兜底，正常路径应已在 close5 清空。

## 6. 文件

根目录默认 `data/options`，可用 `DSH_TRADING_OPTIONS_DATA`。gitignore 增加 `data/options/paper/`。

### 6.1 `paper/account.json`

```json
{
  "currency": "CNY",
  "initialCash": 100000,
  "cash": 100000,
  "realizedPnl": 0,
  "updatedAt": "2026-09-10T06:40:00.000Z"
}
```

首次缺失则按上表创建。`POST /options/paper/reset` 写回初始态并清空 `positions.json`，不删历史 fills jsonl（审计保留）。

### 6.2 `paper/positions.json`

```json
{
  "updatedAt": "…",
  "positions": [
    {
      "id": "588000:1789020000000",
      "underlying": "588000",
      "template": "vertical",
      "openedBucketStart": "2026-09-10T06:00:00.000Z",
      "invalidIf": "1-minute close breaks Donchian on volumeRatio>=1.5",
      "qty": 1,
      "marginCny": 282,
      "legs": [
        { "code": "588000C2609M01700", "side": "sell", "qty": 1, "avgPrice": 0.0566 },
        { "code": "588000C2609M01750", "side": "buy", "qty": 1, "avgPrice": 0.0348 }
      ]
    }
  ]
}
```

### 6.3 `paper/fills/YYYY-MM-DD.jsonl`

一行一事件。成功开仓幂等键：`bucketStart`（全市场每桶至多一笔成功 open）。跳过行不占该键，但第二条推荐仍不得再开。

## 7. API

桥前缀 `/dshtrading/api`。类型进 `@dshtrading/api`。

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/options/paper/account` | `{ ok, account, equity, positions }`。`equity = cash + Σ mark`（权利仓按 bid 盯、义务仓按 ask 盯，缺报价则用 last / avgPrice）。 |
| GET | `/options/paper/fills?limit=` | `{ ok, fills }`，默认 48，按时间倒序。 |
| POST | `/options/paper/reset` | `{ ok, account }`，回到 10 万、空仓。 |

不增加 paper 下单 POST。现有 `/options/order` 语义不变。

## 8. 错误

账本函数失败不得打断 tick 或推荐落盘。链/策略失败 → skip 行。文件损坏 → 记日志，account 按 initialCash 重建空仓（fills 仍追加，不覆盖旧 jsonl）。

## 9. 验证

- 单测：补腿 bias=down → 熊市看涨价差；maxContracts 减张；duplicate_bucket；no_quote 不扣钱；invalidIf 平仓；close5 平仓；跨日脏仓强平；reset；paper 路径不调用 live 下单。
- 人工：用已有 `2026-09-10` 推荐回放，13:40–14:25 五条中仅每桶第一笔成功 open（14:15/14:25 重复忽略），14:25 第三条 `noTrade` 不成交。
- `pnpm` 相关包 test 全绿。不改 client 半，无 UI 浏览器验收。

## 10. 免责

技术研究预填与模拟记账，不构成投资建议，禁止据此实盘自动下单。
