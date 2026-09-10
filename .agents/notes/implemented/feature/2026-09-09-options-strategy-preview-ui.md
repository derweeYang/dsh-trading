# 期权组合策略预览（WB-4，2026-09-09）

## 结论

WB-4 的原定阻塞——「后端先定型策略结果面」——经核查已在
`packages/api/src/index.ts:238` 的 `OptionStrategyResult` 与
`OptionStrategyRequest`（148）落定，桥 `bridge.ts:903` `optionStrategy` 已 live，
`kit-cn/src/options-tools.ts:183` 的 agent 工具 `cn_get_option_strategy` 也走通。
故 WB-4 改为本轮实现。

## 实现形态（关键决策）

**Why not toolview 卡上的「加载到 T 板」按钮？**
`toolview.tsx` 的卡片是**被动展示**——只接收 `block`/`toolName`/`t`，没有回调通道
回到 `OptionsStage` 的下单面板（见 `toolview.tsx` 顶注释「契约同策略卡…running/解析失败 → null」）。
WB-4 第 4 点已预留「若 toolview 一时挂不上按钮可第二轮」。因此采用**等价且更稳的
T 板内自包含预览**：用户点「策略预览」按钮 → 选模板 → `fetchOptionStrategy`（与 agent
同一端点）→ 列出期权腿 → 每腿「填进下单面板」→ `setSelectedLeg` + `orderPrefill`。

**回溯映射**：`OptionStrategyLeg.optionType` 是 `OptionRight = 'C' | 'P'`
（`api/src/index.ts:68`），`SelectedOptionLeg.side` 是 `'call' | 'put'`，故
`'C' → 'call'`、`'P' → 'put'`。`leg.code` 长代码直接作下单主键。

**prefill 单次性**：`OptionOrderPanel` 在 `leg.code` 变化 effect 内，当且仅当
`prefill.code === leg.code` 时写 `side`/`qty`，随即调 `onPrefillApplied` 由父级清空
`orderPrefill` —— 避免后续手动改单被反复覆盖。

**默认模板 = vertical**：`covered_call`/`collar` 在 `getStrategy` 侧要求 `holdingQty > 0`
（connector-options 校验），为免无持仓即报错，UI 默认纯价差，用户可切备兑/领口。

## 改动清单

- `src/client/StrategyPreview.tsx` + `strategy-preview.module.css`（新）
- `OptionsStage.tsx`：`showStrategy`/`orderPrefill` state、`handleLoadLeg`、行动条按钮、
  StrategyPreview 渲染、`OptionOrderPanel` 增加 `prefill`/`onPrefillApplied` 并应用。
- `OptionsOrderPanel` 导出（便于单测回填行为）。
- `contract.ts` + `locales.ts`（zh/en）新增 30 键（`options.strategy.*`）。
- `test/strategy-preview.test.tsx`（3）、`test/option-order-panel.test.tsx`（2）。

## 验证

- `pnpm --filter @dshtrading/client-ui-trading build` ✅
- `node scripts/i18n-audit.mjs --check` ✅（1025 zh 键，0 错）
- `npx vitest run` ✅ 41 文件 / 342 测试（WB-4 贡献 +5）
- 类型：WB-4 文件零新增错误。交付当时 `typecheck-gate` 残留的 client-ui-trading
  node 半 +3 / kit-cn +4（task #7）已由后端在同日清偿，棘轮全绿。

## 边界 / 风险

- 真机策略数据依赖网关 `getStrategy` 内核实现；未挂连接器时 UI 优雅降级显示错误文案。
- 现货腿（kind=underlying）不可经 OptionOrderPanel 下单，预览中已过滤，仅展示期权腿。
- trading-web 真机冒烟：task #8（dataplane 撞键）与 WB-5 清单已于 2026-09-09 清完
  （见 [backend-handoff §5](../../../../docs/backend-handoff-2026-09-09.md)）；
  与 WB-7 策略列无依赖。
