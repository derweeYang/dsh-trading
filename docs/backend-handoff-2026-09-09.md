# 后端待办交接（2026-09-09）

> 起草人：workbuddy（前端）｜交接对象：后端（Cursor / Claude）
> 背景：WB-0/1/2/3/4/6 前端链路已落地并 commit（`7e9d1c2` `6d4bd9c` `3f12e52`），
> 前端 `tsconfig.client.json` 维持基线 52 错误、342 测试全绿、i18n 1025 键通过。
> 本文件只登记**后端范围**的剩余债务，**不执行**——按 AGENTS.md 分工，
> 界面 / `src/client/**` 之外的全部代码（桥、连接器、kit、python、client-ui 的 node 半桥）归后端。

---

## 0. 当前门禁状态（权威来源：`node scripts/typecheck-gate.mjs`）

```
[typecheck-gate] tsc --noEmit 完成：43 个 tsconfig，总错误数 255（基线总错误数 255）
[typecheck-gate] ✗ 棘轮门禁失败：
  ↑ packages/client-ui-trading/tsconfig.host.json：3 > 基线 0（+3）
  ↑ packages/client-ui-trading/tsconfig.json：3 > 基线 0（+3）
  ↑ packages/connector-iquant/tsconfig.json：3 > 基线 0（+3）
  ↑ packages/connector-options/tsconfig.json：1 > 基线 0（+1）
  ↑ packages/kit-cn/tsconfig.json：27 > 基线 23（+4）
```

**关键判断**：5 个超基线配置全部是**后端拥有**的配置——

- `client-ui-trading/tsconfig.{host,json}` 对应的是 `src/option-bar-agent.ts` / `src/option-overview.ts`（node 半桥，非 `src/client/**`）；
- `connector-iquant` / `connector-options` / `kit-cn` 整包归后端。

前端 `src/client/**`（`tsconfig.client.json`，基线 52）未被触碰，WB-4 未引入任何新前端类型错误。
即：**门禁变红是后端近期改动引入的回归，与前端工作无关。**

> 旁证：`git status` 显示后端未提交改动
> `packages/connector-iquant/src/index.ts`、`packages/connector-tencent/src/{dataplane,index}.ts`、
> `packages/cn/assets/preset/cn-trader/agent.cordis.yml` 及两个新增 `route-allows.test.ts`——
> 这批改动与下述回归高度相关，后端收尾时应一并 reconcile。

---

## 1. 任务 #7 — typecheck 棘轮回归清零（门禁红 → 绿）

修复口径：错误数只许降；清完跑 `node scripts/typecheck-gate.mjs --update` 下调基线。
**不要**用 `--force` 抬高基线掩盖回归。

### 1a. `packages/client-ui-trading`（node 半桥，3 处源错误，同时炸 host + node 两个配置）

| 文件:行 | 错误码 | 根因 | 修法 |
|---|---|---|---|
| `src/option-bar-agent.ts:96` | TS2412 | `this.openSessionId = undefined`；字段声明为 `openSessionId?: string`，`exactOptionalPropertyTypes` 下显式赋 `undefined` 非法 | 字段改为 `openSessionId: string \| undefined = undefined`（显式含 undefined，不再用 `?`） |
| `src/option-bar-agent.ts:121` | TS2412 | `settle()` 里同一字段再次 `= undefined` | 同上，字段类型改完即消 |
| `src/option-overview.ts:164` | TS6133 | `applyTicker(metrics: ReturnType<...>, ticker?: Ticker)` 的 `metrics` 形参未使用 | 参数改名 `_metrics`，或确认是否漏用（`buildOverviewMetrics` 产出未接）——若确属死参直接删 / 前缀 `_` |

> 这 3 处源错误在 `tsconfig.json`（node）与 `tsconfig.host.json`（host）各计一次，
> 故门禁显示 +3 +3（实为 3 个源修复，可同时清掉两个配置的红）。

### 1b. `packages/connector-iquant`（+3）

| 文件:行 | 错误码 | 根因 | 修法 |
|---|---|---|---|
| `src/index.ts:56` | TS2322 | `() => void` 赋给 `Disposable`（疑似 `using` 注册清理函数返回了裸函数而非 Disposable 对象） | 改成返回实现 `Disposable` 的对象，或 `Symbol.dispose` 方法签名对齐 `[Symbol.dispose](): void` |
| `src/index.ts:73` | TS2379 | `{ gatewayUrl: string \| undefined }` 传给 `IquantRestOptions`，`exactOptionalPropertyTypes` 下显式 `undefined` 非法 | 当 `gatewayUrl` 为 `undefined` 时**省略该键**，或把类型改 `gatewayUrl?: string \| undefined` 仍须避免显式传 `undefined` |
| `src/rest.ts:107` | TS2375 | 构造 `Ticker` 时把若干可选字段显式设为 `undefined` | 省略这些键（用展开/条件插入），不要显式赋 `undefined` |

### 1c. `packages/connector-options`（+1）

| 文件:行 | 错误码 | 根因 | 修法 |
|---|---|---|---|
| `src/index.ts:184` | TS6133 | `orderId` 声明但未使用 | 若确属死参前缀 `_orderId` 或删；若本应回传则补使用点 |

### 1d. `packages/kit-cn`（当前 27，基线 23，+4）

错误谱（同一批 `exactOptionalPropertyTypes` 回归，集中在 `src/fundamentals.ts` 的 `| undefined` 字段赋值，
外加 `src/index.ts:158` TS2769、`src/intraday-box.ts:284` TS2322、`src/news.ts:367` TS2532、
`src/option-bar-ledger.ts:188` TS2375、`src/option-cycles.ts:204` TS2322、`src/options-tools.ts:545` TS2783）：

- 主因：`@dshtrading/api` 近期收紧可选字段（或 `exactOptionalPropertyTypes` 透传），
  `kit-cn` 大量 `StockFundamentals` / `CnFundamentalsResult` / `CompanyProfile` / `ForecastSummary` 等
  字面量把 `| undefined` 字段显式赋值 → 触发 TS2375/2379/2412。
- 修法二选一（建议与 api 包作者确认口径后统一）：
  1. **源头放宽**：在 `@dshtrading/api` 把这些可选字段类型写成 `field?: T \| undefined`（显式含 undefined），一次修好所有调用方；
  2. **调用方规避**：`kit-cn` 构造字面量时省略 `undefined` 字段（条件展开），不改 api 契约。

**判定标准**：把 kit-cn 跑回 **≤ 23**（回到基线）即达标，无需清零全部 27——
其中 23 个是历史存量（已基线豁免），4 个是本次新引入的回归，必须消除。

---

## 2. 任务 #8 — trading-web 宿主 dataplane 重复注册（曾阻塞 WB-5；已清偿）

> 权威出处：`docs/windows-local-dev.md`（「启动 / 重挂」段落，issue #81 同族）
> **状态（2026-09-09）**：已清。宿主可 boot；WB-5 真机冒烟见 §5。

### 症状
`start-trading-web.bat` 起宿主报：
```
service "tradingCnMarketData" has been registered at <Include>
```
各市场同症（与 issue #81 同族）。另一条同文案：六家 CN dataplane 在
`tradingMarketDataRegistry` 尚未 provide 时走无注册表回退，抢占 Include 根键；
dataplane 现已 `inject` 注册表，根键被占则跳过。

### 根因
profile 里仍残留 npm 上 `@dshtrading/cn@^0.1.4` 连接器**实拷**，与仓库 `0.1.5` 各 apply 一次，
两个 `tradingCnMarketData` provide 撞键。只 junction `api` / `cn` 不够——必须把**全部**
`@dshtrading/*` junction 进 profile。

### 修复步骤（已验证可用，见 windows-local-dev.md）
```powershell
# 1) 停 3081（勿跑 dsh plugin install）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\link-trading-web-workspace.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-trading-web-profile.ps1
# 2) 起重宿主
.\start-trading-web.bat
```
- 勿跑无 `--dsh` 的 `sync-profile-overrides.mjs`（缺本地宿主会回落 macOS `/opt/homebrew`）。
- 实例运行中**禁止** `dsh plugin install`（见 shadow-copy note）。

### 当时为什么阻塞 WB-5
WB-5 是**真机冒烟**：总览 9 行 / T-5 色深 / 排序 / 扫描预填 / T 板箱体条 / `no_trade` 空态 /
点进 T 板再返回。这些都必须宿主真正 boot 才能验。宿主卡在 dataplane 撞键 → 整页起不来 → WB-5 无法收尾。
#8 清掉后前端已跑完验收清单（§5）。

---

## 3. 后端收尾验收清单（门禁红 → 全绿）

> 状态（2026-09-09 后端收尾）：下列项已完成。门禁 `--update` 后总错误 239；
> 宿主本机已 boot（无撞键，token URL 可用）。**WB-5 真机冒烟已由前端完成（§5）**。
> 决策记录：[typecheck handoff](../.agents/notes/implemented/bug-fix/2026-09-09-typecheck-ratchet-backend-handoff.md)、
> [trader preset 撞键](../.agents/notes/implemented/bug-fix/2026-09-09-trader-preset-connector-service-collision.md)。

- [x] **#7a** `client-ui-trading` node 半桥 3 源错误修完（`option-bar-agent.ts:96,121` + `option-overview.ts:164`），
      `tsconfig.host.json` 与 `tsconfig.json` 均回到 0。
- [x] **#7b** `connector-iquant` 3 错误清（index.ts:56/73 + rest.ts:107）。
- [x] **#7c** `connector-options` 1 错误清（index.ts:184）。
- [x] **#7d** `kit-cn` 回到 ≤ 23（消除本次 +4 回归；现 21）。
- [x] 跑 `node scripts/typecheck-gate.mjs` → **全绿**（无 `↑` 行）；`--update` 下调基线至 239。
- [x] **#8** trading-web 宿主可 boot（无 `tradingCnMarketData has been registered`）；已出 token URL。
- [x] reconcile 当前未提交的后端改动（connector-iquant / connector-tencent / cn preset 及新 test），确认门禁与宿主互不拖累。
- [x] 前端跑 **WB-5 真机冒烟**（总览 9 行 / T-5 / 排序 / 扫描预填 / T 板箱体条 / no_trade / 进出 T 板）→ §5 全绿。

---

## 4. 附录：期权总览页面「推荐策略」事实核对（给领航员）

**问**：期权总览页面是不是设计了「能看到每个 ETF 标的推荐交易策略」？

**答：否。** `packages/client-ui-trading/src/client/OptionsOverview.tsx`（WB-1 期权透镜落地页）的
表格列为：`name / last / change / return5d / volumeRatio / strength / iv / heldQty / optionQty / T-5`，
外加每行 `divergence` 标签（`weak_rally` / `accelerating_sell`）。

它**不**含「推荐策略」列。策略只在**按需**生成后浮现，两条路径：
1. 总览顶栏「扫描标的」/ 行内「AI 扫描」→ `onScanAll` / `onScanRow` **预填 composer** 触发 agent，
   推荐结果以 toolview 卡片呈现（被动卡片，无回调进 T 板）；
2. 进 T 板后 WB-4 的 `StrategyPreview` 自包含面板，直连 `POST /options/strategy`
   （`fetchOptionStrategy`），生成后可「装入下单面板」回填（preview 态，不下单）。

即：总览页是**量化信号 + 触发入口**的落地页，不是策略推荐表。若领航员想要总览页直接列「推荐策略」列，
属**新需求**（需在 `OptionOverviewRow` 增加策略字段并由桥侧聚合，或总览页内联调 `cn_get_option_strategy`），
请拍板后由后端扩 `@dshtrading/api` 契约 + 桥，前端再加列。

---

## 5. WB-5 真机冒烟结果（2026-09-09 14:30，前端执行）

> 后端清偿 #7+#8 后，前端用系统 Chrome (153) + playwright-core 1.63.0 驱动宿主
> `http://127.0.0.1:3081/?token=...` 完成 WB-5 全链路冒烟。
> **结论：WB-5 ✅ 全部通过**（期权网关未启动属独立进程依赖，不阻塞 UI 冒烟）。

### 冒烟清单逐项

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 宿主启动 + 进入期权透镜 | ✅ | token URL → 303 → DeepSeek Harness → 点「期权」tab → `[data-dshtrading-options-overview]` 存在 |
| 2 | 总览 9 行 / T-5 色深 / 排序 | ✅ | 9 只 ETF（159915/159901/159919/510300/510500/159922/510050/588080/588000）；每行 T-5 五格 %（color-mix 涨跌 token）；排序 tab「5 日强弱 / IV 分位 / 持仓优先」；divergence 标签「价升量缩」多行可见 |
| 3 | 扫描预填（onScanAll） | ✅ | 点「扫描标的」→ composer（contenteditable DIV）被 `scanAllPrompt` 全文预填（9 标的 5d 涨跌 + agent 工作流指令），不下单 |
| 4 | 进 T 板：箱体条 + 状态 | ✅ | 点首行（159915）→ OptionsStage 渲染；box bar 显示「5 分钟箱体 / 当前不出箱 / K 线不足」（降级态）；期权链行权价 2609/2610/2612/2703 可见；「策略预览」按钮（WB-4）存在 |
| 5 | 返回总览 | ✅ | 「返回总览」按钮点击后 overview 重新 visible=true |

### 环境备注

- **浏览器**：系统 Chrome 153（headless），playwright-core 1.63.0（本地 npm install，agent-browser 自带 Chromium 因 Google CDN 被墙下载失败，改用系统 Chrome 绕过）
- **期权网关**：未启动（`start-options-gateway.bat` 未跑），IV 列全「—」，箱体降级为「K 线不足」。启动网关后 IV 分位和精确箱体数据应填充
- **截图存档**：`C:/Users/ydw/AppData/Local/Temp/wb5/{01~05}.png`

### WB-0~6 全部状态

| 工单 | 状态 | 验证方式 |
|---|---|---|
| WB-0 api.ts fetch 函数 | ✅ committed | 单测 8 例 |
| WB-1 OptionsOverview 总览 | ✅ + **WB-5 真机通过** | 9 行/T-5/排序/divergence |
| WB-2 扫描预填 fillComposer | ✅ + **WB-5 真机通过** | composer 全文预填 |
| WB-3 T 板箱体条 | ✅ + **WB-5 真机通过** | box bar 渲染、降级态正确 |
| WB-4 策略预览 StrategyPreview | ✅ committed | T 板内「策略预览」按钮可见 |
| WB-5 真机冒烟 | ✅ **本轮完成** | 5/5 项全绿 |
| WB-6 OptionsCycleLoop 闭环 | ✅ committed | 单测 10 例 |
| WB-9 总览重构（叠图 + 机会卡） | ✅ 前端完成 | 374 单测 / 棘轮 234 |

---

## 6. 任务 #9 — 把账本已有的 `logic` / `playbook` 投影进总览行（后端范围）

> 状态（2026-09-09）：**已清偿**。`OptionOverviewStrategy` 已加可选 `logic?` / `playbook?`，
> `overviewStrategyOf` 两分支条件插入（空串不写键）。桥路由无需改。
> 前端可删 `StrategyExtras`，改为直读 `row.strategy.logic` / `.playbook`。

### 背景

领航员要求「每个机会要有 AI 解读 + 操作计划」。核查发现**这两个字段后端早就写了**：

- `OptionBarRecommendation.logic` / `.playbook`（`packages/api/src/index.ts:621-634`），
  由 `option-bar-agent` 每桶生成后落 `data/options/recommendations/*.jsonl`。

但 `overviewStrategyOf()`（`packages/kit-cn/src/option-bar-ledger.ts:358`）投影成
`OptionOverviewStrategy`（`packages/api/src/index.ts:471`）时**只留了 `edge`，
把 `logic` 和 `playbook` 丢掉了**。所以这不是「新建 LLM 能力」，而是补投影。

### 改动建议（纯增量、无破坏性）

1. `packages/api/src/index.ts:471` 的 `OptionOverviewStrategy` 加两个可选字段：
   ```ts
   /** 账本解读原文（AI 生成）；缺席时前端回落规则解读。 */
   readonly logic?: string
   /** 账本操作计划原文（AI 生成）；缺席时前端给流程骨架。 */
   readonly playbook?: string
   ```
2. `packages/kit-cn/src/option-bar-ledger.ts:overviewStrategyOf`（358）两个 return 分支
   都带上这两个键（沿用现有 `invalidIf` 的条件插入写法，空串不写键）。
3. 无需改桥路由：`/options/overview` 直接透传整个 row。

### 前端现状（供对照）

- `src/client/option-insight.ts` 的 `strategyExtras()` 已按宽容类型预读这两个键，
  字段到位即原文展示并把来源徽章标成 `ai`；
- 后端补完后可删除 `StrategyExtras`，改为直接读 `row.strategy.logic` / `.playbook`；
- 前端**不**生成价位 / 目标价，操作计划的价位口径一律留给 `cn_get_option_intraday_box`。
