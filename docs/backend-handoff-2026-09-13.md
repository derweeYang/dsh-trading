# 后端待办交接（2026-09-13）

> 起草人：workbuddy（前端）｜交接对象：后端（Cursor / Claude）
> 背景：ETF 期权套利纯函数内核（`@dshtrading/strategies/src/arbitrage/`）已由前端落地并门禁通过
> （tsdown build 过 / vitest 整包 123/123 / tsc 新增文件 0 错误 / i18n N/A），详见
> `docs/etf-option-arbitrage.md` 与 `.agents/notes/implemented/feature/2026-09-13-etf-option-arbitrage-module.md`。
> 本文件只登记**后端范围**的剩余债务——把实时期权链接通到套利内核，**不执行**。
> 按 AGENTS.md 分工：界面 `src/client/**` 之外的全部代码（连接器 / kit / python / client-ui 的 node 半桥）归后端。

---

## 任务 #10 — 实时期权链 → 套利扫描链路接通（状态：pending）

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

### 10.3 验收标准

- [ ] 给定含 `spot` + `expiryDate` 的 `OptionChain`，经链路产出 `ArbitrageOpportunity[]`（平价/箱型）
      与 `VerticalSpread[]`，字段齐全（kind / edgePerContract / legs / executable）。
- [ ] 门禁不恶化：后端改动后跑 `node scripts/typecheck-gate.mjs` 无新增 `↑`（存量债只降不升）。
- [ ] 若扩展 `OptionQuoteRow` 契约，前端 `src/client/**` 不受影响（adapter 已隔离；`OptionChainWire` 透传 `OptionChain`）。

### 10.4 注意

- 套利为量化信号，**非投资建议**；前端展示须带免责声明（见 `docs/etf-option-arbitrage.md` 末尾）。
- `connector-options` 当前门禁状态以最新 `typecheck-gate` 报告为准，接通时一并 reconcile。
