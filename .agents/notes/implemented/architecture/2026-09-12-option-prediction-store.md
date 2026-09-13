# Agent Note: 期权 T+1 预测权威算法迁入 kit-cn

Status: implemented

## Problem

前端预测模块已挂 5 条 `/options/predictions*` 路由，命中与评分必须只在后端算。
缝实现散落在 client-ui node 半的 `prediction-store.ts`，kit-cn 无单测、算法无法
被其它工具复用。

## Decision

按契约路径 A：权威算法（`scoreOutcome` / `predictionStatsOf` / `aggregateKnowledge`）与
`predictions.jsonl`（`optionsDataRoot()`）迁到 `@dshtrading/kit-cn` 的
`PredictionStore`。桥保留校验与信封，node 半只再导出 kit-cn。预测路由仍不调用
期权网关。`createdAt` 聚合取 `max(createdAt, settledAt)`。
自动回填走 `settle-auto`：盘势用现货日 K，波动用 iv-daily（ATM IV 优先）。
默认 `asOf` 为 T-1（上一已收盘交易日）。GET 看板/跟踪先自动回填到期未结算条；
手工 `POST /settle` 已写 outcome 的不覆盖。
日预测以 `dayPrior` 注入 ContextPacket / 扫描 prompt，只给盯盘模型作先验；
`opportunityAllowed` 不读此键（方案 2，非硬闸）。

## Alternatives considered

**路径 B（create 接自动预测引擎）**：契约允许，但前端录入面不依赖自动引擎；
引擎未就绪，接上会扩大验收面。

**换 DB**：量级是按标的+交易日一条的日志，JSONL 与纸面/账本同源目录足够。

## Consequences

kit-cn 单测覆盖评分、矩阵、经验去重、create 幂等，以及日 K/IV 自动分类。
对外原 5 路由不变；新增 `POST /options/predictions/settle-auto`（单条 id 或按
T-1 / 显式 asOf 批量）。盘势默认阈值 0.5%/1.5% + 放量突破；波动优先 ATM IV，否则 HV20。
数据来自 CN `getKlines(1d)` 与 `iv-daily.jsonl`，不调期权网关。
