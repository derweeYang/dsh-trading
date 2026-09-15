# Agent Note: 纸账户执行链 D/E 断点修复（rate 必填、forecasts 兜底、失败可观测）

Status: implemented

## Problem

2026-09-15 盘后核查：纸账户零成交进入第 6 个交易日，且当日 3 个带腿推荐
（10:30 direction_delta 159919 看涨价差、10:55 mean_reversion 159919 认沽信用价差、
11:05 510050 vertical 无腿）**连 skip 记录都没落盘**（对比 09-14 尚有 3 条
skip:no_quote）——执行痕迹为零。定位出两个新断点 + 一个观测缺失：

1. **E：getMargin 漏 `rate`（必然 no_quote）**。实测（POST :8090 /v1/strategy）：
   source=iquant 时内核 `rate` 必填（"rate is required for source=iquant"）。
   kit-cn `src/index.ts` 的 getMargin 与 option-bar-agent.ts:314 的内联 getMargin
   均未传 → 每次保证金查询都 throw → catch 成 undefined → decidePaperOpen 判
   no_quote。今晨修复只解决了腿的 XOR 格式（code 与 optionType/strike/expiryMonth
   二选一，`strategy.py:462-468`），rate 这层仍断。带 rate:0.02 + code-only 腿实测
   返回 totalInitial=6053.4（159919P2609 卖出腿）。
2. **D：forecasts 漏传即整行丢失（推荐落盘而非成交）**。
   `cn_put_option_bar_recommendation` 的 forecasts 参数是 description 约定；
   `normalizeRecommendation`（option-bar-ledger.ts:507）遇 picks 标的缺 forecast
   直接 throw "missing forecast"——agent 漏传时推荐整行不落盘（打分闭环也断）。
   而若 agent 传了 forecasts，tryPaperOpen 又只认入参 map，别无兜底。
3. **观测缺失（两级静默吞错）**：options-tools.ts 的
   `void tryPaperOpen(...).catch(() => {})` + option-paper.ts tryPaperOpen 总
   catch 空体——任何执行失败（含 loadPaperState/savePaperState 异常）无痕迹，
   本次"零落盘"无法定位线上宿主实际断点。

## Decision

- **rate 补齐**：两处 getStrategy 调用加 `rate: 0.02`（内核错误信息示例值；
  保证金对 rate 仅一阶敏感）。kit-cn `src/index.ts`（getMargin 注入）与
  `client-ui-trading/src/option-bar-agent.ts:319`（内联 getMargin）。
- **forecasts 兜底**：新增 `backfillForecastsFromCycles(root, date, bucketStart,
  wanted)`（option-bar-ledger.ts）——从当日 cycles jsonl 取该标的 ≤ 本桶最后一条
  `forecast`（完整 OptionIntradayBoxRow，candidates 含 bias；packet rows 的
  candidates 只有模板字符串，不能替代）。put 工具在 normalizeRecommendation
  **之前**对 picks 的缺口做兜底（漏传也能过校验、进执行），并打 log。
- **观测**：OptionToolOptions / tryPaperOpen 加可选 `log`；两级 catch 全部接
  （put 工具 `.catch` 记 rejected；tryPaperOpen 总 catch 记 bucket+picks 数）。
  kit 宿主注册处用 `ctx.logger('dsh-trading-cn-kit')` 注入。
- **复盘 md 执行覆盖**：foldDailyReview「跳过」节加一行
  `执行覆盖: 带腿推荐 N 桶，成交 X，有执行记录 Y，无执行记录 Z（执行断链…）`——
  hit 表只反映预测口径，会掩盖执行缺口（当日实证）。

## Verification

- kit-cn vitest：**15 文件 / 205 用例全绿**（较今晨 +2：cycles 兜底端到端
  「漏传 forecasts → reason:signal 落盘」、复盘执行覆盖两态断言）。
- `pnpm --filter @dshtrading/kit-cn build`：绿（25 files, 248.76 kB）。
- client-ui-trading vitest：**65 文件 / 567 用例全绿**。
- `npx tsc --noEmit`（kit-cn）：27 条全在 fundamentals.ts（历史基线），本次
  触及文件 **0 新增**。
- `node scripts/i18n-audit.mjs --check`：OK，1339 keys / 27 exemptions，与基线一致。
- **端到端取证**（真实数据）：tmpdir 拷贝当日真实 cycles + 02:55 桶真实 rec
  （不带 forecasts）→ put 工具（新 lib）→ 日志「已从当日 cycles 兜底」→
  FILL `reason:signal` 5 组 sell P4800@0.0777 / buy P4700@0.0317，
  margin 30267、fee 17、cashAfter 72016。

## Consequences / 待办

- **线上宿主版本未核实**：今日零落盘的最优解释是宿主/agent 会话进程跑的
  kit-cn 与工作区不同步（闭市桶 17:30 仍在写 recommendations、fills 文件被
  noop touch，说明 tryPaperOpen 路径活着；但带 picks 桶零痕迹与工作区代码
  行为不符）。**重启/重部署宿主 + 次日开盘盯 fills** 是验收；观测日志上线后
  断链可定位。
- 11:15/11:20 两桶 "agent turn ended with an error" 后盘中桶停摆：用户确认
  为切换工作系统所致（下午缺数据正常），非 bug。
- bug-fix 笔记（09-15 晨）的待办 #1（cn_get_option_strategy schema 缺
  optionType/longStrike/shortStrike）仍开放，归 Cursor/Claude。
