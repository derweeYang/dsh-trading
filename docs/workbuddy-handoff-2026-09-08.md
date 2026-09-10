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
5. **`source=iquant` 已是默认**：桥 JSON **仍出长代码**。国信行情簿是短码 + `SHO`/`SZO`。
   CN 默认 provider 是 `iquant`（`:5810`）。设置里加「国信 iQuant」，**去掉 MiniQMT**。
   期权 live 下单已删除，dry-run 预览仍可。
6. **不要改** `packages/client-ui-*/src/client/**` 以外由后端已改的桥默认。

---

## C. 交互设计参考（9 标的期权页面，owner 与 workbuddy 讨论稿）

### C1. 标的总览页（找时机）

**只拉一条**：`GET /dshtrading/api/options/overview?sort=strength`。
不要再拼 `/tickers` + `/klines` + `/positions`——桥已聚合。形状见
`docs/options-bridge.md`「overview」。

- 行：`last` / `changePct` / `return5d` / `volumeRatio` / `strengthScore` /
  `heldQty` / `optionQty` / `strategy`（当天最新推荐；缺席「—」） /
  `divergence`（`weak_rally` 虚涨、`accelerating_sell` 加速）。
- **T-5**：`days[]`（`changePct` 色深，`volumeSurge` 边框）。缺键按行容错。
- 排序：`sort=strength|iv|holdings`。IV 排序必须带 `includeIv=1`（才打网关）。
- 点击行 → `GET /options/resolve?symbol=` 拿 `link` 进 T 板。
- SYNTH 名册行后端已剔除。类型用 `@dshtrading/api` 的 `OptionOverview`。

### C2. LLM 推荐策略交互

- **入口**：总览「扫描标的」→ `fillComposer(overview.scanAllPrompt)`；
  行内 / T 板「AI 组合建议」→ `fillComposer(row.scanPrompt)`。prompt 已含
  标的、现价、5 日量价、底仓、不下单纪律。
- agent 工具已齐（`cn_get_option_chain` / `iv` / `vol_analytics` / `strategy` /
  `cn_get_option_intraday_box`，`holdingQty` 已支持）。scanPrompt 已要求先读箱体 JSON。
  编排 skill：`option-intraday-workflow`。L2 桥：`GET /options/intraday-box`。
- **呈现**：agent 回复经 toolview 渲染；策略卡片给「加载到 T 板」动作——
  把推荐的腿填进下单面板（preview 态，用户手动确认才 `POST /options/order`）。
- **纪律**：LLM 只能预填，不能下单；实盘仍走双闸。
- 总览 IV 分位读 `row.ivPercentile`（`includeIv=1`），不要再解析 vol-analytics 原文。

### C3. T 板增强（阶段 4 数据已备）

spot 回填后：ATM 行高亮、实/虚值分色（strike vs spot）、行权价距离百分比列；
heldQty 徽章 + 「按底仓备兑」快捷键（holdingQty=heldQty 调 strategy 预览）。

---

## D. workbuddy 工单（期权总览 + 箱体 + 扫描，2026-09-08）

**只改** `packages/client-ui-trading/src/client/**`（+ 本包 client 半测试）。
不要改 `bridge.ts`、`option-overview.ts`、`kit-cn`、`@dshtrading/api`。
类型从 `@dshtrading/api` 取：`OptionOverview` / `OptionOverviewRow` /
`OptionOverviewStrategy` / `OptionIntradayBox` / `OptionIntradayBoxRow` /
`OptionCycleLoop` / `OptionCycle`。
形状见 `docs/options-bridge.md`。
文案进 `locales.ts` + `contract.ts`，zh/en 同步，跑 `pnpm i18n:check`。
本页不构成投资建议；扫描按钮只 `fillComposer`，不下单。

建议顺序：**WB-0 → WB-1 → WB-6 → WB-2 → WB-3 → WB-4 → WB-5**。
WB-1 可先交付（总览能用）；WB-6 是闭环可视化，优先于再造一套箱体轮询。

### WB-0  桥 fetch（`src/client/api.ts`）

补下列，风格对齐现有 `fetchOptionsUnderlyings`（`OptionsOutcome` + `optionsFailure`）：

| 函数 | 路由 | 成功取出 |
|---|---|---|
| `fetchOptionsOverview({ sort?, includeIv? })` | `GET /dshtrading/api/options/overview` | `wire.overview` |
| `fetchOptionsIntradayBox({ underlying?, asOf? })` | `GET /dshtrading/api/options/intraday-box` | `wire.box` |
| `fetchOptionsCycleLoop()` | `GET /dshtrading/api/options/cycles/loop` | `wire.loop` |
| `fetchOptionsCycles({ underlying?, limit? })` | `GET /dshtrading/api/options/cycles` | `wire.cycles` |

- `includeIv` 默认 **false**（不要默认 `1`，九路 vol_analytics 会打爆网关）。
- `horizon` 不要做成 UI 选项，写死 `5` 或不传。
- 未挂连接器 → `TRADING_NOT_IMPLEMENTED`，与现有期权页签显隐同一判据。
- 单测：mock `getJson`，断言 query 字符串（`sort=strength`、无 `includeIv` 或 `=0`）。

### WB-1  九标的总览页（C1）

期权透镜落地页，**不要**一进「期权」就画当前自选的 T 板。

1. 新组件（建议）`src/client/OptionsOverview.tsx` + 同名 css module。
2. `QuoteStage`：`activeLens === 'options'` 时先总览；点行再进现有 `OptionsStage`。
   点行：`fetchOptionsResolve(row.spotSymbol ?? row.underlying)` → 用 `link.spotSymbol`
   切现货选择（与现有现货⇄期权透镜同一套），再 `setLens('options')` 进 T 板。
3. **只拉** `fetchOptionsOverview({ sort })`。禁止拼 ticker/kline/positions。
4. 行字段：`last` / `changePct` / `return5d` / `volumeRatio` / `strengthScore` /
   `heldQty` / `optionQty` / `divergence`。**缺键按行容错**，不要整页空白。
5. T-5：`days[]` 五格，`changePct` 色深，`volumeSurge` 边框。
6. 排序控件：`strength`（默认）/ `iv` / `holdings`。切到 `iv` 时才
   `includeIv: true`。
7. `divergence`：`weak_rally` / `accelerating_sell` 用词典，不要写死中文在 TSX。
8. SYNTH 后端已剔除，UI 不必再滤。
9. 总览失败：`NOT_IMPLEMENTED` 隐藏期权透镜（已有）；其它 code 行内/页顶原文。

返回 T 板：总览行上给「返回总览」，不要丢排序状态。

### WB-7  总览「推荐策略」列（后端已挂，2026-09-09）

`GET /options/overview` 每行现有可选 `strategy`（`OptionOverviewStrategy`）。
**不要**现场算箱体或调 `cn_get_option_strategy`。无键 →「—」。

1. `OptionsOverview.tsx` 表头在 `optionQty` 与 T-5 之间加一列。
2. 渲染（建议）：
   - `skipReason` 有值 → 词典 skip 标签（今天盘中常见 `overlap` / `launch_failed`）
   - 否则 `noTrade` 或 `opportunity === 'no_edge'` → `no_edge` 标签
   - 否则 `${template} · ${opportunity}`；`title`/`tooltip` 用 `edge`
3. 建议键（zh/en 同步，自拟短文案）：

| 键 | zh 例 |
|---|---|
| `options.overview.col.strategy` | 推荐策略 |
| `options.overview.strategy.theta_rent` | 收时间价值 |
| `options.overview.strategy.rv_vs_iv` | 波动差 |
| `options.overview.strategy.direction_delta` | 方向 Delta |
| `options.overview.strategy.mean_reversion` | 回归 |
| `options.overview.strategy.covered_yield` | 底仓增强 |
| `options.overview.strategy.no_edge` | 观望 |
| `options.overview.strategy.skip.session` | 非连续竞价 |
| `options.overview.strategy.skip.calibrated` | 已校准跳过 |
| `options.overview.strategy.skip.overlap` | 上一桶未写完 |
| `options.overview.strategy.skip.launch_failed` | 会话未拉起 |
| `options.overview.strategy.template.*` | 蝶 / 跨式 / 垂直 / 备兑 / 领口 |

4. 本列只读展示。不要点单元格下单，也不要当成扫描按钮。

### WB-2  扫描入口（C2，只预填聊天框）

`fillComposer` 已从 `QuoteStage` 注入。**原样**填桥给的英文 prompt，不要前端重写。

| 按钮 | 文案键（自拟，zh/en 对齐） | 动作 |
|---|---|---|
| 总览顶栏 | `options.overview.scanAll` | `fillComposer(overview.scanAllPrompt)` |
| 总览行内 | `options.overview.scanRow` | `fillComposer(row.scanPrompt)` |
| T 板操作条 | `options.overview.scanRow` | 用总览缓存里该标的 `scanPrompt`；没有则先拉一次 overview 再按 `underlying` 查找 |

- `fillComposer` 未注入 → 不渲染这三个按钮（与 `onSendLegToAgent` 同款）。
- 现有「把合约交给 Agent」保持不动，不要和扫描按钮合并。
- 扫描 prompt 已含「先读箱体、不下单」；UI 不必再拼一段英文纪律。

### WB-3  5 分钟箱体条（L2，展示用）

优先读 **WB-6** 的 `latest.forecast`，不要再单独狂轮 `intraday-box`。
T 板若 loop 还没该标的行，才降级 `fetchOptionsIntradayBox({ underlying })`。
`no_trade` / `calibrated` 只出示原因，不画假箱沿。候选模板是标签，不是下单按钮。

### WB-6  闭环时间线（定时评估可视化，本轮优先）

宿主已在 node 半每 30s 对齐上海 5 分钟桶（`POST /options/cycles/tick` 幂等）。
页面 **不要** 自己 `setInterval` 去算箱体或打分。

1. 新组件（建议）`src/client/OptionsCycleLoop.tsx`，挂在总览页上半或右侧。
2. **只拉** `fetchOptionsCycleLoop()`；点某一标的再 `fetchOptionsCycles({ underlying, limit: 24 })` 画历史。
3. 轮询 **30s**，`visibilityState === 'hidden'` 停。不要 5s。
4. 每标的一张周期卡：
   - 本桶：`latest.forecast` 的箱沿 / `regime` / `candidates` / `calibration`
   - 上桶：`score.verdict`（`hit` / `partial` / `miss` / `skipped`）+
     `realizedLast` vs `boxLow`–`boxHigh`（有 score 才画对照）
   - 条带：`stats.hitRate`（缺席则显示「样本不足」）
5. 工作流示意（静态，可用词典）：`L1 选场 → L2 出箱 → 等 5 分钟 → 对照已走完的 1m → 校准 → 下一桶`。
   不要把 60 根 1m 画进总览。
6. `loop.running === false` 显示「闭环未启动」（headless / 桥未挂），不要假装在走。
7. `verdict` / `calibration` / `noTradeReason=calibrated` 全部进词典。

这就是「下一周期评估上一根（上一桶 5 根 1 分钟）K 线执行结果」的页面。
评估对象是**预报箱体 vs 已实现路径**，不是实盘成交。不要把 miss 自动变成下单。

### WB-4  策略卡片 → T 板预填（C2 后半）

agent 回复经现有 toolview。在策略结果上加「加载到 T 板」：

1. 读 `cn_get_option_strategy` / `POST /options/strategy` 的 `legs[]`
   （长代码 + side + qty）。不要用新浪短码。
2. 切到对应标的 T 板、选到期月、把第一腿填进现有下单面板（preview）。
3. **不要**自动 `POST /options/order`。用户点「提交委托」才走现有双闸。
4. 若 toolview 一时挂不上按钮：WB-2 先交；本票可第二轮。

### WB-5  词典、门禁、冒烟

- 新键进 `contract.ts` + `locales.ts` zh/en。UI 字面量零豁免。
- `pnpm --filter @dshtrading/client-ui-trading test` 全绿。
- `pnpm i18n:check`。
- `node scripts/typecheck-gate.mjs` 不超基线。
- 视觉冒烟（trading-web）：总览九行、T-5、排序、扫描预填、T 板箱体条、
  `no_trade` 空态、点行进 T 板再返回。桌面全屏截图不要；用宿主 HTTP +
  headless Chrome（见 AGENTS.md UI 验证手法）。

### 不要做

- 不要在 client 重算 `strengthScore` / 箱体 / IV 分位。
- 不要默认 `includeIv=1`。
- 不要把 60 根 1m K 画进总览。
- 不要改 node 半桥或 Python 内核。
- 不要让扫描按钮直接下单。

---

## 交接完成标准

- [x] A1-A3 全部落地（`feat/etf-options` 已快进含市场收敛与必红测试改 cn 词汇）
- [x] B 的交易面 + 互联接线（T 板下单 / ATM / 备兑 / 持仓条已在 client 半）
- [x] **WB-0** overview / box / cycles fetch（2026-09-09）
- [x] **WB-1** 期权透镜落地 = 总览（`GET /options/overview`）
- [x] **WB-6** 闭环时间线（`GET /options/cycles/loop`）
- [x] **WB-2** `fillComposer(scanPrompt / scanAllPrompt)`
- [x] **WB-3** 箱体条（优先用 loop.latest.forecast）
- [x] **WB-4** 策略预览 → T 板下单面板回填（preview 态；后端 `OptionStrategyResult` 已定型、端点已 live，2026-09-09）
- [x] **WB-5** `pnpm i18n:check` 通过；typecheck 前端 0 新增
- [x] **WB-5 余项** trading-web 真机冒烟（2026-09-09）：后端清 #7/#8 后宿主可 boot；
      前端 5/5 通过（总览 9 行 / T-5 / 排序 / 扫描预填 / T 板箱体条 / 进出 T 板）。
      证据见 [backend-handoff §5](./backend-handoff-2026-09-09.md#5-wb-5-真机冒烟结果2026-09-09-1430前端执行)。
      与 **WB-7** 无依赖（策略列只读 `row.strategy`，不挡本列）。
- [x] **WB-7** 总览「推荐策略」列（`row.strategy`；后端已挂账本，见下）

WB-1/6/3 的决策记录见
[2026-09-09-options-overview-cycle-loop-ui](../../.agents/notes/implemented/feature/2026-09-09-options-overview-cycle-loop-ui.md)。
行为变更：期权透镜显隐判据从「当前标的在名册内」放宽为「名册非空」——总览是
落地页，停在九只以外的标的时也要能进；进不进得去 T 板才看当前标的。

