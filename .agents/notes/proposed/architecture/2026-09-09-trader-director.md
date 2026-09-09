# Agent Note: 交易员总控（TraderDirector）薄编排

Status: proposed

## Problem

目标智能体需要同时具备：丰富期权知识、盘中机会捕捉、交易行为分析、持仓风险识别。若做成单一「万能会话」，会与已落地的 L0 纯函数箱体闭环、option-bar 每桶至多一轮 trader、禁止 master 三叉等约束冲突，且 B/C 能力尚无数据面。需要一个可演进的总控，把 A+B+C 合成入口，但第一期只落地机会车道且行为对外等价。

## Proposal

采用**薄总控 + 三车道端口**（方案 1）。规格见 [docs/specs/2026-09-09-trader-director-design.md](../../../../docs/specs/2026-09-09-trader-director-design.md)。要点：

1. `TraderDirector` 只做时钟路由与全局 LLM 互斥；不编 prompt、不算 Greeks。
2. 三端口：`opportunity` / `risk` / `behavior`；调度顺序固定，opportunity 优先。
3. Phase 1：`OpportunityLane` = 现有 `decideBarAgent` + `OptionBarAgentHost`；Risk/Behavior 恒 `idle`。
4. 账本与推荐契约沿用 [option-bar-agent](../../../../docs/specs/2026-09-08-option-bar-agent.md)；不新开事件总线。
5. 接口与可测编排进 `kit-cn`；宿主接线留在 `client-ui-trading` node 半。

实现计划：[docs/specs/2026-09-09-trader-director-plan.md](../../../../docs/specs/2026-09-09-trader-director-plan.md)。

与 [option-bar-agent 提案](../feature/2026-09-08-option-bar-agent.md) 的关系：本记录是其**编排上层**，不取代 5 分钟 K 账本与闭集语义。

进度（2026-09-09 Task 2）：`OptionBarAgentHost` 已拆出 `buildContext` / `runOpportunity` / `maybeWriteReview` 与 `createOpportunityLane`；`afterTick` 仍走单车道 `opportunityDecide`（无 Director），lunch 桩与 close5 复盘行为不变。

进度（2026-09-09 Task 3）：`TraderDirectorHost` 已挂三车道（opportunity + idle risk/behavior）；`index.ts` tick 钩子改走 `director.afterTick`。Phase 1 仅 opportunity 会 `run`；lunch 写 session 桩，regular launch 后截断后续车道。Host 的 `afterTick` 仍保留作单车道兼容入口。

## Context & Efficiency Impact

Phase 1 不增加每桶会话次数（仍 regular 新桶至多 1 次）。Prompt 仍为 Layer 2 静态 `OPTION_BAR_AGENT_PROMPT`；动态仅 `bucketStart` / loop 摘要沉底 Layer 3。B/C no-op 无 Token 成本。后续 Risk 若开启抢占需另估会话争用。

## Alternatives considered

- **方案 2：能力注册表 + 共享事件账本**：长期更干净，但 Phase 1 就要定事件 schema 与双写，相对「A 等价落地」过重。败。
- **方案 3：host master 三子代理编排**：与 option-bar 已否决路径冲突（烧 Token、重叠难控）。败。
- **第一期直接做 Risk 或 Behavior**：时钟与工具链不如机会车道成熟；用户选定 A。败（本期不做）。

## Verification & Gates

- Director 单测：只触达 opportunity；B/C 恒 idle；`llmBusy` → overlap。
- 现有 option-bar / box / cycle 单测全绿。
- 验收：对外行为与现 option-bar 等价 + 代码可见三端口。

## Risks

- 过度抽象：若 Director 只是一层空壳却改坏 Host 时序——用「行为等价」验收与最小适配器缓解。
- 未来 Risk 抢占与 opportunity overlap 语义冲突——Phase 1 关闭抢占；另开 spec 再开。
- option-bar 提案仍为 proposed：Director 实现应与其 Host 同变更或紧随其后，避免双轨 afterTick。
