# Agent Note: 「打开设置」改用稳定通道（前端 P0-2）

Status: implemented

## Problem

2026-09-12 全页面操作流程复盘的 P0-2：设置入口是本次复盘里**唯一会做错事**的交互。

`src/client/index.ts` 的 `openSettings()` 靠**猜宿主 DOM** 打开设置：

```ts
const selectors = [
  "button[title*='设置'], button[title*='Settings'], …",
  "div:has(> [data-shell-overlay]) > div:nth-child(1) [aria-haspopup='dialog']",
  "[aria-haspopup='dialog']",
]
```

根因（后端 B2 已确认）：宿主 `@deepseek-ai/dsh` **没有**向插件暴露「打开设置」的服务或事件。
实测后果不只是「有时点不开」——末位选择器 `[aria-haspopup='dialog']` 会在整文档里抓第一个
弹窗触发器，**误折叠侧栏**（比不响应更糟：用户点设置，界面塌了）。

后端 B2 已落地稳定桥面：

- `POST /dshtrading/api/shell/open-settings`：node 半探宿主 `settings.open` → `ui.openSettings`，
  都没有则 **501 + `SETTINGS_OPEN_UNSUPPORTED`**（明示「这是上游能力缺口」而非静默失败）；
- `GET /dshtrading/api/shell/settings`：能力自述（`upstreamGap` 等）；
- `OPEN_SETTINGS_EVENT = 'dshtrading:open-settings'`：跨半登记的契约事件名（供浏览器半派发）。

## Decision

**1. `api.ts` 新增 `OPEN_SETTINGS_EVENT` + `OpenSettingsOutcome` + `requestOpenSettings()`。**

- 三态结果：`{ok:true, via}` / `{ok:false, reason:'unsupported'}` / `{ok:false, reason:'unreachable'}`。
  两种失败对调用方都是「退回 DOM」，但必须分得清——`unsupported` 是宿主缺 API（预期），
  `unreachable` 是桥坏了/旧 node 半/404。
- 判定：`501 + SETTINGS_OPEN_UNSUPPORTED` → `unsupported`；其余非 2xx 与非 `invoked:true` → `unreachable`。
  **2xx 但 `invoked` 非 true 不能当成功吞掉**（协议异常，单测钉死）。
- **超时护栏 `AbortSignal.timeout(1200)`**：宿主服务调用是本地 HTTP 往返（正常 <1ms），
  但桥整体挂起时不能把「点设置」永久挂住——改造前是同步点 DOM，加一次 await 就有了新挂起面。

**2. 新增 `src/client/open-settings.ts`，把通道顺序做成可测单元。**

```
宿主服务 → 契约 window 事件 → DOM 触发器（含全失败 toast）
```

- 编排只依赖注入的副作用函数（不碰 `document`/`window`），故纯逻辑在 node 环境下即可钉死顺序；
- **前一条成功即立即返回**：顺序倒过来（先点 DOM 再问宿主）会出现「宿主开了设置、DOM 又点一次」
  的双开/误动作，这是本模块要防的回归；
- 事件声明为 `cancelable`，有监听者便 `preventDefault` → `dispatchEvent` 返 `false` 即「已被接管」，
  此时不再点 DOM。**契约是「谁监听谁处理」，不用约定回调面。**
- 两条稳定通道都不可用时 `console.info` 打出 `reason`/`code` 再落 DOM——否则日后只能从
  「点了没反应」倒推是哪一种缺口。

**3. 事件名跨半不 import，靠测试钉死。**

client 半**零跨半 import**（会把 node 半模块打进浏览器 bundle，且边界上禁止），故
`OPEN_SETTINGS_EVENT` 在 `api.ts` 里重新声明字面量；漂移由测试断言两边相等兜底
（测试不参与打包，可自由 import node 半）。

**4. DOM 触发器保留为末位兜底，不删。**

上游仍缺 API 的今天，DOM 是**唯一真实生效**的路径；删掉它等于把设置入口变成 toast。
它的位置从「首选」降为「末位」，其脆弱性（误折叠侧栏）从主路径上摘下来了。

## Alternatives considered

- **直接删 DOM 链、只走桥**：今天 501 是常态 → 设置按钮变成只会弹 toast。不取。
- **只走事件、不调桥**：事件今天**全仓无监听者**（grep 证实），派发是 no-op；且宿主缺 API 是
  确定事实，桥至少把「缺口」变成一条明确回执。三条通道并存才是当下唯一能同时做到
  「今天能用」与「宿主补 API 后自动升级」的组合。
- **从 node 半 import 事件名常量**：违反 client 半零跨半 import 约定，且会把 node 半代码
  拖进浏览器 bundle。不取（改用测试断言兜底）。
- **不加超时、直接 await 桥**：把「同步必达」的交互变成「可能挂起」的交互，是净回归。不取。
- **桥 2xx 但 `invoked` 非 true 时乐观当成功**：会静默吞掉协议异常（设置点了没反应且无痕迹）。不取。

## Consequences

- 设置入口的**首选路径**从「猜 DOM」变成「问宿主」；宿主将来补上 `settings.open` /
  `ui.openSettings` 即自动生效，无需再改前端。
- 误折叠侧栏的路径被移出主链路（DOM 链只在两条稳定通道都不可用时才走）。
- 新增文件 `src/client/open-settings.ts`；`api.ts` 新增一个导出区块；`index.ts` 的
  `openSettings` 拆成 `openSettingsByDom`（兜底）+ `openSettings`（编排调用）。
- 回归护栏 `test/open-settings.test.ts`（10 条，node 环境）：
  跨半事件名一致性；三态解析（200/501/404/2xx-协议异常/请求抛错）；通道顺序三条
  （host 成功不派发事件也不点 DOM / event 接管不点 DOM / 两条都不行才点 DOM）＋缺口原因留痕。
- 门禁账：包构建绿；`npx vitest run` **493/493（56 文件）**绿；i18n OK（**1178 zh keys**，本变更未新增键）。
