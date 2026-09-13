# WB-13 增强：套利机会表按分类显示 + 默认盈利>50 过滤（前端）

- **类型**：feature（前端，WorkBuddy lane）
- **日期**：2026-09-13
- **范围**：`packages/client-ui-trading/src/client/**`（前端）
- **前置**：`2026-09-13-options-arbitrage-table.md`（WB-13 初版，commit `a3ea3a3`）

## Problem

WB-13 初版的套利表把平价 + 箱型混排在一张扁平表里（靠一个「类型」列区分），且把内核返回的
**全部**机会都渲染出来。领航员要求两点：

1. **按套利机会分类显示** —— 不同类型的机会应分组呈现，而非混排。
2. **默认只显示「盈利大于 50」的机会** —— 边际机会默认折叠，需要时可展开。

第 2 点有一个隐蔽约束：内核 `scanParityArbitrage` 的**默认阈值就是 0.005 元/股 = 50 元/张**
（`packages/strategies/src/arbitrage/parity.ts:122` 的 `options.threshold ?? 0.005`，`:130` 的
`if (netEdge <= threshold * multiplier) continue`）——即内核**已经把盈利 ≤50 的机会剔除干净**。
若前端只是简单加一道 `>50` 过滤，它将是一个**恒真的空操作**（回来的本就全 >50），「显示全部」按钮
也点不出任何东西。故必须让前端拿到更宽的机会集，才能把 50 这道闸门真正交给前端。

## Decision

### 1) 按分类成组

把原来的扁平表拆成**按 kind 分组的子表**：平价套利 / 箱型套利 各自一个小标题 + 表格
（`OptionsArbitrageTable.tsx:59` 的 `ArbGroup`；渲染点 `:149-150`）。既然组标题已表达类型，
组内表**移除冗余的「类型」列**（原 `col.kind` 仅保留给方向性价差表头）。方向性垂直价差维持
独立的可折叠区（非无风险，单独标注）。

### 2) 默认盈利>50 + 可展开

- 常量：`MIN_EDGE_PER_CONTRACT = 50`（`:35`，默认闸门）+ `PASS_THROUGH_THRESHOLD = 0.0001`
  （`:37`，向内核申请的透传下限）。
- 前端调用改为 `scanArbitrage(fromOptionChain(chain), { multiplier, threshold: PASS_THROUGH_THRESHOLD })`
  （`:103`）——用更低的透传下限，让内核把盈利 1〜50 的边际机会也**透传**上来。
- 默认 `onlyProfitable=true`（`:108`），对每组做 `edgePerContract > MIN_EDGE_PER_CONTRACT`
  的过滤（`:113-119`）；`hidden = total − visible`（`:123`）。
- 一个 `ghostBtn` 在两态间切换：`仅显示盈利大于50` ⇄ `显示全部机会`，并配计数提示
  （`filter.hintHidden` / `filter.hintAll`）；若过滤后一组都不剩，显示 `filter.noneVisible` 引导展开。
- 行上新增 `data-edge={o.edgePerContract}`（`:78`）——让「默认隐藏低盈利」可被**确定性断言**
  （不依赖 fmtPrice 文案或具体数值）。

所有改动**仅在前端**：不改内核默认阈值、不改后端 `getArbitrageScan` 路由的输出。

## Alternatives considered

- **改内核默认阈值（0.005 → 更小）**：否决。会改变共享内核默认行为与后端 `getArbitrageScan`
  的输出集合，越界到后端半；且可能打破内核既有测试。前端传参自持阈值，自洽且零外溢。
- **保留扁平表、只加过滤**：否决。领航员明确要求「按分类显示」，单列区分不算分类。
- **对垂直价差也套用 >50 闸门**：暂缓。垂直价差的「盈利」是 `maxProfitPerShare`（元/股），
  与套利的 `edgePerContract`（元/张）**不同量纲**；且它本就是独立折叠的次级方向性区，强套同一阈值
  反而制造误读。留待领航员需要时单独定阈值。
- **用 checkbox 而非按钮**：否决。沿用既有 `ghostBtn` 视觉，与「展开方向性价差」按钮一致。

## Consequences（门禁账）

- `pnpm --filter @dshtrading/client-ui-trading build`：**绿**（client bundle 1.36 MB）。
- `npx vitest run`（包目录，绕过沙箱 safe-delete 守卫）：**501 passed / 501**（57 文件；
  本组件冒烟 4→6，+2：分类分组断言 + 默认过滤/展开断言）。
- `node scripts/i18n-audit.mjs --check`：**OK**（5 namespaces，**1213** zh keys，26 exemptions；+5 新键）。
- 类型棘轮（第四道）：本变更 **零新增**。`tsc --noEmit -p tsconfig.client.json` = 44 错误（= baseline），
  `OptionsArbitrageTable.tsx` / 测试文件 **0 错误**；唯一落在改动文件上的 `OptionsStage.tsx:319`
  仍是既有 `SESSION_REASON_KEY` 索引型存量债，与本变更无关。已如实申报，未动他人半、未 `--force`。
- 构建产物自检：`lib/client.js` 含新文案（`显示全部机会` / `仅显示盈利大于50`），
  `lib/client/locales.js` 含 `options.arbitrage.filter.showAll` —— 证明重建产物已含本变更。
- UI 端到端（§6）：本变更仍是 T 板内组件，套利表**需选中标的 + 加载 option chain**（iquant/options
  gateway）才渲染；本轮以 jsdom 6 例冒烟覆盖渲染/分组/过滤/展开与折叠交互，未重复起真宿主（上轮已确认
  宿主能加载重建后的 client bundle）。

## 后续

- 若领航员希望给垂直价差也加盈利闸门，需先定义其「盈利」量纲（建议 `maxProfitPerShare × multiplier`
  与套利同标到元/张），再复用本组过滤范式。
- 后端 #10 若扩 `OptionQuoteRow` 加 `bid`/`ask`，`executable` 列自动翻转为「可成交」，无需改组件。
