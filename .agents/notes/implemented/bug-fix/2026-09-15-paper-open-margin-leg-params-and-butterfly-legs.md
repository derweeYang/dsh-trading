# Agent Note: 纸账户开仓保证金缺参与蝶式零腿修复（kit-cn）

Status: implemented

## Problem

纸账户自上线（09-08）起**从未有过一笔真实成交**，09-14 首个有信号的交易日仍是
3 条 fill 全 `skip: no_quote`。两条独立的执行断点：

1. **保证金查询恒失败**：`kit-cn/src/index.ts:272` 的 `getMargin` 把腿原样透传给
   `service.getStrategy({ underlying, legs })`，腿上只有 `code / side / qty / premium`，
   **没有 `optionType` / `strike` / `expiryMonth`**；而 python 内核对 vertical 模板强校验
   `expiryMonth/optionType/longStrike/shortStrike`（`python/options/src/dsh_options/strategy.py:110`
   的 `_required`，缺参即 `OptionsError("BAD_REQUEST")`）。`getMargin` 的 `catch` 把错误吞成
   `undefined` → `decidePaperOpen`（`option-paper.ts:457`）判 `no_quote`。
   旁证：09-14 13:45 桶推荐的 playbook 原文记录「cn_get_option_strategy rejects every call,
   reporting expiryMonth/optionType/longStrike/shortStrike missing」。
2. **蝶式在纸账户里不可能成交**：`decidePaperOpen` 只放行 `template === 'vertical'` 去取链
   （`option-paper.ts:426`，改前），其余模板直接 `no_quote`；且蝶式候选 `bias` 恒为 `neutral`，
   即便拿到链 `completeVerticalLegs`（`:128`）见 neutral 也返回 `no_quote`。
   `tryPaperOpen:705` 同样只给 vertical 取链，蝶式的 `chainFor` 恒 `undefined`。
   09-14 三条 butterfly 推荐全部死在这条路上。

## Decision

- 新增 `kit-cn/src/option-code.ts`：`parseOptionCode(code)` 从**长代码内嵌字段**解析
  `underlying / optionType / expiryMonth / strike`（`510050C2609M02850` → 510050 / C / 2609 / 2.85）。
  信息本来就在代码里，不需要额外取数。解析失败返回 `undefined` 而不抛错（现货腿解析不出，
  调用方按缺参处理即可，抛错会中断整个开仓决策）。
- `kit-cn/src/index.ts:272` 的 `getMargin`：解析首条可解析的腿，给 request 顶层补
  `expiryMonth`，并给每条腿补 `optionType / strike / expiryMonth`（条件展开，兼容
  `exactOptionalPropertyTypes` 与现货腿）。
- 新增 `completeButterflyLegs(chain, qty)`（`option-paper.ts`）：按 ATM 上下各一档造
  **买 1 / 卖 2 / 买 1** 三腿；档位不足三行或任一腿无报价 → `no_quote`（与 vertical 同款纪律，
  绝不口算权利金）。
- 放行蝶式取链两处：`decidePaperOpen:465`（`template !== 'vertical' && !== 'butterfly'` 才
  no_quote）、`tryPaperOpen:705`（`needsChain` 含 butterfly，并按模板分派 complete 函数）。

## Alternatives considered

- **让 python 内核从 code 自行解析**（改 `strategy.py`）：解析逻辑放内核更彻底，但涉及
  `packages/api` 契约与 python 侧，按 AGENTS.md 属「改公共契约」需走 PR + 审查，且是
  Cursor/Claude 的地盘——本次授权范围明确排除，故在 kit-cn 侧补齐（长代码解析是纯确定性
  变换，放哪一侧语义等价）。
- **给 `cn_get_option_strategy` 工具 schema 补 `optionType/longStrike/shortStrike`**：
  这是 agent 侧「想指定腿却无门」的独立缺口（`options-tools.ts:214` 的 schema 只有
  template 路线），但不在本次授权范围，**登记为待办**（见下）。
- **让蝶式复用 `completeVerticalLegs` 并放宽 neutral**：语义错误——蝶式是三腿且 body 卖 2 张，
  vertical 是两腿 1:1，强塞会算错权利金与保证金。
- **只修保证金不管蝶式**：09-14 的 3 次开仓尝试里 2 次是蝶式，只修保证金仍零成交，无法达成
  「出现第一笔带腿成交」的验收。

## Consequences

门禁账：

- `pnpm --filter @dshtrading/kit-cn build`：绿（25 files, 243.63 kB）。
- 包内 `npx vitest run`：**14 文件 / 198 用例全绿**。增量归因：仅本次新增
  `option-code.test.ts`(4) + `option-paper-butterfly.test.ts`(6) = **+2 文件 +10 用例**；
  `git log` 显示 HEAD 仍为开工前的 `5269bc3`，期间无并行会话提交，测试目录除这两个新文件外
  均为 09-13 及更早。（09-13 交接文档记的「171 passed」已是旧数，实测基线 188。）
- `node scripts/i18n-audit.mjs --check`：`OK: 5 ns, 1339 keys, 27 exemption(s)`，与改前一致
  （后端改动未引入 client 可见文案）。
- 类型：`npx tsc --noEmit -p tsconfig.json` 计 27 条，其中落在我改的
  `option-code.ts` / `option-paper.ts` / `index.ts` 为 **0** → 零新增。
- **退回验证**：把 `decidePaperOpen:465` 退回 `pick.template !== 'vertical'` 后，蝶式两条用例
  （`decidePaperOpen` 出 fill、端到端落带三腿成交）如期报红，恢复后转绿。
- **端到端证明**：新用例 `tryPaperOpen 蝶式端到端` 在 tmpdir 纸账户里真的落了一笔
  `offset:'open'` / `reason:'signal'` / `legs.length === 3` 的成交——这是纸账户历史上第一笔
  蝶式成交（测试环境下）。

**未验证（必须由真实盘验证）**：`getMargin` 的补参是否真能让 python 内核接受，取决于内核在
「传 legs 不传 template」路径下是否还走 `_required` 校验——本次无法打真实网关
（现网宿主在 :3081，起第二实例会撞 `~/.dsh/.credentials.yaml.lock`）。验收标准不变：
**首个交易日出现第一笔带腿成交**。

**剩余待办（已登记，归 Cursor/Claude）**：
1. 工具 schema `cn_get_option_strategy`（`options-tools.ts:214`）不暴露
   `optionType / longStrike / shortStrike`，agent 想指定腿仍无门——建议补参数并透传，
   或在 description 里明写「腿由 template 决定，不要传这三个参数」以消除误用。
2. 确认 python `strategy.py` 在 legs 直通路径下的必填字段；若仍要求 template 分支参数，
   需在 connector 侧同步。
3. `data/options/reviews/` 的确定性复盘要加「执行覆盖率」列（有 picks 桶数 vs 有成交桶数），
   否则 hit 数会继续掩盖执行缺口。
