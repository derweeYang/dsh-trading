# Agent Note: 交易员总控（TraderDirector）薄编排

Status: implemented

## Problem

目标智能体需要同时具备：丰富期权知识、盘中机会捕捉、交易行为分析、持仓风险识别。若做成单一「万能会话」，会与已落地的 L0 纯函数箱体闭环、option-bar 每桶至多一轮 trader、禁止 master 三叉等约束冲突，且 B/C 能力尚无数据面。需要一个可演进的总控，把 A+B+C 合成入口，但第一期只落地机会车道且行为对外等价。

## Decision

采用**薄总控 + 三车道端口**（方案 1）。规格见 [docs/specs/2026-09-09-trader-director-design.md](../../../../docs/specs/2026-09-09-trader-director-design.md)。实现计划：[docs/specs/2026-09-09-trader-director-plan.md](../../../../docs/specs/2026-09-09-trader-director-plan.md)。

1. `TraderDirector` 只做时钟路由与全局 LLM 互斥；不编 prompt、不算 Greeks。纯函数在 `packages/kit-cn/src/trader-director.ts`（`routeTraderLanes` / `opportunityDecide` / `createIdleLane`）。
2. 三端口：`opportunity` / `risk` / `behavior`；调度顺序固定，opportunity 优先。`launch` 后本 tick 不再问后续车道；`run` 在 `launch` **与** `stub` 时都会调用，仅 `idle` 跳过。
3. Phase 1：`OpportunityLane` = `decideBarAgent` + `OptionBarAgentHost`（`createOpportunityLane`）。`TraderDirectorHost` 挂三车道；`packages/client-ui-trading/src/index.ts` tick 钩子走 `director.afterTick`。Risk/Behavior 为 `createIdleLane`，不启 LLM、不写盘。
4. 账本与推荐契约沿用 [option-bar-agent](../feature/2026-09-08-option-bar-agent.md)；不新开事件总线、不建 `data/trader/`。
5. `OptionBarAgentHost.afterTick` 仍保留作单车道兼容入口；生产路径是 Director。

本记录是 option-bar 的**编排上层**，不取代 5 分钟 K 账本与闭集语义。Phase 1 不增加每桶会话次数。Prompt 仍为 Layer 2 静态 `OPTION_BAR_AGENT_PROMPT`。

## Alternatives considered

- **方案 2：能力注册表 + 共享事件账本**：长期更干净，但 Phase 1 就要定事件 schema 与双写，相对「A 等价落地」过重。败。
- **方案 3：host master 三子代理编排**：与 option-bar 已否决路径冲突（烧 Token、重叠难控）。败。
- **第一期直接做 Risk 或 Behavior**：时钟与工具链不如机会车道成熟；用户选定 A。败（本期不做）。

## Consequences

- Phase 1 对外行为与单车道 option-bar 等价；B/C 恒 idle。Risk/Behavior 另开 spec 再做（设计 § 后续：持仓风险 JSON、推荐×score 归因）。
- Phase 1 关闭风险抢占。若日后 Risk 抢占，须重定义与 opportunity `overlap` 的互斥，不能暗改本记录。
- 过度抽象风险用「行为等价」单测兜住（lunch 桩、close5 复盘、`llmBusy` → overlap、launch 截断 B/C）。
