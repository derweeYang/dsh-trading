# Agent Note: trader preset 挂载撞 tradingCnMarketData / tradingCnOptions

Status: implemented

## Problem

`option-bar` 拉起 `agentPreset: trader` 时 preset 挂载失败：

1. `connector-tencent`：`service "tradingCnMarketData" has been registered at <dsh-trading-cn-connector-iquant>`
2. `connector-options`：`service "tradingCnOptions" has been registered at <Include>`

根因两处独立：

- **行情键**：cn connector group 内 iQuant / 腾讯（及东财等）都是候选行 `enabled: true`，东财/Tushare/AkShare 已有 `routeAllows`，但 iQuant 与腾讯 agent 面 `apply` **不 consult** `tradingMarketRouter`，两家同时 provide 同键。本机 `~/.dsh/settings.yaml` 写 `cn.provider: tencent` 时仍会先被 iQuant 占键再炸腾讯。
- **期权键**：host 面 `connector-options/dataplane` 已在 Include 根 provide `tradingCnOptions`；agent 组 isolate 只列了 `tradingCnMarketData`，期权行二次 provide 撞 Include。

## Decision

- `@dshtrading/connector-iquant` / `@dshtrading/connector-tencent` agent 面补 `routeAllows`（与 eastmoney/tushare/akshare 同纪律）：有 router 时仅 slug 匹配才 provide；无 router 回退旧语义。
- `packages/cn/assets/preset/cn-trader/agent.cordis.yml` 组行 isolate 增加 `tradingCnOptions` / `tradingCnOptionsTrade`。managed trader/master 等角色 preset 在下次 `@dshtrading/base/presets` 安装时重写。

## Alternatives considered

- **只改本机 trader preset（关 iQuant 行 / 手加 isolate）**：能救急，但源码仍缺路由互斥，换机或重装 preset 复发。败。
- **把 connector-options 移出 agent 组、只靠 host 键**：kit 在 agent 平面读服务；不 isolate 的跨平面 provide 与 dsh-agent-presets「修复 1」硬规则冲突。败。
- **无 router 时除默认源外全部 no-op**：破坏「无 router → enabled 语义」向后兼容（exchange-routing §2.2）。败。

## Consequences

- 用户改 `dshtrading.markets.cn.provider` 后须**新建会话**才切换 agent 面连接器（既有 restart 语义）。
- 已 stamp 的 managed preset 在宿主下次跑 role-presets 安装器时更新 isolate；若本机 stamp 被手改过会 skip，需恢复 managed 或手工补 isolate 三键。
