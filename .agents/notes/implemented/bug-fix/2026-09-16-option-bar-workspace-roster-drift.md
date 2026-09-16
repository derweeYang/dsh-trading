# Agent Note: 盘中执行器工作区不再随名册活跃顺序漂移（client-ui-trading）

Status: implemented

## Problem

5 分钟桶 trader 会话的 workspaceId 取 `registry.list()[0]`（`packages/client-ui-trading/src/index.ts` 装配处），而宿主 workspaceRegistry 按**最近活跃**排序。2026-09-15 实证：一旦别的工作区（如 `D:\temp`）更活跃，盘中 trader 会话会被**静默建到别的工作区**——沙箱（workspace-write 范围）、工具面、模型配置（deepseek-official/v4-flash 绑在 deepseek-harness 工作区）全部跟着变，是「零成交」式静默故障的温床。当天 11:15 / 11:20 两桶连续 launch 后 1 步即 error、11:22 后再无 launch，时间与用户切换工作系统衔接。

## Decision

- 新增 `resolveOptionBarWorkspaceId(registry, log?)`（`option-bar-agent.ts` 导出）：
  按 **path / title / name** 子串匹配（大小写不敏感）钉住 `deepseek-harness`；
  匹配不到回退名册第一个并 `console.warn` 告警；空名册返回 undefined（回退路径保持既有行为）。
  结构面 `WorkspaceDirectoryLike.list()` 只暴露 `{id, name?, title?}`；path 为可选鸭子字段（宿主实体实际有），title 默认 `basename(path)` 必填——title 匹配已在宿主 `workspace.json` 实证可行（`"title": "deepseek-harness"`）。
- 装配处（`index.ts`）改为调用上述解析器，回退告警走 `[dsh-trading/option-bar]` 前缀。

## Alternatives considered

- **显式配置 workspaceId（环境变量/设置项）**：最彻底，但引入新配置面，还要跟着宿主工作区生命周期同步；按标识匹配零配置即可钉住。
- **匹配不到直接 fail-closed 抛错**：比回退 `list()[0]` 更激进，宿主工作区一旦改名会令盘中扫描整体停摆；回退+告警行为不差于改前，可观测且可恢复。
- **给 `WorkspaceDirectoryLike` 强制加 path 字段**：宿主 0.1.2-alpha.2 描述符表是否真返回 path 未实证；可选鸭子字段爆炸半径更小（与 runner.ts 模块头注的运行时鸭子解析策略一致）。

## Consequences

门禁账（worktree `fix/option-bar-workspace`，基底 b340458）：

- `pnpm vitest run test/option-bar-agent.test.ts`：**16/16**（既有 12 + 新增 4：path 匹配 / title 大小写不敏感 / 回退+告警 / 空名册与名册缺失不告警）。
- `pnpm vitest run`（整包）：**63 文件 / 562 测试全绿**。
- `node scripts/typecheck-gate.mjs`：总 261 错、6 个 config 超基线——与改动前（stash 对比）**逐 config 完全相同**，即 0 新增类型错误；超额为已知基底存量（基线文件过时，维持「分支口径=与基底持平」）。

未验证（留给真实盘）：宿主 workspaceRegistry 实际返回面里 path/title 的取值——下个交易日盘中抽查宿主日志无 `[dsh-trading/option-bar] ... falling back` 告警、且 sessions 台账新会话仍挂 deepseek-harness 工作区，即钉住生效。
