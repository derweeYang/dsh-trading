# Agent Note: 期权总览三处 UX 修复（WB-11：主区滑动条 / 整卡进 T 板 / IV 排序死键）

Status: implemented

## Problem

期权标的总览（MiddleStage `options-overview` tab）三处体验问题（用户 2026-09-09 报）：

1. **5 分钟闭环只露一小条**：`options-overview-middle` 把高度切成「总览内部滚 + 闭环卡钉 300px 小窗内滚」，两段滚动条，闭环内容不直观。
2. **机会卡点击无跳转**：只有卡底「进 T 板」按钮可跳，整卡不可点。
3. **点「IV 分位」排序无响应（真 bug）**：`OptionsOverviewMiddleView` 的 `sortRef` 只在 `useRef(sort)` 初始化读过，之后从未同步——切排序后每个应答都被 `if (sortRef.current !== sort) return` 丢弃，表格永远不更新。叠加次因：`includeIv=1` 时九路 vol_analytics 慢/缺席，无任何在途反馈。

## Decision

只动 client 半（`src/client/**`），node 半桥与 `@dshtrading/api` 契约零改动：

- **主区一条滑动条**：`options-overview-middle.module.css` 根容器 `overflow-y: auto`；总览根与闭环根改 `flex: 0 0 auto` 自然高度；闭环 `.cards` 摘掉 `max-height: 300px` 内滚；总览 `.tableWrap` 只保留横向滚动（12+ 列窄面板放不下）。九行明细表放弃 sticky 表头（页面滚动下不生效，可接受）。
- **整卡可点**：`OptionsOpportunityBoard` Card 根 div `onClick → onPickRow`（T 板即「围绕该标的的期权分析 + 交易策略」既有落点），底部两按钮 `stopPropagation` 防双触发；CSS 加指针 + hover 高亮。
- **IV 排序修死键 + 即时反馈**：`changeSort` 里同步 `sortRef.current = next`（根因修复）+ `setSortPending(true)`；换排序先用已取到的行在客户端重排（`displayOverview` useMemo，纯展示序，不重算指标、缺键沉底），应答落地后覆盖；`OptionsOverview` 新增 `sorting` prop → 根节点 `data-sorting` 降透明度 + 顶栏内联提示；切 iv 且九行 `ivPercentile` 全缺席时出 `options.overview.ivMissing` 如实提示（zh/en 词典 + `contract.ts` key 已同步）。

## Alternatives considered

- **只加 loading 转圈、不动 sortRef**：表还是不更新，治标，败。
- **闭环改可拖拽分隔条（resizable split）**：交互更重，DnD 状态要持久化；整页一条滚动条已消解「可视区太小」，KISS，败。
- **客户端把 ivPercentile 自己算出来**：违反「页面不算指标」纪律（WB-1 交接单），且 vol_analytics 打分在宿主/kit 侧，复制必漂移，败——缺席只如实提示。

## Consequences

- `pnpm test` 44 文件 / 393 用例全绿；`pnpm build` 双端 bundle 通过。冒烟新增 3 锁：整卡点击不双触发、`data-sorting` 在途标记、iv 全缺席出提示。
- 明细表 sticky 表头失效（自然高度下无内部竖滚）——若后续行数远超九行再回评。
- `lib/` 产物已重建；trading-web profile 若仍挂 file: 旧副本需按 process note 刷新（删 `~/.dsh/profiles/trading-web/node_modules/@dshtrading/client-ui-trading` 后重装）。
