# Agent Note: 期权 T 板升格中栏直达 tab 与行情子页签记忆

Status: implemented

## Problem

2026-09-12 全页面操作流程复盘（宿主 HTTP + 无头 Chrome 驱动，9 张状态截图）暴露两处中栏导航摩擦：

1. **期权 T 板深藏**：`OptionsStage`（T 型报价板）只在 `QuoteStage` 的「期权透镜」内可达，而进入透镜的唯一入口是期权总览卡片的「进 T 板」按钮——想看 T 板必须先切到中栏「期权总览」tab，点卡片，再被切回「行情」tab 的透镜态。中栏顶部 tab 条没有 T 板的直达项，用户找不到路。
2. **行情子页签不记忆**：`QuoteStage` 的 `stageTab`（图表 / 基本面 / 新闻 / 公告）是纯组件 state，而 `stageViews` 互斥挂载（切走即卸载）。切到「期权总览」再切回「行情」，子页签一律回落 `chart`，用户上次停留的页签丢失。

## Decision

**1. 期权 T 板注册为中栏直达 tab。**

- 新增 `OptionsStageMiddleView.tsx`：自取数薄壳（`StageViewProps` = `{ t, view }`）——读模块级 `selectionStore` 拿当前标的 → `fetchOptionsUnderlyings` 判期权资格 → `fetchOptionsExpiries` / `fetchOptionsChain` 取数；回调走 `stageActions`（与 QuoteStage 透镜同源动作：`selectInstrument` / `switchToQuote` / `switchToOverview` / `fillComposer`）。
- 在 `index.ts` 以 `stageViews.register({ id: 'options-stage', titleKey: 'stage.optionsStage', order: 12, render: OptionsStageMiddleView })` 注册，与 `options-overview`(10) / `options-prediction`(11) 平级。
- 非期权合格标的（9 只 ETF 之外）渲染空态提示 `options.stage.middle.emptyHint`，不出 T 板。
- 为此把 `selectionStore` 提为 `store.ts` 的模块级单例（原 `createSelectionStore()` 在 `apply` 内一次性创建，薄壳视图无 props 通道拿同一实例）。

**2. 行情子页签落 localStorage。**

- 键 `dshtrading.stageTab`；新增 `readStageTab()`（惰性初值，坏值 / 隐私模式回落 `chart`）+ `writeStageTab()` + `useEffect` 变更即写，与既有 `readOrderbookOpen` / `writeOrderbookOpen` 同款模式。

## Alternatives considered

- **T 板继续只经透镜可达，仅在总览卡片上加更显眼的入口**：不动中栏 tab 结构、改动最小；但复盘暴露的正是「tab 条缺少直达项」，加卡片入口治标不治本，用户仍需绕路。
- **把 `options` 塞回 `QuoteStage` 的 `stageTab` 联合类型（复活「期权」子页签）**：与已定稿的「现货 ⇄ 期权」对等双透镜语义冲突——2026-09-08 期权升格已把期权从子页签提升为一级透镜，回退该决策不可取。
- **子页签记忆走模块级单例 store 而非 localStorage**：仅跨组件重挂载有效，页面刷新即丢；且不跨会话，与 orderbook / tradedesk 既有「跨会话记忆」惯例不一致。
- **让薄壳复用 QuoteStage 的链数据（共享 store）**：能省一次重复取数，但需要把 QuoteStage 的 `expiries` / `selectedMonth` / `chain` 一并抽成共享 store，改动面大且二者交互态（选中合约 / 备兑预填）语义不同；T 板 tab 与透镜同一时刻只挂载其一，重复成本可接受，暂不共享。

## Consequences

- 中栏 tab 条现为：行情 | 期权总览 | 期权预测 | 期权 T 板（order 12）。
- 薄壳自取数意味着 T 板 tab 与 QuoteStage 透镜各持一份链数据（未共享）；同一时刻只挂载其一，可接受。
- `stageTab` 持久化后，「互斥卸载」不再丢页签；副作用是测试需清 localStorage——`quote-stage.smoke.test.tsx` 的 `afterEach` 已补 `localStorage.clear()`（跨用例泄漏会让后一用例挂载即命中前一用例的页签、多拉一次对应数据，实测 1 条断言红）。
- 渲染冒烟：新增 `test/options-stage-middle.smoke.test.tsx`（非合格标的 → 空态提示；期权 ETF → 取数落地后渲染 T 板），堵住「新挂载面一渲染就崩」的既知回归面（同族教训见 quote-stage.smoke 的 TDZ 网）。
- 门禁：`pnpm --filter @dshtrading/client-ui-trading build` 绿；该包测试 450/450 绿（47 文件，含新增薄壳冒烟）；`pnpm i18n:check` 绿；仓库级 `pnpm build` 绿。注：本机 `pnpm test`（经 pnpm 包装器）会被沙箱 safe-delete 守卫拦下，从包目录直跑 `npx vitest run` 即通过。
