# 期权 T+1 预测模块 —— 后端服务接口契约

> 状态：**路径 A 已落地；自动回填默认 T-1；GET 看板/跟踪先回填；手工 settle 不覆盖**
> 配套任务：task #7（`后端实现期权 T+1 预测服务`）
> 前端代码：`packages/client-ui-trading/src/client/{OptionsPredictionBoard,OptionsPredictionEditor,OptionsPredictionTrack,OptionsPredictionMiddleView}.tsx`
> 契约类型：`packages/api/src/index.ts`（搜索 `MarketExpectation` / `OptionPrediction`）
> 桥当前实现（缝）：`packages/client-ui-trading/src/bridge.ts` + `packages/client-ui-trading/src/prediction-store.ts`

---

## 0. 背景与边界

前端预测模块是一条**结构化预测日志 → T+1 收盘回填 → 命中评估 → 经验聚合**的闭环
（盘势 6 类 + 波动 2 类；预测由用户 / Agent 经编辑器录入结构化「分析过程 / 评估方法」）。
它**不是**自动行情预测引擎——自动引擎是后端未来扩展。

当前桥用 `prediction-store.ts` 的本地 JSONL 缝实现全部读写，目的仅是为前端提供可运行
的数据面。后端 Cursor 会话的任务是：**用真实预测引擎 / 持久化服务替换这个缝**，且
**对外契约（路由、请求/响应形状、业务规则）必须保持不变**，否则前端会破。

前端的核心硬约束：**命中与评分的权威计算只在后端**（`settle` 路径），前端只提交
**原始实盘数据**。这是防双算 / 防篡改的设计，后端必须严格遵守。

---

## 1. 前端依赖的后端接口清单（5 个路由）

所有路由挂在 `/dshtrading/api/options/predictions*`（与现有期权路由同前缀，**不依赖期权
网关**——预测路由不走 `requireCnOptions`，网关未起也能用）。前端经 `api.ts` 的 5 个方法
调用，统一用 `OptionsOutcome<T>` 信封。

| # | 方法 | 路径 | 前端方法 | 成功返回 |
|---|------|------|----------|----------|
| 1 | GET | `/options/predictions?underlying=&asOf=` | `fetchOptionPredictions` | `{ ok:true, board: OptionPredictionBoard }` |
| 2 | GET | `/options/predictions/track?underlying=&limit=` | `fetchOptionPredictionTrack` | `{ ok:true, track: OptionPredictionTrack }` |
| 3 | POST | `/options/predictions` | `createOptionPrediction` | `{ ok:true, prediction: OptionPrediction }` |
| 4 | POST | `/options/predictions/settle` | `settleOptionPrediction` | `{ ok:true, prediction: OptionPrediction }` |
| 5 | GET | `/options/predictions/knowledge?underlying=` | `fetchOptionPredictionKnowledge` | `{ ok:true, knowledge: readonly PredictionKnowledgeItem[] }` |
| 6 | POST | `/options/predictions/settle-auto` | （后端/Agent；前端编辑器仍走 #4） | `{ ok:true, prediction }` 或 `{ ok:true, result: { settled, skipped } }` |

### 1.1 响应信封（前端约定，后端必须一致）

- **成功业务包**：`{ ok: true, <payload> }`（HTTP 200）。
- **业务失败**：`{ ok: false, code: string, message: string }`（HTTP 200 + 该包；前端据此
  `reject`，不会把 undefined 当成功）。
- **协议错误**：HTTP 400 + 任意 body（前端 `getJson` 读 `code`/`message`，缺则回退状态码）。
  桥当前用 `BridgeProtocolError(400, msg)` 抛出，建议后端沿用同款 400 语义。

> 注意：前端对 GET 路由在 `wire.board/track/knowledge` 缺失时判失败
> （`optionsFailure(new Error('... missing in wire'))`）。后端**必须**在 200 包里带齐对应键。

---

## 2. 请求体字段级契约

### 2.1 POST `/options/predictions` —— `OptionPredictionDraft`

| 字段 | 类型 | 必填 | 校验（桥现行，后端须等价） |
|------|------|------|----------------------------|
| `underlying` | string | 是 | 非空（6 位 ETF 代码，如 `510050`） |
| `underlyingName` | string | 否 | 非空字符串才写入 |
| `targetDate` | string | 是 | `^\d{4}-\d{2}-\d{2}$`（T+1 交易日） |
| `marketExpectation` | enum | 是 | `big_up\|small_up\|big_down\|small_down\|breakout\|consolidation` |
| `volExpectation` | enum | 是 | `up\|down` |
| `confidence` | number | 是 | `[0,1]` 有限数 |
| `factors` | `PredictionFactor[]` | 是（可空数组） | 每项 `label`/`evidence` 非空、`bias∈{bull,bear,neutral}`、`weight` 缺省或 `[0,1]` |
| `thesis` | string | 是 | 非空 |
| `evaluationMethod` | string | 是 | 非空（如何判定盘势/波动命中） |

桥对缺键 / 非法枚举 / 越界统一 `BridgeProtocolError(400, ...)`（见 `bridge.ts:1377-1438`）。

### 2.2 POST `/options/predictions/settle` —— `OptionPredictionSettle`

| 字段 | 类型 | 必填 | 校验 |
|------|------|------|------|
| `id` | string | 是 | 非空（= `predictionId(underlying, targetDate)`） |
| `realizedMarket` | `MarketExpectation \| 'na'` | 是 | 合法枚举或 `'na'`（无法判定） |
| `realizedVol` | `VolExpectation \| 'na'` | 是 | `up\|down\|'na'` |
| `marketReturnPct` | number | 是 | 有限数（实际涨跌幅 %，收盘 vs 前收） |
| `volChange` | number | 是 | 有限数（波动率变化小数，正=升） |
| `retrospect` | string | 否 | 复盘笔记 |
| `knowledgeNotes` | string | 否 | 经验沉淀 |

> 关键：**前端只提交原始实盘**。命中（hitMarket/hitVol）与 `score` **不得**由前端算，
> 后端按 §4 权威计算并写回 `outcome`。

### 2.3 POST `/options/predictions/settle-auto`（后端自动回填，前端可选）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 有则只回填这一条；无则按 `asOf` 批量 |
| `asOf` | YYYY-MM-DD | 否 | 缺省 = **T-1**（上一已收盘交易日：日 K 最后一根 `<` 今日，否则上一上海工作日）；`targetDate > asOf` 跳过。已 `settle` 的条目不覆盖。GET 看板/跟踪默认先跑一轮该回填。 |
| `retrospect` / `knowledgeNotes` | string | 否 | 写入 outcome |

`realized*` 由后端从 **CN 现货 1d K**（`5xxxxx.SH` / `1xxxxx.SZ`）与 `iv-daily.jsonl` 算出，再走 §4 `scoreOutcome`。默认分类见 kit-cn `DEFAULT_PREDICTION_EVALUATION`（0.5%/1.5% + 放量突破；波动 ATM IV 否则 HV20）。不调期权网关。

---

## 3. 响应数据类型（`@dshtrading/api`，单一真相源）

后端返回的对象必须与 `packages/api/src/index.ts` 的接口逐字段对齐（前端按这些类型
反序列化）。最关键的几个：

- `OptionPrediction`：`id, underlying, underlyingName?, asOfDate, targetDate,
  marketExpectation, volExpectation, confidence, factors, thesis, evaluationMethod,
  createdAt, outcome?`
- `PredictionOutcome`：`realizedMarket, realizedVol, marketReturnPct, volChange,
  hitMarket, hitVol, score, retrospect, knowledgeNotes, settledAt`
- `OptionPredictionBoard`：`{ asOf, rows: OptionPredictionBoardRow[] }`，
  每行 `{ underlying, underlyingName?, latest?, marketHitRate?, volHitRate?, total }`
- `OptionPredictionTrack`：`{ underlying?, predictions: OptionPrediction[], stats, knowledge }`
- `OptionPredictionStats`：`{ total, scored, marketHitRate, volHitRate, avgScore,
  marketMatrix, volMatrix }`
- `PredictionKnowledgeItem`：`{ id, lesson, condition, sources: string[], usage, createdAt }`

> `id` 派生规则（前端契约隐含）：`predictionId(underlying, targetDate) = `${underlying}-${targetDate}``。
> 同标的同 T+1 唯一，重复提交即覆盖（幂等）。后端 `create` 必须复用此规则，否则 `settle`
> 按 id 查找会失配。

---

## 4. 后端必须复刻的业务规则（权威算法）

以下是 `prediction-store.ts` 现行实现，**后端替换缝时逻辑必须逐字等价**，否则前端
统计/命中展示会漂移。

### 4.1 评分（settle 权威计算，`scoreOutcome`）

```
hitMarket = realizedMarket !== 'na' && realizedMarket === prediction.marketExpectation
hitVol    = realizedVol    !== 'na' && realizedVol    === prediction.volExpectation
components = []
if (realizedMarket !== 'na') components.push(hitMarket ? 1 : 0)
if (realizedVol    !== 'na') components.push(hitVol    ? 1 : 0)
score = components.length === 0 ? 0 : sum(components) / components.length
// outcome 写回：realized* / marketReturnPct / volChange / retrospect / knowledgeNotes 原样拷贝
// settledAt = now (ISO)
```

要点：
- `realizedMarket/realizedVol === 'na'` 时该维度**不计入命中率分母**（见 §4.2 `marketScored`）。
- `score` 是「可判定维度」上的命中均值，不是「预测维度」均值。

### 4.2 统计（`statsOf`）

- `total` = 预测条数；`scored` = 有 `outcome` 的条数。
- `marketScored` = `outcome.realizedMarket !== 'na'` 的条数；
  `marketHitRate = marketHits / marketScored`（样本不足 = 0，前端展示 `—` 自行判断）。
- `volHitRate` 同理（`realizedVol !== 'na'`）。
- `avgScore = Σ outcome.score / scored`。
- `marketMatrix[MarketExpectation] = { predicted, hit }`；`volMatrix[VolExpectation] = {predicted, hit}`。
  矩阵 `predicted` 计**全部**该分类预测，`hit` 只计 `realized !== 'na'` 且命中的。

### 4.3 经验聚合（`aggregateKnowledge`）

- 以 `knowledgeNotes.trim().toLowerCase()` 为去重键（归一化文本）。
- 同 key 合并：`sources` 累加预测 id（去重），`usage` 每命中一条预测 +1，
  `createdAt` 取 max(createdAt, settledAt)，`condition` 取该预测 `thesis`。
- `id = kn-${firstPredictionId}-${key.length}`；结果按 `usage` **降序**（最常验证的靠前）。
- 仅聚合 `outcome.knowledgeNotes.trim() !== ''` 的预测。

### 4.4 看板（`board`）

- 每标的取 `targetDate` 最新（同 `targetDate` 再按 `createdAt` 降序）的一条为 `latest`。
- `marketHitRate/volHitRate/total` 按该标的全量预测算（同 §4.2）。

---

## 5. 后端实现目标（替换缝的两种路径）

`prediction-store.ts` 导出的 `PredictionStore` 类就是后端应对齐的接口面：

```ts
class PredictionStore {
  board(underlying?, asOf?): Promise<OptionPredictionBoard>
  track(underlying?, limit?): Promise<OptionPredictionTrack>
  create(draft: OptionPredictionDraft): Promise<OptionPrediction>
  settle(input: OptionPredictionSettle): Promise<OptionPrediction>
  knowledge(underlying?): Promise<readonly PredictionKnowledgeItem[]>
}
```

Cursor 会话二选一：
- **A（推荐，最小改动）**：保留 `bridge.ts` 路由骨架，把 `PredictionStore` 内部从 JSONL
  换成真实存储（DB / kit-cn 状态服务），算法按 §4 复刻。前端零改动。
- **B（接预测引擎）**：在 `create` 路径接 kit-cn / python 预测引擎（自动或半自动生成
  `draft` 的 `marketExpectation/volExpectation/factors/thesis/evaluationMethod`），其余
  路由不变。引擎产出仍走同一 `OptionPredictionDraft` 契约。

当前缝的持久化位置：`optionsDataRoot()`（来自 `@dshtrading/kit-cn`）下的 `predictions.jsonl`。
换存储时该文件可弃，但 `optionsDataRoot()` 的目录约定建议保留（与期权其他状态同源）。

---

## 6. 验收标准（Cursor 会话完成时）

1. 前端 `pnpm --filter @dshtrading/client-ui-trading test` 仍 **439/439 全绿**、`build` 全绿
   （契约未变，理应直接通过）。
2. 后端（kit-cn / python）新增单测覆盖：
   - `scoreOutcome`：na 不计分母、`score` 为可判定维度均值、命中判定等价；
   - `aggregateKnowledge`：归一化去重、`usage` 累加、按降序；
   - `statsOf`：矩阵 `predicted/hit` 口径、命中率样本不足=0。
3. `create` 幂等：同 `underlying+targetDate` 第二次提交覆盖第一次，`settle` 能按 id 命中。
4. 预测路由不依赖期权网关（网关未起时 5 路由仍可用）。

---

## 7. 非依赖 / 超出范围（明确划线）

- 前端**不**依赖任何「自动预测」后端。A/B 任一路，引擎是后端内部实现，前端只认
  `OptionPredictionDraft` / `OptionPredictionSettle` 契约。
- `knowledge_search`（本地知识库检索）在前端是**可选增强**（编辑器未来可做「历史相似
  形态」辅助录入），当前**不是**硬依赖，后端无需为此提供接口。
- 实时行情 / 期权网关（:8090）与预测模块正交，预测路由刻意不调用。
- 盯盘推荐硬闸（`opportunityAllowed`）不读预测。日预测只作为 `dayPrior` 写入
  ContextPacket 与 scanPrompt，模型可引用、不得据此发明模板。
