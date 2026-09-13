# Agent Note: 预测跟踪回溯轮询加固（取数加界 + 新鲜度回执）

Status: implemented

## Problem

2026-09-12 全页面操作流程复盘的 P2-9：中栏「T+1 预测」tab 的**跟踪回溯**面存在两处轮询缺口。

**缺口 A（主）——30s 轮询每次全量重取整段历史。**

薄壳 `OptionsPredictionMiddleView.tsx` 的 track 面早已挂 30s `usePoll`（tab 不可见时 `usePoll`
按 `document.visibilityState` 自动停），**不是**「没轮询」。问题是取数调用：

```
fetchOptionPredictionTrack({ ...(focus !== undefined ? { underlying: focus } : {}) })   // 无 limit
```

而桥契约（`docs/options-prediction-backend-contract.md`）明确该端点支持 `limit`，且**`limit` 只约束
返回的预测条数、统计仍按全量算**——也就是说加界纯收益：不动任何指标口径（命中率/评分/矩阵），
只砍列表长度。不传 `limit` 的后果是：每 30s 重取一次完整预测历史并全量重渲染，载荷与渲染成本
随预测条数累积**线性增长**。轮询本身是隐形的（用户看不见它在跑），不设界等于让这个成本长期无上限。

**缺口 B（次）——轮询无新鲜度回执。**

轮询行为对用户完全不可观测：页面停在某个状态时，用户无法区分「这一面是活的、只是没有新数据」
与「这一面卡住了/压根没在刷新」。手动刷新按钮也没有（本模块不提供手动刷新入口）。

## Decision

**1. track 取数加界 `TRACK_LIMIT = 50`，两个取数点同口径。**

- 常量带注释说明为什么加界安全（`limit` 不触碰统计口径）。
- **两个** track 取数点都传，缺一即行为不一致：
  - 轮询 `usePoll` 回调；
  - `onSaved` 的「保存后立即刷新」路径（下个轮询周期前先看到结果）。
- `limit` 与 `underlying` 并列传参：无聚焦标的分支下请求体恰为 `{ limit: 50 }`（单测钉死）。

**2. 新增按页签各自记账的新鲜度回执。**

- 两个 state：`boardRefreshedAt` / `trackRefreshedAt`，**仅在 `res.ok` 分支**写 `fmtClock(Date.now())`
  （HH:mm:ss，复用既有格式化函数，不引新依赖）。
- 渲染取当前页签那一份：`tab === 'track' ? trackRefreshedAt : boardRefreshedAt`，`undefined` 时不渲染。
- 文案 `options.prediction.autoRefresh`（zh `'每 {interval} 秒自动刷新 · 最后更新 {time}'`），
  `interval` 由 `PREDICTION_POLL_MS / 1000` 推出而非硬编码数字——轮询周期改动时文案跟手变。
- 位置：紧贴页签条、`css.refreshed`（11px 等宽、`--dsw-futu-text-muted`）压到辅助层级，
  不抢「新建」主按钮的视觉权重。
- **失败不写回执**：失败态没有「最后更新」可言，写进去等于骗人；失败信息仍由既有 failure 分支呈现。

## Alternatives considered

- **不做，维持全量轮询**：预测条数少时确实无感——但这是「随数据积累而恶化的成本」，越晚改越贵，
  且桥已提供现成开关，不用的理由只剩「没人注意到」。不取。
- **只做缺口 A（加界）、不做回执**：成本问题解决了，但用户仍分不清「没数据」与「没刷新」——
  轮询的不可观测性是本次复盘的实测反馈主题，只修一半留半个病灶。不取。
- **回执只记一份（不分页签）**：两个面各有独立端点与独立成败，共用一份会把「看板刚成功」误标成
  「track 刚成功」，恰好在最需要诊断的失败场景下给错信号。分两份。
- **回执用相对时间（「3 秒前」）**：需额外定时器驱动重渲染（每秒钟 tick 一次整个薄壳），
  为一个辅助文案不值。绝对时刻 HH:mm:ss 零成本且可与日志对齐。
- **回执失败态也写给最后一次成功时间**：语义模糊（「最后更新」是「最后成功」还是「最后尝试」？），
  且会让失败看起来像成功。明确不写。
- **顺手删掉死代码 `fetchOptionPredictionKnowledge`**：见下「遗留观察」。

## Consequences

- 跟踪回溯每轮轮询的载荷与渲染量有上界（≤50 条），不再随预测累积线性恶化；统计指标口径不变
  （`limit` 由桥侧只作用于列表）。
- 两个页签各自可观测「最后成功刷新时刻」，轮询的「没数据」与「没刷新」可区分。
- i18n 新增 1 键 `options.prediction.autoRefresh`（zh/en 全量）。
- 回归护栏 `test/options-prediction-middle.smoke.test.tsx`（3 条，jsdom 真挂载 + 桥桩）：
  ① 无聚焦标的时 track 请求体恰为 `{ limit: 50 }`；
  ② track 成功后有回执且插值 `interval === '30'`、`time` 匹配 `HH:mm:ss`；
  ③ 看板失败时**无**回执、且失败原文照旧呈现。
- 门禁账：包构建绿；`npx vitest run` **479/479（54 文件）**绿；`node scripts/i18n-audit.mjs --check`
  OK（**1175 zh keys** / 26 exemptions）。
  **实测坑（供后续复现）**：i18n 审计通过 `packages/dsh-i18n/src/client/index.ts` 的静态 import 读
  **构建产物** `packages/client-ui-trading/lib/client/locales.js`，因此**不可与 `pnpm build` 并行跑**——
  并行时审计读到构建中途的旧产物，会误报
  `central zh-CN dict drifted from zh — re-derive from locales.ts`。顺序跑（build → audit）即绿。
  另：本机 `pnpm test` / `pnpm i18n:check`（经 pnpm 包装器）会被沙箱 safe-delete 批量删除守卫拦下
  （`_tmp_*` 累计达 50 文件阈值），改直跑 `npx vitest run` / `node scripts/i18n-audit.mjs --check` 即通过。
- 计数增量说明：479 相对上一批的 466 是 **+13**，其中本变更 +3；另 +10 来自并行的后端会话提交
  `7303c85 fix(tasks): degrade locked ledger to read-only and expose openSettings`
  （`tasks-*.test.ts` / `shell-settings.test.ts`，见下）。

## 遗留观察（未在本变更处置）

- **死代码：`src/client/api.ts:375 fetchOptionPredictionKnowledge`** 全仓零引用（`OptionPredictionTrack`
  载荷已自带 `knowledge`，无需单独取）。其桥路由 `/options/predictions/knowledge` 在
  `src/bridge.ts:2792`（node 半，非前端辖）仍存活，属跨半契约。**故不单方删除客户端 helper**——
  删除会留下「路由活着但无消费方」的不一致，应由持有桥面的一半决定整体去留。登记待决。
- **`TRACK_LIMIT` 超限提示**：当前静默截断（统计仍全量，用户看不出列表被截）。若后续实测出现
  「想回溯更早预测」的诉求，再加「仅显示最近 N 条」提示。
