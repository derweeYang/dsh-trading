# 期权总览重构：叠加走势 + 机会卡三段式（WB-9，2026-09-09）

## 结论

领航员诉求两点：① 九个标的 5 日走势画在一张图上看强弱；② 每个机会要有
「分析数据 / AI 解读 / 操作计划」。落地为**三段式总览**：叠加走势图 → 机会卡 →
明细表（原 WB-1 表格保留可折叠）。前端在 `src/client/**` 内完成；后端随后把账本
已有的 `logic` / `playbook` 投影进总览行（任务 #9，见文末）。

## 关键决策与推导

**① 为什么用「共用 Y 轴的叠加图」替换九条独立 sparkline？**
独立 sparkline 各自按自己的 min/max 归一化，九条线**不可比**——只能看出谁波动大，
看不出谁强谁弱。叠加图统一以 T-5 首日收盘为 0%，**线的相对位置就是强弱序**，
这才回答「买谁 / 避谁」。视觉分层按诉求：最强 / 最弱 / 中位粗线全不透明 + 末端挂名，
其余 opacity 0.34 细线；悬停图例把该线提到 opacity 1、其余压到 0.1，用于临时聚焦。

**排序用 5 日累计而非 strengthScore**：`strengthScore = return5d × volumeRatio`
含量能因子，名次会与曲线终点错位——用户会看到「第 1 强」的线不在最上面。
故 `rankByCumulative` 按图上终点排序，保证视觉与名次一致（`option-insight.ts:rankByCumulative`）。

**② 解读与计划：不新建 LLM 调用，先把已有字段捞回来。**
后端 `OptionBarRecommendation` 已写 `logic`（解读）与 `playbook`（操作计划）
（`packages/api/src/index.ts`）。任务 #9 后 `overviewStrategyOf()` 把二者投影进
`OptionOverviewStrategy`（空串不写键）。前端按宽容类型 `StrategyExtras`
预读：字段到位即原文展示并标来源 `ai`；缺席时回落到**规则解读**并标 `rule`，
卡上来源徽章必显式——不把规则生成的文字伪装成 AI 结论。

**③ 风险识别做成一等公民。**
`deriveRisks` 把「价升量缩 / 价跌量增 / IV 极值 / IV 盲区 / 有持仓敞口 /
无底仓却要备兑 / 有 edge 无失效条件 / 样本不足」顶到卡头，warn 排 info 前。
缺 IV 一律打「IV 缺失」，不猜中性值。

**④ 计划里绝不编造价位。**
骨架态只给流程步骤（取箱体 → 策略预览核希腊字母 → 按风险上限定张数 → 记失效条件），
**不生成目标价 / 止损价**——箱体必须走 `cn_get_option_intraday_box`（交易会话守则）。

## 落地清单

| 文件 | 内容 |
|---|---|
| `src/client/option-insight.ts` | 新增纯函数层：`deriveRisks` / `composeReading` / `composePlan` / `rankByCumulative` / `sortByOpportunity`；零 I/O、零重算 |
| `src/client/OverlayTrendChart.tsx` | 新增：九线共 Y 轴叠加图 + 图例联动 |
| `src/client/OptionsOpportunityBoard.tsx` | 新增：机会卡（数据 / 解读 / 计划 / 风险 / 出口） |
| `src/client/OptionsOverview.tsx` | 三段式布局；删 `OptionsStrengthStrip`（被叠图取代）；顺带修 `dayCell` 两个死参数 |
| `src/client/options-overview.module.css` | 叠图 / 卡片 / 图例 / 风险标签样式（token 同族，暗色自适应） |
| `src/client/contract.ts` + `locales.ts` | 新增 60 个 i18n 键（zh/en 齐全） |
| `test/option-insight.test.ts` | 新增 22 例：累乘口径、缺 IV 不猜值、来源标注、blocker |
| `test/options-overview.smoke.test.tsx` | 改 2 例（表头限定、strip → 叠图）+ 新增 5 例 |

## 验证

- `vitest run`（client-ui-trading）：**374 passed**（原 342，+32）。
- `node scripts/typecheck-gate.mjs`：234 < 基线 239，棘轮通过；已 `--update` 下调基线至 234
  （`dayCell` 死参数修掉 5 处 TS2554）。client 半零新增错误。

## 后端投影（任务 #9，2026-09-09 已清偿）

`OptionOverviewStrategy` 已补可选 `logic?: string` / `playbook?: string`
（`packages/api/src/index.ts`），`overviewStrategyOf` 两分支条件插入（空串不写键）。
账本有原文时总览行带上，前端机会卡来源徽章自动从「规则」切「AI」。
前端后续可删 `option-insight.ts` 的 `StrategyExtras`，改为直读强类型字段
（属 workbuddy 范围，本变更未动 `src/client/**`）。
见 [backend-handoff §6](../../../../docs/backend-handoff-2026-09-09.md)。
