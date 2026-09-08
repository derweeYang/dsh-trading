# workbuddy 前端交接（2026-09-08 市场收敛 + 期权全链路）

分工边界：`packages/client-ui-*/src/client/**` 归 workbuddy；桥（bridge.ts）、
连接器、api 契约归后端。**交接面 = 稳定的桥 JSON**，契约细节见
`docs/options-bridge.md`（期权端点权威文档）。本文件给三部分：A 删除涟漪修复
清单、B 新能力接线点、C 交互设计参考。

---

## A. 市场收敛删除涟漪（阶段 1/2：crypto/us/hk 已删，client 半残留）

后端已收敛为 **cn-only**（commit e2b76f9）。以下残留是 client 半的清理清单，
含 6 个必红测试。修复顺序建议先 A1（类型收敛）再其余——很多文件是类型连锁。

### A1. 类型与市场词汇收敛（连锁根源）

| 文件 | 现状 | 改法 |
|---|---|---|
| `src/client/types.ts:9` | `MarketId = 'crypto' \| 'us' \| 'cn' \| 'hk'` | 收敛为 `'cn'`（若嫌日后复辟难，可留注释说明曾为四市场） |
| `src/client/store.ts:82-87` | `inferMarket`：空→`'crypto'`、`.HK`/五位数字→`'hk'`、USDT/BTC/ETH→`'crypto'`、兜底→`'us'` | 一律返回 `'cn'`（6 位数字/`.SH`/`.SZ` 判断可留作符号规范化，市场恒 cn） |
| `src/client/store.ts:94,106,140,145,168,182` | `['crypto','us','cn','hk'].includes(...)` 白名单 | 同步收敛（市场非法回退 `'cn'`） |

### A2. 市场专属 UI 整删

| 文件 | 动作 |
|---|---|
| `src/client/DerivativesPane.tsx` / `DerivativesStage.tsx`（+ css） | crypto 衍生品面板——确认无 cn 消费后整删，QuoteStage 引用点同步摘除 |
| `src/client/market-status.ts:32,80,110,138` | crypto/hk/us 交易时段分支——删，保留 cn（9:15-11:30/13:00-15:00） |
| `src/client/FundamentalsStage.tsx` | crypto 渲染分支（价格单位 USDT 等）删 |
| `src/client/MarketSidebar.tsx` / `MarketDock.tsx` | 四市场切换——收敛为 cn 单市场（或直接隐藏切换器，保留市场名） |
| `src/client/OrderPanel.tsx` | 多市场下单——收敛 cn 词汇 |
| `src/client/locales.ts:12-15,86-88` | `tab.crypto`/`tab.us`/`tab.hk`、`fundamentals.unit.us/hk/crypto` 等键删；zh/en 两侧同步（跑 `pnpm i18n:check`） |
| `src/client/holdings-types.ts` / `holdings-store.ts` / `holdings-aggregate.ts` / `HoldingsPanel.tsx` | 后端 `@dshtrading/holdings` 已收敛 `HoldingMarket = 'cn'`、货币表仍含 USD/HKD/USDT（历史台账）——client 侧 market 词汇跟着收敛，货币显示保留多币种 |
| 其余 grep 命中：`api.ts`、`contract.ts`、`format.ts`、`compose-research.ts`、`toolview.tsx`、`host-watchlist-sync.ts`、`OrderbookPane.tsx`、`ScheduledTasksPanel.tsx`、`index.ts` | 逐个清 crypto/us/hk 引用（多为类型连锁，A1 完成后 tsc 会指路） |

### A3. 必红测试修复（6 个，种子表已收敛）

后端 `@dshtrading/watchlist` 种子已只剩 cn（600519/000001/601318/510050）、
`@dshtrading/router/catalog` 静态目录已 cn-only：

- `test/store.test.ts` ×3：断言种子含 `BTCUSDT`/`AAPL`/`00700` → 改断言 cn 种子
- `test/symbol-catalog.test.ts` ×3：前缀搜索（期望非空）、动态目录合并
  （`BTC/USDT`→`比特币`）、跨市场搜索 → 改用 cn 词汇（如 `600519`→`贵州茅台`、`searchAllMarkets` 只出 cn 标签）

### A4. 验证口径

- `npx vitest run`（client-ui-trading）**全绿**是交接完成的硬标准
- `pnpm i18n:check` 通过
- `node scripts/typecheck-gate.mjs` 不得超基线（client 收敛大概率还能降基线，
  降了跑 `--update`）
- 视觉冒烟：trading-web profile 打开，确认左栏种子、市场名、期权页签正常

---

## B. 期权全链路新能力（阶段 3/4 桥增量）

**契约权威文档：`docs/options-bridge.md`**（本节只列接线点，不重复形状）。

1. **交易面**（`src/client/api.ts` 现只有只读 fetch）：新增
   `POST/DELETE /options/order`、`GET /options/positions` 三个调用 + T 板
   下单面板（张数/价格/premiumAmount 直接显示——桥已换算好金额，勿再乘
   multiplier；义务仓保证金预估经 `POST /options/strategy` 的 margin 块）。
2. **互联**：`GET /options/resolve`（现货↔期权双向跳转）、chain.spot 回填
   （ATM 高亮/实虚值分色）、underlyings.heldQty（底仓高亮 + 备兑张数 =
   floor(heldQty/10000)）、strategy holdingQty（备兑/领口组合按真实底仓预填）。
3. **`src/client/OptionsStage.tsx` 已是只读 T 板**（chain/expiries/underlyings
   fetch 已在 `api.ts:118` 起）：在它之上加下单面板与 spot 高亮，不用重写。
4. **双闸语义**：GUI 默认请求实盘（dryRun: false），闸门拒绝时
   `TRADING_LIVE_TRADING_DISABLED` 原文展示——不要在 UI 层伪造 dry-run 成功。

---

## C. 交互设计参考（9 标的期权页面，owner 与 workbuddy 讨论稿）

### C1. 标的总览页（找时机）

**只拉一条**：`GET /dshtrading/api/options/overview?sort=strength`。
不要再拼 `/tickers` + `/klines` + `/positions`——桥已聚合。形状见
`docs/options-bridge.md`「overview」。

- 行：`last` / `changePct` / `return5d` / `volumeRatio` / `strengthScore` /
  `heldQty` / `optionQty` / `divergence`（`weak_rally` 虚涨、`accelerating_sell` 加速）。
- **T-5**：`days[]`（`changePct` 色深，`volumeSurge` 边框）。缺键按行容错。
- 排序：`sort=strength|iv|holdings`。IV 排序必须带 `includeIv=1`（才打网关）。
- 点击行 → `GET /options/resolve?symbol=` 拿 `link` 进 T 板。
- SYNTH 名册行后端已剔除。类型用 `@dshtrading/api` 的 `OptionOverview`。

### C2. LLM 推荐策略交互

- **入口**：总览「扫描标的」→ `fillComposer(overview.scanAllPrompt)`；
  行内 / T 板「AI 组合建议」→ `fillComposer(row.scanPrompt)`。prompt 已含
  标的、现价、5 日量价、底仓、不下单纪律。
- agent 工具已齐（`cn_get_option_chain` / `iv` / `vol_analytics` / `strategy`，
  `holdingQty` 已支持）。
- **呈现**：agent 回复经 toolview 渲染；策略卡片给「加载到 T 板」动作——
  把推荐的腿填进下单面板（preview 态，用户手动确认才 `POST /options/order`）。
- **纪律**：LLM 只能预填，不能下单；实盘仍走双闸。
- 总览 IV 分位读 `row.ivPercentile`（`includeIv=1`），不要再解析 vol-analytics 原文。

### C3. T 板增强（阶段 4 数据已备）

spot 回填后：ATM 行高亮、实/虚值分色（strike vs spot）、行权价距离百分比列；
heldQty 徽章 + 「按底仓备兑」快捷键（holdingQty=heldQty 调 strategy 预览）。

---

## 交接完成标准

- [x] A1-A3 全部落地（`feat/etf-options` 已快进含市场收敛与必红测试改 cn 词汇）
- [x] B 的交易面 + 互联接线（T 板下单 / ATM / 备兑 / 持仓条已在 client 半）
- [ ] C1 总览页挂 `GET /options/overview`（后端已交缝）
- [ ] C2 `fillComposer(scanPrompt / scanAllPrompt)` + 策略卡片加载到 T 板
- [ ] `pnpm i18n:check`、typecheck-gate（C1/C2 词典一并过）
- [ ] 视觉冒烟截图（trading-web profile）
