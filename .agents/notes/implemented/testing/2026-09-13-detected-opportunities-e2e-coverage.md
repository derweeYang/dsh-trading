# Agent Note: 检测机会透传链的端到端取证（task #11 前端侧闭环）

Status: implemented

## Problem

`docs/backend-handoff-2026-09-13.md` 任务 #11 的验收口径是「`src/client/**` **零改动**下前端自动渲染
`overview.opportunities`」。但当时这条链只有在**叶组件**层面被证明过：`test/options-overview.smoke.test.tsx`
把 `opportunities` 直接塞进 `OptionsOverview` 的 props，**跳过了真实数据路径**——

```
桥 JSON → fetchOptionsOverview → OptionsOverviewMiddleView.overview state
        → displayOverview = {...overview, rows} → OptionsOverview(cast) → 检测区
```

中间任一处把 `overview` 从「spread」改成「字面量重建」，`opportunities` 就会静默消失，
而叶组件测试**照样全绿**。这是典型「测试看着覆盖了、其实测的是别的东西」：
交接单承诺的是**零改动**，那么证明它就必须从**中栏挂载**开始，否则后端发货后才发现链断，
而那时「零改动」已经变成「要改动」。

同时，任务 #11 需求 §11.4 第 3 条要求的**三项风险指标**（净权利金 / 最大亏损 / 盈亏平衡）
在当时的用例里一条都没断言——只断言了腿表 code 与状态徽章。

## Decision

1. **在该链的关键节点补确定性断言钩子**（`OptionsDetectedOpportunities.tsx`）：
   根 `data-dshtrading-detected-opportunities`、卡 `data-detected-card` + `data-priced`、
   腿表 `data-detected-legs`、风险指标 `data-detected-metrics`、未定价闸门 `data-detected-blocker`、
   单标的块 `data-detected-pick`。**定价与否由数据判**（`netCreditCnyPerSpread !== null`）后落到
   `data-priced`，断言不再依赖文案（既有做法是靠 status 中文原文，属运行时 JSON、口径易漂）。
2. **中栏路径端到端用例**（`test/options-overview-middle.smoke.test.tsx`，+3）：
   - 桥原文带 `opportunities`（类型尚未进 `@dshtrading/api`，按 WB-14 的 cast 口径透传）→
     中栏挂载即出检测区，两卡 `data-priced` = `['true','false']`；已定价腿表 2 行 + `218/282/1.7218`；
     未定价只有 blocker，腿表与指标都不在；
   - 折叠开关在中栏路径下同样生效（收起后腿表从文档消失）；
   - 无 `opportunities` 键 → 检测区整体不渲染、也不产生聚合通知（不打扰既有总览）。
3. **叶组件用例补强**（`test/options-overview.smoke.test.tsx`，+1）：按 `data-priced` 分流断言
   腿表 / 三项指标 / 闸门提示，补齐 §11.4 第 3 条。
4. **交接单回写**：§11.4 拆成「后端待发货」与「前端已验证并取证」两类勾选并附证据；
   新增 §11.5 记下透传链每一环的 file:line 与用例清单，明确后端**只需**做 §11.2 两件事。

## Alternatives considered

- **只在叶组件加断言**（最省事）：否决。它证明不了「零改动」，因为叶组件测试根本不经过
  `displayOverview`；真正的回归风险恰在中栏重建对象这一步。
- **把 `opportunities` 加进 `@dshtrading/api` 后再断言**：否决。契约为后端泳道（AGENTS.md 分工），
  且这样会把「前端是否就绪」与「后端是否发货」绑死——恰恰是要解耦的两件事。
- **用文案（`已定价` / `已识别·未定价`）断言**：否决。那是**运行时 JSON 里的中文数据**，
  改一个字就红，且这两串在 i18n 审计里属豁免项，没有词键约束；改用 `data-priced` 表达同一语义。
- **前端自己读 `data/options/recommendations/*.jsonl` 聚合**：否决（同 WB-14 记录的 A 方案）：
  跨半（client 半禁止 import node 半）、重复打上游、口径漂移。

## Consequences

- task #11 的前端半从「声明就绪」升级为**可验证就绪**：后端一发货，`GET /options/overview` 带上
  `opportunities` 即自动渲染；若不再渲染，`options-overview-middle` 那条用例会立刻红。
- 风险仍在契约面：聚合产出的字段名必须与交接单 §11.3 一致；有出入时后端先在文档回写，
  前端改 `OptionsDetectedOpportunities.tsx` 的视图模型（**唯一**需要跟改的地方，已在 §11.5 写明）。
- 门禁账（本变更，串行跑，主仓 `etf-options` 分支）：
  - `pnpm --filter @dshtrading/client-ui-trading build` 绿；
  - `npx vitest run` **509/509**（57 文件；较变更前 +4：中栏 +3、叶组件 +1，`git show HEAD:<file> | grep -c "^ *it("` 对账 3→6 / 31→32）；
  - `node scripts/i18n-audit.mjs --check` OK：5 namespaces / **1238** zh keys / 26 exemptions
    （本变更未新增词键；另逐键核过 `options.detected.*` 18 键**全部有渲染点**，无僵尸键）；
  - `node scripts/typecheck-gate.mjs` **零新增**：总数 261、`packages/client-ui-trading` client 44，
    与 HEAD 一致；本变更触碰的两个组件/两个测试文件在 `tsc -p tsconfig.client.json` 报告中 0 错误。
    门禁本身仍红（六包存量债，基线停 2026-09-09），按「本变更零新增」申报。
- 顺带发现（未在本变更处理）：`.agents/notes/implemented/` 下 24 篇缺 `Status:` 行
  （其中今日前端 5 篇；本变更另以独立提交补其头部骨架，剩余历史债留 backlog）——
  与 README §4 的三行骨架不符。
