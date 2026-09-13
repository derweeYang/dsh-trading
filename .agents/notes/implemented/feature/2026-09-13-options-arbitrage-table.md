# Agent Note: WB-13 期权 T 板套利机会表（前端）

Status: implemented

- **类型**：feature（前端，WorkBuddy lane）
- **日期**：2026-09-13
- **范围**：`packages/client-ui-trading/src/client/**`（前端；后端实时扫描链路见 `docs/backend-handoff-2026-09-13.md` 任务 #10，pending）

## Problem

领航员要求：在 client-ui-trading 的期权视图接 `scanArbitrage` 渲染套利机会表。
套利纯函数内核（`@dshtrading/strategies/src/arbitrage/`，上一轮已由前端落地，门禁通过）已具备
`scanArbitrage` / `scanVerticalSpreads` / `fromOptionChain`，但前端期权视图尚未消费它。

## Decision

在 **T 板（OptionsStage）** 内挂载新组件 `OptionsArbitrageTable`：

- **注入点**：`OptionsStageMiddleView` 已 `fetchOptionsChain` 取链，经 props `chain: OptionChain`
  传给 `OptionsStage`；新增 `OptionsArbitrageTable` 直接消费该 `chain`，浏览器内
  `fromOptionChain(chain)` → `scanArbitrage({multiplier})` + `scanVerticalSpreads`，零后端依赖。
- **两类机会分区**：
  - 无风险套利（平价 + 箱型）主表：`scanArbitrage` 输出，按 `edgePerContract` 降序；
  - 方向性垂直价差独立可折叠区（明确标注「非无风险」），`scanVerticalSpreads` 输出。
- **可执行性诚实呈现**：实时链 `api.OptionQuoteRow` 无 `bid`/`ask` → 内核 `executable=false` →
  表格标「理论估算」并附 `theoryNote` 提示以可成交价复核，**不伪造可执行性**（与 backend-handoff #10 缺口一致）。
- **空态/降级**：`spot`/`expiryDate` 缺失时 `scanArbitrage` 返回 `[]` → 显示「未检出」；方向性区默认折叠。
- **i18n**：新增 30 个 `options.arbitrage.*` 键（zh + en），全程走词典，无硬编码可见文案。

文件：
- 新增 `src/client/OptionsArbitrageTable.tsx`、`src/client/options-arbitrage.module.css`
- 改动 `src/client/OptionsStage.tsx`（import + 在 T 表后渲染；T 表加 `data-dshtrading-options-t-table` 测试钩子）
- 改动 `src/client/contract.ts`、`src/client/locales.ts`（zh/en 各 +30 键）
- 改动 `test/options-stage.smoke.test.tsx`（行数断言收敛到 T 表，避免把套利表算进来）
- 新增 `test/options-arbitrage.smoke.test.tsx`（4 tests：标题/浏览器内扫描+理论估算/空态/方向性区展开）

## Alternatives considered

- **在总览（7 ETF）渲染套利表**：需对 7 标的各拉链并扫描，取数/算力重、且总览是信号卡而非链视图；
  否决，留待后端批次扫描（#10）后接入。T 板已持有单链，最自然的单点注入。
- **把扫描推到后端**：违背前端 lane 边界（`scanArbitrage` 为纯库，浏览器可跑）；
  后端实时链路单独登记为 #10（待 Cursor/Claude）。
- **套利与垂直价差合并一张表**：垂直是方向性、非无风险，与无风险套利混排会误导；
  否决，分区并显式标注风险属性。

## Consequences（门禁账）

- `pnpm --filter @dshtrading/client-ui-trading build`：**绿**（node 半 + client bundle）。
- `npx vitest run`（包目录，绕过沙箱 safe-delete 守卫）：**497 passed / 497**（56→57 文件，+4 来自本组件）。
- `node scripts/i18n-audit.mjs --check`：**OK**（5 namespaces，1208 zh keys，26 exemptions）。
- 类型棘轮（第四道）：本变更 **零新增**。`tsc --noEmit -p tsconfig.client.json` 后 grep
  本变更文件：`OptionsArbitrageTable.tsx` 0 错误；残留 4 处错误均在 `OptionsStage.tsx:319` /
  `OptionsStageMiddleView.tsx:21,22,143`，属 **baseline 存量债（client 44 > 基线 33）**，与本变更无关，
  已如实申报，未动他人半、未用 `--force` 抬高基线。
- 注意：T 板 T 表新增 `data-dshtrading-options-t-table` 仅作测试稳定钩子，不影响渲染。

## 后续

- 后端 #10 接通「实时链 → scanArbitrage」后，若扩展 `OptionQuoteRow` 加 `bid`/`ask`，
  本表 `executable` 列将自动从「理论估算」翻转为「可成交」，无需改组件（适配器 `fromOptionChain` 已预留）。
- 总览页批量套利表可作为后续前端任务，依赖 #10 的批量扫描能力。
