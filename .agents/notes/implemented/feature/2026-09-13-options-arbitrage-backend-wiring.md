# Agent Note: 期权套利后端链路接通（实时期权链 → 套利扫描）

Status: implemented

## Problem

前端（WorkBuddy）已交付 ETF 期权套利纯函数内核（`packages/strategies/src/arbitrage/`，
平价/箱型/垂直价差），但后端没有链路把**实时期权链**喂给它：`connector-options` 只会拉
`OptionChain`，不会产出机会表；且 `OptionQuoteRow` 契约缺 `bid`/`ask`，套利内核的
可执行边界（`executable=true` 需要真实买卖盘）永远无法生效，只能退回 mid/last 近似。
任务登记见 `docs/backend-handoff-2026-09-13.md`（任务 #10）。

## Decision

全链路（worktree `feat/options-arb-scan`）：

1. **契约**（`@dshtrading/api`）：`OptionQuoteRow` 加纯可选 `bid?`/`ask?`；新增
   `OptionArbitrageScanQuery/Result`（含 `assumptions.priceBasis:
   'bid_ask'|'mid_last'|'mixed'`、`OPTION_ARBITRAGE_DISCLAIMER` 常量）。
   `CnOptionsService.getArbitrageScan` 进服务接口。
2. **适配**（strategies）：`adapter.mapRow` 转发 bid/ask；package.json exports 加
   `./arbitrage` 子入口——深导入使消费方不经过会引 cordis 的主入口
   （`plugin.d.ts` 有 `import { Context, Service } from '@deepseek-ai/cordis'`）。
3. **组装**（connector-options `src/arbitrage.ts`）：`scanOptionChainArbitrage` 为纯组装
   层；`multiplier` 由调用方（`rest.ts` 名册查表）注入而非 import `rest.js`，防模块循环
   （tsdown `unbundle:true` 产独立模块，循环会成环）。
4. **桥**（client-ui-trading `bridge.ts`）：GET `/options/arbitrage`——spot 用名册 →
   spotSymbol → `getTicker` 现价拼接（复用 `#spotPriceOf` 抽取）；
   `feePerContract` 缺省注入 `OPTION_PAPER_FEE_PER_CONTRACT`（模拟盘费率 1.7 元/张，
   `fee=0` 显式关）。
5. **行情面**（python）：`iquant-quote/live.py` 从全推快照五档数组取**第一档**为
   买一/卖一，`0=无盘` 不落键；`python/options` `map_chain_quote` 有则透传。akshare
   板块列无买/卖价（数据源边界，`option_finance_board` 硬编码列）、synth 合成链无盘口，
   两路均缺省键——下游自动退回 `executable=false` 近似，不造 0 价。

## 已知坑（两个非显而易见的坑，排障各花数小时）

### TS 5.9 root 顺序敏感缺陷（connector-options TS2379）

引入 `src/arbitrage.ts`（字母序先于 `index.ts`）后，`super(ctx, serviceName)` 报
TS2379：`lib/types/index` 的 `Context`（小）不可赋给 `lib/types/context` 的 `Context`
（大，多 inject/plugin/get/set 等 18 个成员）。机制：cordis 入口
`index.d.ts` 经 `export * from './context.ts'` 转发 `Context`，而 cordis 内部 5 处
`declare module './context.ts'` augmentation 提供混入成员 + `utils.d.ts` 反向
`import './index.ts'` 成环；一旦**任何其他 root 文件先于 `index.ts` 进入程序**
（单 root 0 错 / 双 root 2 错，可稳定翻转复现），入口转发的 `Context` 会丢失全部
混入成员。主仓 0 错纯属 root 集巧合（dataplane.ts 的依赖链没踩中时序）。
**绕法**：connector-options `tsconfig.json` `"include": ["src/index.ts", "src"]`——
include 数组顺序即 root 顺序，把 `index.ts` 钉首位使 cordis 模块图从包名入口先建立。
升级 TS（6.0.3 已发布）或 cordis 修复后可移除，注释已留在 tsconfig。

### Python editable 安装的 worktree 假绿

worktree 里跑 pytest 导入的是**主仓**的 `dsh_options`（editable install 指向主仓
`python/options/src`），worktree 改动根本没被测到——新测试用例 `KeyError: 'bid'`
暴露了这一点（假绿时它通过了）。**worktree 里测 python 一律
`PYTHONPATH=$PWD/src python -m pytest`** 前置 worktree 自身 src。

## Alternatives considered

- **乘数写死 10000 在组装层**：违反全局约定（合约参数从名册读取不硬编码）；改为调用方
  注入，`FALLBACK_MULTIPLIER` 仅最后防线并注释说明。
- **connector-options 直接 import strategies 主入口**：主入口 dts 链会把宿主 cordis
  第二份 Context 类型拉进类型图；改 `./arbitrage` 深导子入口（虽然最终查明 TS2379
  根因是 root 顺序而非此处，深导入仍是正确的依赖最小化）。
- **python 侧 bid/ask 用 0 填充**：0 是合法 tick 但也是"无盘"哨兵；下游 `execPrices`
  会把 0 当真实价算出假机会。改为无盘不落键，让 TS 侧 `hasExecutableQuotes` 判 false。
- **升级 TS 6.x 修 root 顺序 bug**：超出本任务范围（门禁基线钉在 5.9.3），tsconfig
  锚定为最小绕法并留注释。

## Consequences

- 验收（handoff 10.3）全过：链路单测 + 网关集成冒烟（:8090 真实链路，510050/2609，
  27 opportunities + 364 verticals，休市日 K 回落 `executable=false`/`mid_last` 落位）；
  门禁主仓 263 → 261（净 −2，顺手修 bridge.ts 存量错），6 个上升包与主仓逐项一致全为存量；
  `src/client/**` 零改动，全仓 vitest 1289+ passed。
- 前端面板可直接消费桥 `GET /options/arbitrage`（`OptionArbitrageWire`）；展示须带
  `disclaimer`（套利为量化信号非投资建议）。
- 休市/盘后截面永远是 `executable=false` 近似口径——这是护栏语义不是缺陷；盘中全推
  快照到位后 `priceBasis` 自动转 `bid_ask`/`mixed`，无需改代码。
- deep OTM 行（如 K=3.3）在日 K 回落口径下会出现大偏离假信号（call_rich），`executable=false`
  已将其与可执行机会区分；真实盘口下此类偏离通常收敛。
