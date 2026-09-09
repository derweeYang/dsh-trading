# Agent Note: typecheck 棘轮后端回归清零（handoff #7）

Status: implemented

## Problem

前端 WB-0/1/2/3/4/6 落地后，`node scripts/typecheck-gate.mjs` 报 5 个后端拥有配置超基线（`client-ui-trading` host/node +3/+3、`connector-iquant` +3、`connector-options` +1、`kit-cn` 27>23），阻塞门禁绿与后续 WB-5 冒烟。根因是 `exactOptionalPropertyTypes` / 未用形参 / `Disposable` 形状与期权闭环新增代码叠在一起，而非前端 `src/client/**`。

## Decision

按 `docs/backend-handoff-2026-09-09.md` #7 口径修调用方，不抬高基线、不改 `@dshtrading/api` 可选字段契约：

- `client-ui-trading` node 半桥：`openSessionId` 改为显式 `string | undefined`；`applyTicker` 死参前缀 `_`。
- `connector-iquant`：`subscribeTicker` 返回 `{ dispose }`；`gatewayUrl` 缺省时省略键；`Ticker.timestamp` 必填回落 `Date.now()`。
- `connector-options`：未用 `orderId` → `_orderId`。
- `kit-cn`：清掉本次 +4 回归（locator 经 `fileURLToPath`、候选数组断言、news 可选链、账本/闭环 optional 构造、`horizonMin` 展开顺序）；fundamentals 存量 21 仍基线豁免。

门禁通过后 `--update` 把总错误从 255 下调到 239（`kit-cn` 23→21）。

同变更一并 reconcile 的 trader 面撞键修法见 [trader-preset-connector-service-collision](./2026-09-09-trader-preset-connector-service-collision.md)；trading-web 宿主侧 #8 仍走 `link-trading-web-workspace.ps1` + `refresh-trading-web-profile.ps1`（见 `docs/windows-local-dev.md`）。

## Alternatives considered

- **在 api 把可选字段写成 `field?: T | undefined` 一次放宽**：会扩散契约语义，掩盖调用方显式传 `undefined` 的坏习惯；本轮只清回归，败。
- **`--force` 抬高基线**：掩盖债务，与棘轮门禁纪律冲突，败。
- **只修 client-ui-trading、把 connector/kit 留给后继 PR**：门禁仍红，WB-5 仍被挡，败。

## Consequences

- 棘轮全绿；`kit-cn` fundamentals 的 `exactOptionalPropertyTypes` 存量仍在，后续单独还债。
- trading-web 本机已重挂全部 `@dshtrading/*` junction；宿主可出 token URL，前端可跑 WB-5。
- 用户改 `dshtrading.markets.cn.provider` 后须新建会话才切换 agent 面连接器（既有 restart 语义，见撞键 note）。
