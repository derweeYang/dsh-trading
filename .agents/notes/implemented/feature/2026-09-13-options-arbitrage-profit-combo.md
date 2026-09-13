# Agent Note: WB-13 增强（二轮）套利收益列 + 前10/显示更多 + 点击看操作组合（前端）

Status: implemented

- **类型**：feature（前端，WorkBuddy lane）
- **日期**：2026-09-13
- **范围**：`packages/client-ui-trading/src/client/**`（前端）
- **前置**：`2026-09-13-options-arbitrage-table.md`（初版）、`2026-09-13-options-arbitrage-filter-grouping.md`（一轮增强）

## Problem

领航员在「分类显示 + 盈利>50 过滤」之后追加两点：

1. **添加套利收益**，默认按收益从大到小排序，**默认显示前 10 个**。
2. **点击后显示具体操作组合**（各腿明细）。

其中「收益」口径存在二义：内核 `ArbitrageOpportunity` 只有 `edgePerShare`/`edgePerContract`，
且**已按 `edgePerContract` 降序**（故若「收益」= 绝对 edge，排序其实是现成的）。经确认，领航员
**选定「收益额（元/张）」** = `edgePerContract`，并选定**「前 10 + 显示更多」**的展开方式。

## Decision

### 1) 收益列 + 排序 + 前 10

- **列**：以 `options.arbitrage.col.profit`（zh「套利收益」/ en「Arbitrage profit」）取代原
  `col.edgePerContract`（「理论边/张」）——二者同值（皆为 `edgePerContract`），故**改名而非并列**，
  避免重复列。见 `OptionsArbitrageTable.tsx:119`。
- **排序**：组内 `[...rows].sort((a,b) => b.edgePerContract - a.edgePerContract)`——内核本就降序，
  此处显式化以自述意图（`ArbGroup` 内 `useMemo`）。
- **前 10 + 显示更多**：`DEFAULT_VISIBLE_ROWS = 10`、`ROWS_STEP = 10`（`:42-43`）；`ArbGroup` 持
  `limit` state（`:103`），`sorted.slice(0, limit)` 渲染，剩余 >0 时出「显示更多（剩余 N）」
  （`:171-172`），点击 `limit += ROWS_STEP`（逐级展开）。
- **每组独立**：因已按分类成组，前 10 的闸门按**每组**计（平价/箱型各自 top-10），与该分类自持的
  可见量语义一致。全局「盈利>50」过滤仍在上层先行。

### 2) 点击行展开具体操作组合

- 行 `onClick` + `onKeyDown`（Enter/Space）+ `tabIndex=0` 切换 `expanded`（`:136-141`）；
  展开态渲染一条 `colSpan=4` 的明细行（`data-arb-combo`，`:152`）。
- 组合内容 = `combo.title · 方向` + 各腿列表（`describeLegs`，`:79`）：每腿
  `动作(买/卖) 认购/认沽 行权价 (合约代码)`；**平价另附现货腿**——按 `direction` 判定
  `sell_synthetic_buy_spot → 买入现货` / `buy_synthetic_sell_spot → 卖出现货`（内核 `legs` 只含期权腿，
  现货腿是平价组合的必要组成，故在组件补出）。
- **稳定行 key**：`rowKey(o)`（`:93`）用内容（kind/strike/low/high/direction）而非下标——过滤、
  前10 截断、展开都会令行重排，下标键会导致展开错位。
- 新增 8 个 i18n 键（`showMore`/`rowHint`/`combo.title`/`leg.buy`/`leg.sell`/`leg.spotBuy`/
  `leg.spotSell`/`col.profit`），移除 1 个（`col.edgePerContract`）。

## Alternatives considered

- **收益 = 收益率(%)**（edge ÷ 占用资金）：领航员在二选一中**未选**此项。选绝对收益额后，无需再定义
  平价（按行权价）/箱型（按价差）各自「占用资金」口径，避免近似口径带来的误读。
- **收益额与收益率并列为两列**：否决（同列价值有限 + 引入资金口径），领航员选了单一口径。
- **严格只显示前 10 / 10-20-全部档位**：领航员选了「前 10 + 显示更多」（保留「默认」语义）。
- **顶部全局 top-10（跨分类）**：否决——分组后各表独立，跨分类截断会让某组显示不完整、数量不可预期。
- **垂直价差也加「点击看组合」**：本轮未做。垂直价差是独立的方向性次级区，其列（认购·方向/价差/净借记/
  盈亏平衡/最大盈利）已较完整；如领航员需要再补。

## Consequences（门禁账）

- `pnpm --filter @dshtrading/client-ui-trading build`：**绿**（client bundle 1.36 MB）。
- `npx vitest run`（包目录，绕过沙箱 safe-delete 守卫）：**503 passed / 503**（57 文件；
  本组件冒烟 6→8，+2：前10/显示更多、点击展开组合/收起）。
- `node scripts/i18n-audit.mjs --check`：**OK**（5 namespaces，**1220** zh keys，26 exemptions；
  新增 8、移除 1，净 +7）。
- 类型棘轮（第四道）：本变更 **零新增**。`tsc --noEmit -p tsconfig.client.json` = 44（= baseline），
  本变更文件（组件/测试/locales/contract）**0 错误**；`OptionsStage.tsx:319` 为既有存量债。
- 构建产物自检：`lib/client.js` 含「套利收益 / 操作组合 / 买入现货」；`lib/client/locales.js` 含
  `col.profit`/`combo.title`/`showMore` 且旧键 `col.edgePerContract` 计数为 0。

## 后续

- 「点击看组合」如需扩展到垂直价差区，复用 `describeLegs`（其 `legs` 同为 `ArbitrageLeg[]`）即可。
- 后端 #10 若扩 `OptionQuoteRow` 加 `bid`/`ask`，`可成交` 列自动翻转为「可成交」，本组件无需改。
