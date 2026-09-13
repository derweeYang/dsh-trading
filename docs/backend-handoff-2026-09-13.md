# 后端待办交接（2026-09-13）

> 起草人：workbuddy（前端）｜交接对象：后端（Cursor / Claude）
> 背景：ETF 期权套利纯函数内核（`@dshtrading/strategies/src/arbitrage/`）已由前端落地并门禁通过
> （tsdown build 过 / vitest 整包 123/123 / tsc 新增文件 0 错误 / i18n N/A），详见
> `docs/etf-option-arbitrage.md` 与 `.agents/notes/implemented/feature/2026-09-13-etf-option-arbitrage-module.md`。
> 本文件只登记**后端范围**的剩余债务——把实时期权链接通到套利内核，**不执行**。
> 按 AGENTS.md 分工：界面 `src/client/**` 之外的全部代码（连接器 / kit / python / client-ui 的 node 半桥）归后端。

---

## 任务 #10 — 实时期权链 → 套利扫描链路接通（状态：done 2026-09-13，分支 feat/options-arb-scan）

### 10.1 交付接口（已就绪，WorkBuddy 完成，勿改）

纯函数内核，零运行时依赖、可浏览器打包：

| 符号 | 位置 | 说明 |
|---|---|---|
| `scanArbitrage(chain, options?)` | `packages/strategies/src/arbitrage/index.ts` | 平价 + 箱型无风险套利，按 `edgePerContract` 降序 |
| `scanVerticalSpreads(chain)` | `packages/strategies/src/arbitrage/vertical.ts` | 方向性垂直价差（牛/熊 × 看涨/看跌），**不并入** `scanArbitrage` |
| `fromOptionChain(chain: OptionChain)` | `packages/strategies/src/arbitrage/adapter.ts` | 仅 type-only 引 `@dshtrading/api`，把后端 `OptionChain` → `ArbitrageChain` |
| `parityMatrix(chain, options?)` | `packages/strategies/src/arbitrage/parity.ts` | 逐行权价平价偏差矩阵 |

`ArbitrageOpportunity` 字段：`kind` / `underlying` / `expiryMonth` / `strike?` / `lowStrike?` / `highStrike?` / `edgePerShare` / `edgePerContract` / `direction` / `legs[]` / `executable`。

### 10.2 后端要做的事

1. **链路接线**：`connector-options.getOptionChain`（`rest.ts:179` / `index.ts:82`）
   → `fromOptionChain` → `scanArbitrage` / `scanVerticalSpreads`，产出机会表。
   落点建议：新增服务/路由（connector-options 或 kit-cn）；python 侧同样可调用（`@dshtrading/strategies` 为纯 TS 库，归后端整合）。桥 `bridge.ts:882 optionChain` 已透传 `OptionChain`，前端面板可在接通后消费。
2. **bid/ask 缺口（关键，需契约扩展）**：当前 `@dshtrading/api` 的 `OptionQuoteRow`
   （`api/src/index.ts:102`）**只有 `last` / `prevSettle`，无 `bid` / `ask`**。
   套利内核 `execPrices`（`prices.ts`）仅在有真实买卖盘时置 `executable=true`，否则退回
   mid/last 近似（`executable=false`）。
   - **临时口径**：先以 `last`/`prevSettle` 跑近似边（`executable=false`），阈值筛仍可用；
   - **正式口径**：扩展 `OptionQuoteRow` 加 `bid?` / `ask?`，并同步 `adapter.mapRow` 转发，
     使真实边界 `executable=true` 生效。此扩展属 `@dshtrading/api` 契约改动（后端范围）。

### 10.3 验收标准（2026-09-13 后端完成，证据见下）

- [x] 给定含 `spot` + `expiryDate` 的 `OptionChain`，经链路产出 `ArbitrageOpportunity[]`（平价/箱型）
      与 `VerticalSpread[]`，字段齐全（kind / edgePerContract / legs / executable）。
      *证据：单测 `packages/connector-options/test/arbitrage-scan.test.ts`（22 passed）与
      `packages/strategies/test/arbitrage.test.ts`（126 passed）；网关集成冒烟——worktree lib
      `OptionsRestClient.getArbitrageScan({underlying:'510050', expiryMonth:'2609', spot:2.92})`
      打主仓 ：8090 真实链路，返回 27 opportunities + 364 verticals，休市日 K 回落截面
      `executable=false` / `priceBasis=mid_last` 落位正确。*
- [x] 门禁不恶化：后端改动后跑 `node scripts/typecheck-gate.mjs` 无新增 `↑`（存量债只降不升）。
      *证据：主仓总数 263 → worktree 261（净 −2，顺手修 bridge.ts 存量错 2 个）；6 个上升包
      （client-ui-trading / client-ui-strategies / kit-cn / strategies）与主仓逐项一致，均为
      前端交付带入的存量，非本次引入；connector-options 保持 0。*
- [x] 若扩展 `OptionQuoteRow` 契约，前端 `src/client/**` 不受影响（adapter 已隔离；`OptionChainWire` 透传 `OptionChain`）。
      *证据：`OptionQuoteRow` 新增 `bid?`/`ask?` 为纯可选键；全仓 vitest 1289+ passed
      （含 client-ui-trading 56 files / 495 tests）；`src/client/**` 未改动。*

### 10.5 交付实现（2026-09-13，后端）

- **契约**（`packages/api/src/index.ts`）：`OptionQuoteRow` + `bid?`/`ask?`；新增
  `OptionArbitrageLeg/Kind/Direction/Opportunity`、`OptionVerticalSpread`、
  `OptionArbitrageScanQuery`（spot?/thresholdPerShare? 缺省 0.005/feePerContract? 缺省 0/
  includeVerticals? 缺省 false）、`OptionArbitrageScanResult`（含 assumptions.priceBasis
  'bid_ask'|'mid_last'|'mixed' 与 disclaimer）、`OPTION_ARBITRAGE_DISCLAIMER` 常量。
- **适配**（`packages/strategies/src/arbitrage/adapter.ts`）：`mapRow` 转发 bid/ask；
  `./arbitrage` 子入口进 package.json exports（深导入不引 indicators/cordis）。
- **接线**（`packages/connector-options/src/arbitrage.ts` 新文件）：`scanOptionChainArbitrage`
  组装层，multiplier 由调用方注入（防模块循环）；`rest.ts` `getArbitrageScan`（名册乘数）；
  `index.ts` 服务委托 + export。
- **桥**（`packages/client-ui-trading/src/bridge.ts`）：GET `/options/arbitrage`——spot 经
  名册/spotSymbol/getTicker 现价拼接，feePerContract 缺省注入 `OPTION_PAPER_FEE_PER_CONTRACT`。
- **行情面**（python）：`iquant-quote/live.py` 全推快照五档第一档（0=无盘过滤）→ bid/ask；
  `python/options` `map_chain_quote` 有则透传；akshare 板块列无买/卖价、synth 无盘口，两路缺省键。
- **已知坑**：connector-options `tsconfig.json` include 首位锚定 `src/index.ts`——绕 TS 5.9
  root 顺序敏感缺陷（cordis `export *` 转发的 Context 丢失 augmentation 混入成员 →
  `super(ctx, ...)` TS2379）。详见 tsconfig 注释与 Agent Note。

### 10.4 注意

- 套利为量化信号，**非投资建议**；前端展示须带免责声明（见 `docs/etf-option-arbitrage.md` 末尾）。
- `connector-options` 当前门禁状态以最新 `typecheck-gate` 报告为准，接通时一并 reconcile。

---

## 任务 #11 — 后端把「检测到的期权机会」聚合进 `OptionOverview.opportunities`（状态：pending，后端）

### 11.1 背景与前端现状（WorkBuddy 已完成前端消费侧）

- **前端已就绪**：`OptionsOverview.tsx` 在机会卡之后渲染 `<OptionsDetectedOpportunities>`
  （新文件 `src/client/OptionsDetectedOpportunities.tsx`），通过
  `const detected = (overview as OverviewDetectedShape | null)?.opportunities` 透传。
  后端字段未落地时 `detected` 为 `undefined`，组件整体不渲染，**不整页空白、不影响现有门禁**。
- **i18n 已就位**：`options.detected.*` 共 18 个键已加入 `contract.ts` 联合类型与 `locales.ts`
  中/英字典（字典文件豁免 CJK 扫描）；中文机会正文走运行时 JSON（`edgeZh/logicZh/playbookZh/
  invalidIfZh`），非源码字面量。
- **缺口**：`@dshtrading/api` 的 `OptionOverview` 当前**没有** `opportunities` 字段；本任务把它加上，
  并由 bridge/kit-cn 把 `data/options/recommendations/*.jsonl` 去重聚合进该字段。

### 11.2 后端要做的事

1. **契约扩展**（`packages/api/src/index.ts`）：在 `OptionOverview` 上加
   `opportunities?: OptionOverviewOpportunity[]`（可选，缺省即前端隐藏）。
   新增类型 `OptionOverviewOpportunity` 与子类型 `OptionOverviewPick` / `OptionOverviewLeg`，
   字段与下方 11.3 对齐（`edgeZh/logicZh/playbookZh/invalidIfZh` 一并带上，前端直接渲染）。
2. **聚合接线**（bridge/kit-cn，`@dshtrading/api` 之外，属后端）：读取
   `data/options/recommendations/*.jsonl`，按既有去重逻辑（id = `bucketStartUtc + '-' + underlying`；
   参考 `data/options/opportunities-summary.json` 已是 12 raw → 9 deduped 的产出物）聚合成
   `OptionOverviewOpportunity[]`，挂到 `GET /options/overview` 返回的 `overview.json` 快照上。
   - 去重口径（已在 `opportunities-summary.json` 体现）：12 条原始 → 9 条去重
     （mean_reversion 5 / direction_delta 4；underlying 510050×6 / 588000×2 / 510300×1；
     date 09-10×5 / 09-11×4）。2 条已定价（588000 06:00、510300 06:15），7 条未定价。
   - **未定价条目**：`picks[].legs` 为空、`netCreditCnyPerSpread` 等全 `null`、`status` 为
     `已识别·未定价`；前端对未定价只出状态徽章 + 「须经实时预填闸门」提示，**不编造价位**。
   - **已定价条目**：`legs[]` 含 `code/side/optionType/strike/last/prevSettle`，
     `netCreditCnyPerSpread/maxLossCnyPerSpread/breakevenAtExpiry` 为 CNY/价位数值。
3. **不改动前端**：`src/client/**` 已锁定契约（cast 容错），后端只加可选字段即可，前端零改动渲染。

### 11.3 `OptionOverviewOpportunity` 字段对齐（前端视图模型来源）

```
OptionOverviewOpportunity {
  id: string                      // bucketStartUtc + '-' + underlying
  date: string                    // "2026-09-10"
  bucketStartUtc: string
  bucketStartCst: string          // "2026-09-10 14:00:00"（前端检测桶标签）
  session: string
  opportunity: string             // "mean_reversion" | "direction_delta"
  opportunityLabel: string        // "均值回归（收反转溢价）"
  noTrade: boolean
  underlyings: string[]
  picks: OptionOverviewPick[]
  edge: string; logic: string; playbook: string; invalidIf: string       // 英文原文（保留）
  edgeZh: string; logicZh: string; playbookZh: string; invalidIfZh: string // 中文渲染源
}
OptionOverviewPick {
  underlying: string; regime: string; regimeLabel: string; template: string
  structure: string | null        // "bear_call_credit"
  expiryMonth: string | null; expiryDate: string | null
  maxContracts: number | null
  legs: OptionOverviewLeg[]        // 未定价时 []
  netCreditCnyPerSpread: number | null; maxLossCnyPerSpread: number | null
  breakevenAtExpiry: number | null
  verification: string | null; quoteSource: string | null
  status: string                  // "已定价" | "已识别·未定价"
}
OptionOverviewLeg {
  code: string; side: 'sell'|'buy'|string; optionType: 'C'|'P'|string
  strike: number; last: number; prevSettle: number
}
```

### 11.4 验收标准

- [ ] `OptionOverview` 加 `opportunities?`；`node scripts/typecheck-gate.mjs` 无新增 `↑`（存量债只降不升）。
- [ ] `GET /options/overview` 返回快照含 `opportunities`（9 条去重），`src/client/**` 零改动下
      前端自动渲染（见 `OptionsDetectedOpportunities.tsx` 与 `tests/options-overview.smoke.test.tsx`
      既存用例不设置 `opportunities` → 该区块保持隐藏，不破坏）。
- [ ] 已定价条目腿表与风险指标（净权利金/最大亏损/盈亏平衡）正确透传；未定价条目不出腿表、只出闸门提示。
- [ ] i18n 审计 `node scripts/i18n-audit.mjs --check` 仍全绿（`options.detected.*` 已加齐中/英键值对与占位符）。
