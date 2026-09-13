# Agent Note: 期权虚拟账户接入资产面板（双账本只读展示）

Status: implemented

## Problem

后端把期权纸账户升级为双账本（`strategy` 策略 / `arbitrage` 套利，各 10 万），
由宿主 30s 心跳 `optionCycleTick` 全自动驱动，并开放了 4 条桥路由
（`GET /options/paper/accounts|account|fills`、`POST /options/paper/reset`）。
但前端零消费：`GET /options/paper/*` 在 `src/client/**` 里没有任何调用点，
资产面板（HoldingsPanel）只有股票三源（paper 模拟 / live 实盘 / imported 导入），
两个期权账本的资金、持仓、成交流水在界面上**完全不可见**——后端每 30s 在动钱，
用户看不到任何一行。

交接单：`docs/workbuddy-handoff-2026-09-13-option-paper-books.md`（后端起草，
明确「交接面 = 桥 JSON，账本逻辑全部在后端，前端只读展示」）。

## Decision

在 `packages/client-ui-trading/src/client/**` 内落一条只读消费链（前端泳道）：

1. **api 层**（`api.ts:517-632`）：`OPTION_PAPER_FILLS_LIMIT = 48`（与桥缺省值同源）、
   `fetchOptionPaperAccounts` / `fetchOptionPaperAccount` / `fetchOptionPaperFills` /
   `resetOptionPaper`，一律返回 `OptionsOutcome` 分诊信封——「桥没挂」与「账本为空」
   必须能分开，否则资产面板会把 404 画成「权益 0」，把故障说成事实。
   `resetOptionPaper` 不做任何确认（分层：api 只搬数据，确认归 UI）。
2. **视图词汇层**（新文件 `option-paper-view.ts`）：账本名 / 套利结构（parity·box）/
   套利方向 / 成交原因 / 价格来源 → 词典键的闭集映射走 `satisfies` 让缺项编译期就红
   （`BOOK_KEY:26`、`REASON_KEY`、`ARB_DIRECTION_KEY`、`PRICE_SOURCE_KEY`）；
   模板名是**开集**，未命中返回 `undefined` 让调用方出等宽原文，不硬造「其他」标签。
   同时承载唯一允许的前端派生量：收益率 `(equity − initialCash) / initialCash`
   （`bookReturnRatio:143`，`initialCash` 非正 → `undefined` 而非误导性百分比）、
   到期天数（`expiryDaysLeft:157`，按 UTC+8 整日切分，不依赖运行环境时区）、
   行权价展示（`strikeLabel:183`，parity 单值 / box 升序两端）、
   原因分档（`paperReasonKind:91`：到期强平与破位平仓**不同档**——一个是计划内到期、
   一个是信号失效，视觉混了就看不出账本为什么在动）。
3. **组件**（新文件 `OptionPaperBooks.tsx`）：两张账本卡（现金 / 盯市权益 / 初始资金 /
   已实现盈亏 / 收益率）+ 每卡持仓区（结构·方向徽章、行权价、到期日临期高亮、
   张数、开仓边、保证金）+ 可展开腿明细（现货腿标「份」+ 现货全符号，期权腿标「张」+
   对手价来源）+ 成交流水（按账本 chips 切换、原因徽标分档着色、落账后现金）+
   底部常驻免责声明。轮询两条 `usePoll(..., 30_000)`（账户与流水解耦，切账本即时重拉），
   卸载即停、页面不可见暂停由 `usePoll` 承担。
4. **挂载**（`HoldingsPanel.tsx:69/92/1131`）：新增 `optPaper` 页签（标签「期权账户」），
   body 渲染 `<OptionPaperBooks t={t} />`。该页签**不受 `tradeMode` 影响**——
   paper/live 开关切的是股票面数据源，期权账本是它自己的模拟账本，两者不相干。

### 关键口径（照抄交接单，别自行优化）

- **不做金额换算**：`cash` / `equity` / `realizedPnl` / `premiumCny` / `marginCny` /
  `cashAfter` 一律直接展示。后端已按「期权腿 ×10000、现货腿不乘乘数、现货腿佣金万 1」
  算好；前端任何再乘除都会把口径搞错。
- **不自己触发心跳**：`POST /options/cycles/tick` 是回放/调试口，资产面板不调。
- **重置按账本单独进行**且必须二次确认（`window.confirm`，文案带账本名，避免按错账本
  还不自知）；成功用回包就地替换该账本卡，不等下一跳轮询；失败出提示且**不假装已归零**。
- 失败诚实：首次拉取失败 → 错误码原文上台（`data-opt-paper-failure`），不渲染任何账本卡；
  已有数据后的单次抖动只记账不回滚——不让一次网络抖动把权益数字抹成空态。

## Alternatives considered

- **把两个账本做成两个独立页签**：否决。面板是约 380px 的窄列，页签条已有 5 个，
  再拆两个会让标签挤成缩略语；且「两个账本对比着看」正是用户诉求（谁在赚钱）。
- **做宽表格（thead/th + 每持仓一行）**：否决。窄列里 7 列必横向滚动，与面板既有
  「卡 + meta 行」语言冲突；改用卡片 + `data-opt-paper-*` 测试钩子，
  字段齐全且断言确定（不依赖文案格式）。
- **在前端按腿重算名义额 / 盈亏**：否决。会与后端口径二次实现，一旦漂移就是
  「界面数字与账本文件不一致」这类最难查的错；交接单 §B2 明令禁止。
- **用 `optionCycleTick` 前端定时触发**（保证「机会即现即成交」）：否决。心跳归宿主，
  页面再加一个触发源会造成重复开仓；交接单 §B4 明确前端不需要任何触发动作。
- **把期权纸账户并进现有「持仓」页签的三源表**：否决。期权持仓 1 张 = 10000 份，
  与股票「股」不同量纲，混进同一张汇总表会让市值口径失真；独立页签才守得住口径。

## Consequences

- 资产面板新增第 6 个页签；股票三源、汇总、委托/成交/余额四类既有展示**零改动**
  （`git diff` 仅面板 3 处：类型并集、标签映射、body 渲染 + 1 处 import）。
- i18n 新增 61 个键（页签标签 `trade.tab.optPaper` + 60 个 `trade.optPaper.*`；
  中英 1:1、各 120 条词条、无重复，占位符 `{count}` / `{book}` / `{code}` 两侧对齐）；
  中文字面量全部走词典，源码零 CJK（i18n 扫描过）。
- 新增 30 个测试用例（视图层 12 / api 8 / jsdom 冒烟 10），锁住三类别最容易「静默说错话」
  的行为：桥缺席不画权益 0、重置不牵连另一账本、现货腿按「份」而非「张」。
- 门禁账（本变更，串行跑）：
  - `pnpm --filter @dshtrading/client-ui-trading build` 绿；产物自检
    `lib/client.js` 含 11 处 `opt-paper` 钩子、`lib/client/locales.js` 含新免责键 zh/en 各一次。
  - `npx vitest run`（包目录）**537/537 通过**（60 文件；较变更前 +30，新增三文件）。
  - `node scripts/i18n-audit.mjs --check` OK：5 namespaces / **1299** zh keys / 26 exemptions。
  - `node scripts/typecheck-gate.mjs` **零新增**：总数 261（= 本 worktree 变更前基线 261，
    由后端分支带入的存量债）；`tsconfig.client.json` 44 = 变更前 44；
    新增四文件 tsc 报告 0 错误（中途一处 `readonly` 数组赋值已在本变更内修掉）。
    **该门禁本身仍是红的**（六个包高于 `scripts/typecheck-baseline.json`，基线停在
    2026-09-09，属既有事实），此处按「本变更零新增」申报，未替他人清债。
- 已知未做（有意）：`fetchOptionPaperAccount`（单账本视图）当前无调用点——桥已开该路由，
  供未来「点开某账本看全屏流水」用；登记而非顺手删掉接口。
