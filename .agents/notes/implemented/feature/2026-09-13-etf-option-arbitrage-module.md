# ETF 期权套利策略模块（纯函数内核）

- 日期：2026-09-13
- 状态：implemented
- 关联文档：`docs/etf-option-arbitrage.md`（策略规则层，同日产出）
- 落点：`packages/strategies/src/arbitrage/`（@dshtrading/strategies 纯库包，零运行时依赖）

## Problem

ETF 期权套利只散落在后端 `getParityCheck`（`packages/connector-options` / `python/options`，2026-09-11 已上桥），
缺一个**前端/浏览器可复用、确定性、可单测**的纯计算内核来承载「平价矩阵 + 箱型 + 垂直价差」三件套，
且无法在策略内核里被统一编排与回测。需要把套利数学从数据获取中解耦。

## Decision

1. **模块落在 `@dshtrading/strategies`（纯库包，非后端排除清单）**：它是 zero-runtime-dep、browser-packable 的纯函数内核，
   与既有 `paradigms`/`screeners` 同层；不落入 `@dshtrading/api`/connector/kit/python 等后端排除项，属 WorkBuddy 可执行范围。
2. **输入解耦**：定义本地最小类型 `ArbitrageChain`（`src/arbitrage/types.ts:11`）镜像 `api.OptionChain` 的 `calls/puts` + `last/prevSettle/bid/ask`，
   **不 import 运行时 api**；仅 `adapter.ts` 用 `import type { OptionChain }`（构建期擦除）→ `fromOptionChain()` 桥接后端链。
   保持纯库零依赖，同时确保后端 `getParityCheck` 流程可直接喂入。
3. **三个核心**：
   - `parityMatrix`（`parity.ts:38`）：逐行权价算 `偏差=(C−P)−(S₀e^{-qT}−Ke^{-rT})`，用买卖盘给可执行边界与四腿方向
     （call_rich → 卖合成买现货远；put_rich → 买合成卖现货远）。
   - `scanBoxArbitrage`（`box.ts:24`）：遍历 K₁<K₂，公平值 `(K₂−K₁)e^{-rT}` vs 多/空箱成本，给 long/short_box。
   - `buildVerticalSpread`/`scanVerticalSpreads`（`vertical.ts`）：四组合损益/盈亏平衡，作为**方向性策略**（非套利）单独暴露。
4. **编排 `scanArbitrage`（`index.ts`）**：合并平价+箱型机会按 `edgePerContract` 降序；垂直价差因有方向暴露不并入。
5. **可执行性标注**：无真实买卖盘时 `executable=false`（仅用 last 估算），强制下游以可成交价复核后才可下单——呼应铁律 #3 闸门。

## Alternatives considered

- 放进 `packages/kit-cn` 或 `connector-options`——放弃：二者在后端排除清单，WorkBuddy 只登记不执行；且套利数学应是无 I/O 纯函数。
- 直接复用后端 `getParityCheck` 的 KernelReport 透传——放弃：KernelReport 是 `Record<string,unknown>` 黑盒，前端无法类型化编排/回测；
  纯内核让策略层可组合、可单测、可浏览器跑。
- 把垂直价差也塞进 `scanArbitrage`——放弃：垂直是方向性价差（有方向暴露），与无风险套利混排会误导，单独 `scanVerticalSpreads` 暴露。

## Consequences

- 套利三件套在策略内核里有了确定性、可单测的实现；后端 `getParityCheck` 是数据/上桥侧，本模块是纯计算侧，二者互补不重叠。
- 收益单位统一为「元/股」+ `edgePerContract`（×乘数默认 10000）；`executable` 标志把"估算 vs 可成交"显式分离，避免虚假套利信号。
- 前端（client-ui-trading）现可 import `@dshtrading/strategies` 的 `scanArbitrage`/`scanVerticalSpreads` 直接渲染套利机会，
  实时链仍由后端 connector 提供（分工不变）。

## 门禁账

- **① 构建（tsdown）**：`pnpm --filter @dshtrading/strategies build` 通过；`node:fs/promises` 警告来自 `custom-fs.ts`/`builtin-tombstones-fs.ts` 存量模块（neutral platform 把 node 内建当 external），非本变更引入。
- **② 测试（vitest）**：新增 `test/arbitrage.test.ts` 7 tests 全绿；整包 `123/123` passed，无回归。
- **④ 类型棘轮（tsc --noEmit -p packages/strategies/tsconfig.json）**：本变更新增文件 **0 类型错误**；
  `engine.ts`/`plugin.ts`/`paradigms/*`/`custom.ts` 的存量报错属门禁基线内"存量债"，**本变更零新增**。
- **③ i18n 审计**：N/A——模块为纯数据计算，无 client-ui `locales.js` 改动。
- **注意**：门禁 #4 全仓当前为红（client 44 > 基线 33），本变更对该红账**零新增**，如实申报。
