# Agent Note: 期权总览页空态聚合（整页一条通知）

Status: implemented

## Problem

2026-09-12 全页面操作流程复盘的 P2-8：期权总览页的**空态/错误反馈重复且不可读**。

中栏「期权总览」tab 由**两条独立端点**拼成：

| 节 | 端点 | 组件 |
|---|---|---|
| ① 九标的聚合总览 | `/options/overview` | `OptionsOverview` |
| ② 5 分钟闭环 | `/options/cycle-loop` | `OptionsCycleLoop` |

两个组件**各自**实现同一条分诊链（失败 → 加载中 → 未提供 → 空集），各自渲染自己的
`<div className={css.notice}>`，失败分支还直接吐桥回执原文 `{code}: {message}`。于是：

- 期权网关未起（本次复盘的实测环境）时两条端点同时失败 → 同页**叠两个**长得一样的灰字框
  （`OVERVIEW_DOWN: …` / `CYCLE_DOWN: …`），既噪又不像人话；
- 两条都在途时叠两个「加载中」；
- 用户无法从这两个框判断「是整页没数据，还是只有某一节坏了」。

## Decision

**1. 新增聚合判定纯函数模块 `options-sources.ts`。**

- `OptionsSourceProbe`（`loaded` / `failure` / `snapshot` / `hasRows`）→
  `optionsSourcePhaseOf()` 给出单源阶段，分诊链与两个子组件**原顺序完全一致**
  （failed > loading > unavailable > empty > data），保证聚合文案与子组件原本的说法不冲突。
- `aggregateOptionsSources(probes)`：**任一条有数据 → `'data'`（不聚合）**；全都没数据 →
  取优先级最高的非数据态（failed > loading > unavailable > empty）。空入参按 `'empty'`。
- `firstOptionsSourceFailure()`：取首个失败源原文，供聚合通知保留可诊断性。
- 纯函数零依赖，判定优先级由单测钉死（不依赖渲染）。

**2. 两条数据源都没数据时，出口收敛到中栏薄壳。**

- `OptionsOverviewMiddleView` 组装两条 probe → 渲染**一条**页面级通知
  （`data-dshtrading-options-sources-notice`）：人话标题（`options.sources.failed` 等）＋
  原始明细 `code: message`（等宽小字，压到辅助层级）＋ 仅 `failed`/`unavailable` 才给的
  恢复提示（加载中/空集给提示是噪音）。
- 两个子节新增**可选** `suppressNotice?: boolean`：聚合接管时本节通知与内容分支**双双让位**
  （只保留分区标题栏，不吞掉分区）。缺省 `false` = 各节自报，既有渲染与测试行为不变。

**3. 部分可用不聚合。** 只有一条没数据时，各节自报——保留「哪一节坏了」的定位信息，
不把部分可用掩盖成整页空。

## Alternatives considered

- **让两个子组件共享一个「页面级」通知组件、各自渲染**：仍会出两条（两条都想说话），
  没解决叠字；出口必须唯一，故把出口上提到薄壳。
- **整页无数据时用一条大空态替换掉两个分区（连标题栏一起收掉）**：更「干净」，但用户失去
  「这页本来有哪两节」的结构认知，且排序/口径等分区信息一并消失；保留分区标题 + 一条通知
  是信息量与噪音的平衡点。
- **只做去重（同样的 `code: message` 才合并）**：两条端点失败码本来就不同（`OVERVIEW_DOWN`
  vs `CYCLE_DOWN`），去重不触发，治不了本次病灶。
- **把原始 `code: message` 直接删掉、只留人话**：会丢诊断线索（这两个码是排查网关/桥的首选
  证据）。改为降级展示（等宽小字），人话在上、原文在下。
- **给子组件加 `suppressAll` 连标题栏一起隐藏**：超出「空态聚合」的范围，且会让页面在不同
  状态下结构跳变；不做。

## Consequences

- 期权总览页在「整页无数据」时只出一条通知；部分可用时保持各节自报（定位能力不降级）。
- `OptionsOverview` / `OptionsCycleLoop` 的公开 props 各多一个可选 `suppressNotice`；
  两个组件自身行为（缺省 `false`）与既有测试完全不变。
- i18n 新增 5 键：`options.sources.{loading,failed,failedHint,unavailable,empty}`（zh/en 全量）。
- 回归护栏：
  - `test/options-sources.test.ts`（6 条）：单源分诊链顺序、失败优先于未落地、聚合优先级、
    「任一条有数据 → data」的双向验证、空入参、失败源原文提取；
  - `test/options-overview-middle.smoke.test.tsx`（3 条，jsdom 真挂载薄壳 + 桥桩）：
    两条都失败 → **恰好 1 条**聚合通知（且第二条原文不再出现、分区标题仍在）、仅一条失败 →
    不聚合且失败节自报、两条都在途 → 只 1 条「加载中」。
- 门禁账：包构建绿；`npx vitest run` **466/466**（51 文件）绿；仓库级 `pnpm build` 绿；
  `node scripts/i18n-audit.mjs --check` OK（1174 zh keys / 26 exemptions）。
  注：本机 `pnpm i18n:check`（经 pnpm 包装器）本次被沙箱 safe-delete 批量删除守卫拦下
  （`_tmp_*` 累计达 50 文件阈值），直接用 node 跑同一脚本即通过——非审计失败。
