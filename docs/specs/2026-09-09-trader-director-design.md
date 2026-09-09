# Spec：交易员总控（TraderDirector）— 薄编排 + 三车道端口

- 日期：2026-09-09
- 状态：proposed（计划已就绪 → [plan](./2026-09-09-trader-director-plan.md)）
- 决策记录：[`.agents/notes/proposed/architecture/2026-09-09-trader-director.md`](../../.agents/notes/proposed/architecture/2026-09-09-trader-director.md)
- 前置：[ETF 期权 5 分钟 K 智能体](./2026-09-08-option-bar-agent.md)
- 分工：Cursor / Claude 做 Director / Lane 契约与 node 半接线；workbuddy 不改 `packages/client-ui-*/src/client/**`

## 1. 产品目标

构建「交易员总控」编排层，把三类能力合成同一入口，但分车道演进：

| 车道 | 能力 | 本期 |
|---|---|---|
| A `opportunity` | 盘中捕捉交易机会 | **落地**（包装现有 option-bar） |
| B `risk` | 识别持仓风险 | 端口占位，恒 idle |
| C `behavior` | 分析交易行为 / 归因 | 端口占位，恒 idle |

总控是路由器与互斥闸，不是「万能聊天模型」。数字仍来自确定性工具与 L0 纯函数；LLM 只在车道允许时叙事与裁决。不构成投资建议；不下单。

## 2. 架构

```text
宿主 30s tick
    → optionCycleTick（L0：箱体/打分，纯函数，不变）
    → TraderDirector.afterTick(loop, now)
           ├─ OpportunityLane   ← Phase 1 = 现 OptionBarAgentHost
           ├─ RiskLane          ← no-op（契约占位）
           └─ BehaviorLane      ← no-op（契约占位）
```

### 2.1 总控职责

- 接收已算好的 `OptionCycleLoop` + 墙钟
- 全局 LLM 互斥：同一时刻至多一路会话
- 按固定顺序询问各 Lane 的 `decide`；对 `launch` 与 `stub` 调 `run`（机会写桩或启会话）；`idle` 不调；`launch` 后截断后续车道
- 不编 prompt、不算 Greeks、不改箱体公式

### 2.2 明确不做（全期铁律 + Phase 1 边界）

- 不启 master 三叉（`researcher_subagent` / `trader_subagent` / `risk_reviewer_subagent`）
- 不自动 `POST /options/order` / 实盘
- 不新建事件总线，不新增 `data/trader/` 账本
- Phase 1 不实现 B/C 的 LLM、落盘或抢占

## 3. Lane 接口与时钟

### 3.1 共享输入

```ts
interface DirectorTickContext {
  ticked: boolean
  loop: OptionCycleLoop
  nowMs: number
  session: OptionIntradaySession  // open15 | regular | lunch | close5 | closed
  llmBusy: boolean
}
```

### 3.2 端口

```ts
type LaneId = 'opportunity' | 'risk' | 'behavior'
type LaneAction = 'idle' | 'launch' | 'stub'

interface LaneDecision {
  readonly action: LaneAction
  readonly skipReason?: OptionBarSkipReason  // opportunity 复用；B/C 未来可扩展
}

interface TraderLane {
  readonly id: LaneId
  decide(ctx: DirectorTickContext): LaneDecision
  run?(ctx: DirectorTickContext): Promise<void>
}
```

### 3.3 各车道时钟

| Lane | 时钟 | Phase 1 |
|---|---|---|
| opportunity | `ticked && session === 'regular'` → launch；非 regular 新桶 → stub；`llmBusy` → overlap stub | **实现**：委托 `decideBarAgent` + 现 Host `run` |
| risk | 拟：持仓非空且（Greeks/保证金阈值或临期窗口） | `decide` 恒 `idle`；不注册 `run` |
| behavior | 拟：首次进入 `close5`/`closed` 的归因会话；与确定性 `reviews/*.md` **正交** | 同上 |

### 3.4 调度顺序（固定）

1. `opportunity.decide` → 对 `launch`/`stub` 调 `run`（与 §2.1 一致）；若 `launch`，**本 tick 不再**调 B/C 的 `decide`  
2. 否则 `risk.decide`（Phase 1 恒 idle）  
3. 否则 `behavior.decide`（Phase 1 恒 idle）  
4. 确定性盘后 `foldDailyReview` 仍挂在 opportunity 宿主副作用（与现行为一致），**不**挪给 behavior

### 3.5 互斥与抢占

- 全局 `llmBusy`：机会会话未结束 → 本桶机会写 `overlap` 桩（沿用 option-bar 语义）
- 契约预留「风险紧急可抢占」；Phase 1 **关闭**抢占开关（恒 false）

## 4. 数据流

```text
L0 tick → cycles/*.jsonl（不变）
       → Director
            → OpportunityLane
                 → launch: trader 会话 → cn_put_option_bar_recommendation
                 → stub: session | calibrated | overlap | launch_failed
            → Risk / Behavior: idle（无写盘）
       → close5 首次：reviews/*.md（确定性，无 LLM）
```

- 路径、推荐 JSON、`opportunity` 闭集、模板必须 ∈ `candidates`：全部沿用 [2026-09-08-option-bar-agent](./2026-09-08-option-bar-agent.md)，总控不另开 schema。
- Prompt / skill：`OPTION_BAR_AGENT_PROMPT` + `option-intraday-workflow` + `knowledge_search`（标签 `ETF期权`）不变。

## 5. 包落点

| 单元 | 位置 | 理由 |
|---|---|---|
| `TraderDirector` 编排 + no-op Lane + 可测 `decide` 环 | `packages/kit-cn/src/trader-director.ts` | 纯逻辑单测，无宿主 |
| `OpportunityLane` 适配现 Host | `packages/client-ui-trading/src/option-bar-agent.ts`（抽接口或薄包装） | 已有 `TasksRunner.launch` |
| 宿主接线 | `client-ui-trading` node 半：原 `afterTick` 改走 Director | 行为对外等价 |

不改 `packages/client-ui-*/src/client/**`。

## 6. 错误处理

| 情况 | 行为 |
|---|---|
| 目录不可写 | 打日志；L0 内存继续；不启 LLM |
| 会话启动失败 | 桩 `launch_failed`，本桶不重试 |
| 工具失败（链/策略） | 会话内可 `no_edge`；不崩 tick |
| 上一轮未结束 | `overlap` 桩，不取消上一轮 |
| Risk/Behavior 被调用 | no-op；单测断言 `decide` 恒 `idle` |

## 7. 测试

在现有 `option-bar-ledger` / Host 单测之上增加：

- Director：regular 新桶只触达 opportunity；B/C 不执行 `run`
- `llmBusy === true` → opportunity `overlap`，且不调用其他 lane 的 `run`
- Risk/Behavior 任意 `session` → `idle`
- 现有 `decideBarAgent` / session 边界 / 复盘幂等保持全绿

## 8. Phase 1 验收

1. 对外行为与现 option-bar **等价**（时段、每桶至多一轮、桩语义、复盘 md）
2. 代码存在 `TraderDirector` + 三 Lane 端口；B/C 为显式 no-op
3. 无自动下单；无 master 三叉
4. 本文档与 Agent Note 写清 B/C 拟时钟与「第二/三期再实现」边界

## 9. 后续期（非本期范围，仅占位）

- **Phase 2 RiskLane**：持仓快照输入、保证金/临期/失效条件阈值、可选抢占开关；产出风险告警 JSON（schema 另开 spec）
- **Phase 3 BehaviorLane**：基于 `recommendations` × 下一桶 `score` 与人工否决的归因；可回流制度卡片（须人确认）；**不**替代确定性 `reviews/*.md`

## 10. 否决路径（已定）

- 右侧栏 cron 扫箱体 / 打分 — 与 option-cycle-loop 冲突
- host `master` 三子代理编排 — Token 与重叠失控
- Phase 1 上事件总线 + `data/trader/events.jsonl` — 相对 A 过重（方案 2，已否）
