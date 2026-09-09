# Agent Note: 期权总览 / 5 分钟闭环 / 箱体条（WB-0/1/2/3/6，workbuddy 前端）

Status: implemented

## Problem

交接单 [`docs/workbuddy-handoff-2026-09-08.md`](../../../../docs/workbuddy-handoff-2026-09-08.md)
§D 挂了七张工单，A/B（市场收敛涟漪、T 板交易面）已由前次会话收口，剩下 WB-0 →
WB-6 全未动。核心矛盾不是「缺页面」，而是三处**静默失真**风险：

1. 一进「期权」透镜就画当前自选的 T 板——用户停在 600519 时连期权入口都看不到，
   九标的市场没有落地页；
2. 桥侧「单行失败键缺席」的容错纪律（docs/options-bridge.md）若前端不接住，
   数据缺口会被显示成事实（整页空白或填 0）；
3. 5 分钟闭环的 `score` 是**下一桶才补到上一桶**的，若照着 `latest.score` 直接
   画 verdict，就会把「还没评估」画成「评估过了」。

## Decision

`packages/client-ui-trading/src/client/**` 内落地（不改 bridge / kit / python）：

| 工单 | 落地 |
|---|---|
| WB-0 | `api.ts` 加 `fetchOptionsOverview` / `fetchOptionsIntradayBox` / `fetchOptionsCycleLoop` / `fetchOptionsCycles`，风格对齐 `OptionsOutcome` + `optionsFailure`；`includeIv` 默认 0 |
| WB-1 | 新组件 `OptionsOverview.tsx`：只拉 `/options/overview`，缺键按单元格出「—」，T-5 色深（color-mix 走主题 token）+ 放量边框，排序 strength/iv/holdings |
| WB-6 | 新组件 `OptionsCycleLoop.tsx`：只拉 `/options/cycles/loop`，点标的再拉 `cycles?limit=24`；`running=false` 标「闭环未启动」，命中率缺席标「样本不足」 |
| WB-2 | `fillComposer(scanPrompt / scanAllPrompt)` 三处入口；T 板用总览缓存，缓存未命中先拉一次 |
| WB-3 | `OptionsStage` 加箱体条，数据由上层给：`loop.latest.forecast` 优先，闭环无该行才降级 `/options/intraday-box` |
| WB-5 | 词典 63 键（contract + zh/en）、i18n 门禁、渲染冒烟 |

两个非显然的判定：

- **透镜显隐判据放宽**：从「当前标的在名册内」改为「名册非空（挂了
  connector-options）」。否则总览这个落地页对九只以外的标的完全不可达。
  能不能进 T 板仍看 `optionsAvailable`。
- **词汇表集中一处**：`option-vocabulary.ts` 承载 regime / session+reason /
  calibration / verdict / 模板名 → 词典键的映射，用 `satisfies` 让缺项编译期红。
  T 板箱体条与闭环时间线都要用，两份映射必然漂移（漂移在 UI 上 = 直接露英文枚举值）。

## Alternatives considered

- **在 client 拼 tickers + klines + positions 造总览**：交接单明令禁止；桥已聚合，
  重复打上游且口径会漂。败。
- **`includeIv` 默认 1**：九路 vol_analytics 会打爆网关，且本地看不出来。败。
- **页面自己 `setInterval` 算箱体/打分**：与宿主 30s 心跳重复且必然漂移，
  option-cycle-loop 已否决过同族方案。败。
- **`latest.score` 缺席时补一个默认 verdict**：把「未评估」说成「评估过」，
  比留白更糟。选「待评估」。
- **总览行点击只改本地 state 不改全局标的**：T 板按全局 symbol 取数，改不动就进
  不去。改为经 `GET /options/resolve` 拿 `link.spotSymbol` 再 `selectInstrument`。

## Consequences

- `selectInstrument` 从 `src/client/index.ts` 经 QuotePane → MiddleStage →
  QuoteStage 新加一条可选注入（与 MarketSidebar 同一 store 入口）。未注入时总览
  只能看、不能进 T 板。
- `quote-stage.smoke.test.tsx` 两条用例随行为变更改写：透镜落地页断言从「直接
  出 T 板」改为「先总览 → 点行 resolve → 进 T 板」；个股用例从「无透镜」改为
  「有透镜但进不去 T 板」。
- 新增 `test/options-aggregate-fetch.test.ts`（8）、`test/options-overview.smoke.test.tsx`（10）。
- 未做：WB-4（策略卡片 → T 板预填）——交接单标「可第二轮」，需动 toolview，
  等后端把策略结果面定型再接。

## Verification

- `npx vitest run`（client-ui-trading）：**38 文件 / 327 用例全绿**（+10 新）。
- `node scripts/i18n-audit.mjs --check`：OK，998 zh keys（+63）。
- `npx tsc --noEmit -p packages/client-ui-trading/tsconfig.json`：仅剩 3 处
  **node 半**既有错误（`src/option-bar-agent.ts`、`src/option-overview.ts`，
  2026-09-08 后端提交引入），前端 client 半 0 新增。
- 未做真机宿主冒烟：本机 trading-web 宿主起不来（各市场 dataplane 重复注册，
  与 issue #81 同族），需另开后端 session 清偿后再验。

## Risks

- 总览轮询 60s 打 9×(ticker + 日 K)，若连接器限频比预期紧，需上调间隔或加
  in-flight 去重。
- `color-mix` 在老 Chromium 会静默失效（T-5 只剩文字色，不崩），桌面壳版本需 ≥111。
- 降级拉箱路径（闭环无该行时才触发）在 `regular` 外会拿到 `no_trade`，属预期。
