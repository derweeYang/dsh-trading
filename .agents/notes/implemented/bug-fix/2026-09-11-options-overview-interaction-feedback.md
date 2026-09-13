# Agent Note: 期权总览三处交互无反馈 + 「进 T 板」落错透镜（2026-09-11 三连修）

Status: implemented

## Problem

领航员报告期权总览页三个交互缺陷：

1. **「进 T 板」落到 K 线（现货透镜）而非合约面**：机会卡的语义是「看这只标的的 T 板」，
   但点击后停在现货 K 线，用户要点一次「期权」透镜才到合约面。
2. **机会卡「问 AI」无响应**：点击后界面无任何变化。
3. **明细表「AI 扫描」无响应**：同上。

CDP 探针（`.local/probe-overview-bugs.cjs`，原生 WebSocket 走 CDP、零依赖）复现结论：

- 问题 1 **成立**：点击后 `lens = 现货`。根因——`OptionsOverviewMiddleView.onPickRow` 只做
  `selectInstrument + switchToQuote`，而 `QuoteStage` 是切视图时**新挂载**的，其 `lens`
  state 初值恒为 `'spot'`，没有任何通道承接「要合约面」这个意图。
- 问题 2/3 **不是「没触发」而是「没回执」**：两个按钮确实调到了 `fillComposer`，探针观测到
  composer 文本长度 0 → 483 → 971（确实填了）。但所有调用点都是 `void fill(...)`，
  **rejection 被吞**，且成功/失败都没有任何可见状态变化 —— 用户视角就是「点了没反应」。
  `memory/2026-09-10.md` 已登记该结构性缺陷（4 个调用点全是裸 `void`）。
- 附带发现 **React #310**：本次修复初版把 `tboardScan` 的 `useState/useEffect` 写在
  `if (market === undefined || symbol === undefined) return 空态` **之后**，空态⇄有标的切换
  时 hook 数量变化，整个中栏 slot 崩（「期权总览」tab 点不到）。**此缺陷只在 live 探针下暴露**，
  tsdown 构建与当时全部单测均未发现（复刻 2026-09-03 viewTab TDZ 事故的教训）。

## Decision

- **一次性透镜请求通道**（`stage-actions.ts`）：新增 `requestQuoteLens(lens)` /
  `consumeQuoteLensRequest()` / `subscribeQuoteLens(listener)`。`onPickRow` 先 `requestQuoteLens('options')`
  再切视图；`QuoteStage` 用 `useState(() => consumeQuoteLensRequest() ?? 'spot')` 承接挂载前写入的
  意图，并用 effect 订阅处理「已挂载时再来一次」的情形。**消费即清**，不做粘性状态。
- **统一扫描状态机**（新文件 `scan-feedback.ts`）：`filling | filled | error` 三态 +
  `classifyComposerFailure` 四类可预期失败（`noSession` / `noComposer` / `busy` / `unknown`）。
  三个入口（总览顶栏「扫描标的」、机会卡「问 AI」、明细表行内「AI 扫描」）共用同一状态源
  `scanFeedback`，各自按 target 取态（`scanPhaseOf`），成功 4s 回执（`SCAN_FILLED_HOLD_MS`）
  后回落空闲，失败态**留到下次点击**并在页面上以 `role="alert"` 上浮本地化原因。
- **T 板扫描不再静默空操作**：快照缺席时回落 `t('options.scan.fallbackPrompt', { symbol, name })`
  最小 prompt，而不是直接 return；`scanUnderlying` 全链路 `.then/.catch` 落状态。
- **hooks 前移 + 回归网**：`tboardScan` 两个 hook 移到首个 early return 之前，并加注释钉死
  约束；`quote-stage.smoke.test.tsx` 新增「空态 → 有标的：hooks 数量恒定」TDZ 网。

## Alternatives considered

- **把 lens 放进共享 store（`optionsOverviewStore` 同款）**：会变成粘性状态，切标的、刷新、
  二次进入都受上一次意图污染；一次性请求 + 消费即清才与「点击的瞬时意图」语义对齐。
- **点击后自动提交 composer**：owner 已裁决 `fillComposer` 只预填不自动提交，保持。
- **只给按钮加 loading、不落失败原因**：`fill-composer.ts` 的四类失败（无会话/无 composer/
  会话忙/未知）各有不同处置，用户需要看到「为什么没成」，故必须上浮文案而非只转圈。
- **不修 T 板 `void` 吞异常，只修总览两处**：探针显示 T 板分支同样静默，一并纳入状态机。

## Consequences

- 新增 i18n 键 `options.scan.filling|filled|failed`、`options.scan.error.*`、
  `options.scan.fallbackPrompt`（zh/en + `contract.ts` 联合类型）。`dsh-i18n` 是**构建期**
  import 各包 `locales.ts`，所以**改词后必须重建 client 包**，否则 `pnpm i18n:check` 报
  「central zh-CN dict drifted」。
- `QuoteStage` 的 hooks 顺序被约束住：任何新 hook 都必须留在首个 early return 之前，
  文件内已有注释说明；jsdom 渲染网会拦。
- 扫描状态是**每次点击的单发状态**，不做队列：连点同一按钮会覆盖上一次回执（可接受，
  与「同一 target 只有一个动作在飞」的现实一致）。

## Verification

- `pnpm --filter @dshtrading/client-ui-trading test`：**439/439 全绿**（+1 为新增 TDZ 网）。
- `pnpm i18n:check`：OK，5 namespaces / 1073 zh keys。
- **产物核验**：从宿主 HTTP 抓 `/plugins/??…@dshtrading/client-ui-trading/client.js`，
  新标记 `options.scan.fallbackPrompt` 命中 3 处 → 线上托管的确实是新产物。
- **live 探针回归（已通过）**：宿主 HTTP + 无头 Chrome + 零依赖 CDP 驱动，两轮：
  1. `probe-overview-bugs.cjs`（复现用）：**「进 T 板」后 `lens = 期权`**（修复前为 `现货`）；
     「问 AI」composer `0 → 483`、行内「AI 扫描」`483 → 971`（确实填入）；
     `unhandledRejection = 0`。
  2. `probe-scan-state.cjs`（新增，专测状态时序）：三个扫描入口点击后均出现可见回执——
     `+300ms / +1200ms / +2600ms` = `已填入输入框 | filled`，`+5200ms` 回落空闲（匹配
     `SCAN_FILLED_HOLD_MS = 4000`）。这是「点了有反应」的直接证据。
  未跟踪到的唯一 `window.error` 是 `Object is disposed`（`DevicePixelContentBoxBinding`），
  图表 ResizeObserver 卸载期的旧噪声，与本轮交互无关。
- **工具约束（复现用）**：本机 Chrome 无法从 Bash/后台任务进程树存活 —— bash 直接拉起时
  launcher 立即退出且 CDP 9223 不开；`Start-Process` 拉起时 +6s CDP 可用，但调用一结束就被
  回收；后台任务另有 ~2 分钟上限，撑不完一轮探针。**可行姿势**：PowerShell 工具
  `Start-Process`（断链，`-WindowStyle Hidden`）拉起 Chrome，**并在同一次调用内**跑完
  node 探针（foreground + 显式 `timeout` 数百秒）。
- `rm -rf .local/chrome-profile-wb` 触发沙箱批量删除确认（67 文件 > 阈值 50）被拒 —— 本机
  safe-delete 老坑，建 Chrome profile 一律用带时间戳的新目录，不删旧目录。

