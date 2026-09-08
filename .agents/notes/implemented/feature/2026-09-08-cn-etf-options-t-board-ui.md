# Agent Note: CN ETF 期权 T 型报价板 UI（第一期前端，workbuddy）

Status: implemented

## Problem

第一期后端（`@dshtrading/connector-options` + `python/options` 网关 + 桥路由）已交
缝，桥契约写进 [docs/options-bridge.md](../../../../docs/options-bridge.md)，但
`packages/client-ui-trading/src/client/` 里没有 `OptionsStage`，`api.ts` 也没有
`/options/*` 端点——T 板是当时唯一「后端已交缝、前端未动」的缺口。按
[前后端分工](../process/2026-09-08-frontend-backend-agent-split.md)，界面半由
workbuddy 完成。

## Decision

**T 板做成 QuoteStage 的第六个页签「期权」，不新开中栏 StageView。** 判据：

1. **显隐**：`market === 'cn'` 且名册命中当前标的 6 位码（`510050.SH` → `510050`）。
   名册来自 `GET /options/underlyings`（连接器静态表，不打网关），取数失败即空数组
   → 页签整体不渲染（未装 connector-options 的用户看不到空页签，也不弹错误横幅）。
2. **到期月**：`GET /options/expiries`（本地算四季月）→ 胶囊条；网关未起也画得出，
   这是「网关不可用时 UI 仍有一半骨架」的关键。
3. **T 表**：`GET /options/chain`，仅「期权」页签激活且已选出到期月才拉，30s 对齐
   衍生品快照节奏；切标的/换月先回「加载中」并清掉旧链与旧错误码（评审 L2 同款纪律）。
4. **错误分诊**（按码，不一律吞成 null）：`TRADING_NETWORK` → 提示
   `uv run python -m dsh_options.gateway`；`TRADING_NO_DATA` → 空态；其余 → 不可用。
   为此 `api.ts` 新增 `OptionsOutcome<T>`（成功/失败带 code），与其余 fetch
   「失败返 null」的纪律不同——期权面必须区分「没装」「网关没起」「真无数据」。
5. **类型**从 `@dshtrading/api` 取（`OptionUnderlying` / `OptionExpiryCalendar` /
   `OptionChain`），client 不另造一份（契约纪律）。
6. **只读**：点击某档不切换图表标的，不挂下单入口（第一期不行权不下单）。

## Alternatives considered

- **注册成独立中栏视图**（`stage-views.ts` 的 `tradingStageViews`）：落选——期权是
  标的属性而非与行情并列的工作台；挂进富途式页签条与「衍生品/基本面」同族，切换
  成本与心智负担都更低。
- **页签常显 + 空态**：落选——深市 1599xx 与未注册标的会看到永远空白的页签，
  是噪音不是信息。
- **T 表同时回填 IV**（`GET /options/implied-vol`）：落选——链快照 IV 本就可选，
  先按缺省渲染「—」，IV 面板随第二期（ Greeks/策略）一并设计。
- **把 fetch 失败一律返 null**（沿用既有纪律）：落选——无法区分「网关没起」与
  「无行情」，UI 只能给一条无信息量的空态。

## Consequences

- 新增 `src/client/OptionsStage.tsx` + `options-stage.module.css`；`QuoteStage.tsx`
  增加期权 state 与三段轮询（名册 10min / 到期月 10min / 链 30s），`viewTab` 归一
  增加「非注册标的 → 回图表」。
- 词典新增 18 个 key（zh/en 各一份 + `contract.ts` 的 `MarketLocaleKey` 联合类型）；
  `node scripts/i18n-audit.mjs --check` 通过（5 ns / 935 keys）。
- 类型棘轮：client 半零新增错误；顺手修 `src/bridge.ts` 三处
  `exactOptionalPropertyTypes`（可选 `source` 显式传 undefined）——该文件属后端
  node 半，**需后端复核**。
- **后端债（2026-09-08 已清偿，见
  [cn-etf-options-readonly](../architecture/2026-09-08-cn-etf-options-readonly.md)）**：
  kit-cn 期权工具不再显式传 `undefined` 可选字段（棘轮回到基线）；「删光自选
  不复活种子」按当前种子表逐行删（含 `510050`）；profile 双副本 / `<Include>`
  撞车走 `link-trading-web-workspace.ps1`（全包 junction）+ refresh（含 `cordis`）。
- 新增渲染冒烟 `test/options-stage.smoke.test.tsx`（5 例全绿，jsdom 真挂载）：
  T 表行权价列与认购/认沽价、换月回调、三种错误码分诊、在途态、空合约态。
  这是本期唯一可在本机跑通的验证——宿主实机截图被环境问题阻塞（见下）。
- **实机验证（2026-09-08 11:40 通过）**：网关 `:8090 /health` = 200；宿主
  `:3081` token 鉴权 fence 正常（401 → cookie 握手后 API 200）；CDP
  （Chrome `ws://127.0.0.1:9222` page target `B9A100...`）端到端点穿验证通过：
  - 导航 token URL → 等「A股」tab → 点击 → 等上证50ETF 行 → 点击 → 等「期权」
    tab 显现（名册命中判据成立）→ 点击 → 等 T 表 `tbody tr` 渲染 → 抓证据 + 截图。
  - **证据**：tabs 含「期权」+ 4 个到期月页签（2609/2610/2612/2703）；pills
    `*2609`(激活) + 3 个非激活月；T 表头「认购 | 行权价 | 认沽」+ 列头完整；
    **14 行真实 akshare 数据**（行权价 2.65–3.60，购/沽两侧均有 last/changePct）；
    meta 快照时间=11:40:19、数据源=akshare；IV/volume 列显示「—」（当前
    akshare 链快照不含此字段，UI 缺省降级正确）。
  - 截图留证：`spikes/impl-cn-etf-options/tboard-cn.png`（暗色主题，T 板全貌含
    左侧自选、页签条、到期月胶囊、14 行 T 表、底部指数状态栏）。
  - CDP 驱动脚本：`spikes/impl-cn-etf-options/cdp-verify.mjs`（零依赖，
    Node 22 ESM，可复用为后续 UI 回归基线）。

本页只读分析，不构成投资建议。
