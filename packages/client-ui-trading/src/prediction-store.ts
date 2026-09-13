/**
 * T+1 预测模块 —— 桥 node 半再导出。
 *
 * 权威算法与 JSONL 落盘已迁到 `@dshtrading/kit-cn`（`option-predictions`）。
 * 桥继续从此文件 import，避免前端半误接到存储实现。
 */
export {
  PredictionStore,
  aggregateKnowledge,
  predictionId,
  predictionStatsOf,
  scoreOutcome,
} from '@dshtrading/kit-cn'

export { predictionStatsOf as statsOf }
