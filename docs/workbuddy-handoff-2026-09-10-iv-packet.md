# workbuddy 前端交接（2026-09-10：定时桶 IV 制度展示）

分工：只改 `packages/client-ui-*/src/client/**`（+ 本包 client 半测试与 locales）。
不要改 `bridge.ts`、`option-overview.ts`、`kit-cn`、`@dshtrading/api`、python 内核。
契约权威：`docs/options-bridge.md`。打标算法已在宿主，**页面不算 `ivRegime`**。
本页是技术展示，不是投资建议；扫描按钮只 `fillComposer`，不下单。

后端已挂：

- 总览行 `ivRegime`（`tagIvRegime`，与 5 分钟桶同一函数）
- 总览行可选 `hv20`（20 日已实现波动率）、`nextAtmIv`（次月 ATM）。**不要**在页面用它们重算制度。
- `strategy.ivRegime`（当天最新 ContextPacket 投影；无 packet 则缺席，回落行上 `ivRegime`）
- `GET /dshtrading/api/options/bar-packet`（当天最新 packet；无文件不写 `packet` 键）

建议顺序：**WB-10 → WB-11 → WB-12**。WB-10 可单独交付。

---

## 闭集（不要自造第四种「感觉」）

`OptionIvRegime`：`rich` | `cheap` | `event_front` | `skew_put` | `skew_call` | `unknown`

活牌默认几乎全是 `unknown`（无历史分位、无 HV20）。这是正确状态，不是 bug。
`atmIv` 是年化波动率（如 0.22 = 22%），**不是** 22 分位。

---

## WB-10  总览 / 机会卡展示 `ivRegime`

范围：`OptionsOverview`、WB-9 机会卡 / `option-insight` 消费面。

1. `src/client/api.ts`：`fetchOptionsOverview` 已有则不必新函数。类型跟上
   `OptionOverviewRow.ivRegime` / `OptionOverviewStrategy.ivRegime`。
2. 总览表加一列或徽章（建议在 IV 列旁，不要替换 `atmIv` 数字）：

| 键 | zh 建议 | en 建议 |
|---|---|---|
| `options.overview.col.ivRegime` | IV 制度 | IV regime |
| `options.overview.ivRegime.rich` | 偏贵 | Rich |
| `options.overview.ivRegime.cheap` | 偏便宜 | Cheap |
| `options.overview.ivRegime.event_front` | 近月溢价 | Front-month rich |
| `options.overview.ivRegime.skew_put` | Put 偏斜 | Put skew |
| `options.overview.ivRegime.skew_call` | Call 偏斜 | Call skew |
| `options.overview.ivRegime.unknown` | 制度不明 | Unknown |

3. 机会卡解读：
   - 有 `ivRegime` → 用词典陈述制度，**不要**再用 `atmIv` 推断高低。
   - `unknown` + 有 `atmIv` → 沿用已有 `options.insight.reading.atmIv`（「活牌水平，不是历史分位」）。
   - 缺 `ivRegime` 且缺 `atmIv` → 已有 `iv_missing`。
4. **禁止**：在 `option-insight.ts` 里用 `atmIv` 或自己设 0.8/0.2 重算制度。
   行上已有宿主标签；insight 只翻译。
5. zh/en + `contract.ts` 同步，跑 `pnpm i18n:check`。
6. 单测：mock 行 `ivRegime: 'unknown', atmIv: 0.22` → 文案不得出现「22 分位」/「偏低」。

---

## WB-11  推荐列解释「为何观望」

`strategy.noTrade` / `opportunity=no_edge` 时，若 `row.ivRegime === 'unknown'`
或 `strategy.ivRegime === 'unknown'`，tooltip / 解读加一句：

| 键 | zh 建议 |
|---|---|
| `options.insight.reading.ivUnknownBlocksTheta` | 活牌无 IV 分位，定时桶不会落「收时间价值」。 |

有 `skipReason` 仍优先 skip 词典（`overlap` / `session` 等），不要被 IV 句盖住。
不要把「unknown」画成错误红条——信息级即可。

---

## WB-12  闭环条带对一下 packet（可选）

1. 新 fetch：`fetchOptionsBarPacket()` → `GET /dshtrading/api/options/bar-packet`。
2. 挂在 `OptionsCycleLoop` 顶或每张周期卡一枚制度徽章：按 `underlying` 对齐
   `packet.rows[]`。无 `packet` 键 → 不渲染整条「智能体所见」，不要空白报错。
3. 轮询跟 loop 一样 **30s**，`visibilityState === 'hidden'` 停。不要 5s。
4. 卡片上可同时显示：`forecast.regime`（箱体）+ `packet.ivRegime`（波动率制度）。
   两者不是同一个枚举，不要画成一个灯。
5. `packet.rows[].volumeRatio` 是 5d/20d；箱体行 `forecast.volumeRatio` 是 1m。
   展示时用不同词典键，禁止混标「量比」。

| 键 | zh 建议 |
|---|---|
| `options.loop.packetIv` | 本桶制度 |
| `options.loop.volumeRatioDaily` | 5/20 日量能 |
| `options.loop.volumeRatioBox` | 箱体量比 |

---

## 明确不要做

- 不要默认 `includeIv=1` 刷九路分位。
- 不要在 client 半拟合微笑 / 算 HV / 发明箱沿。
- 不要点 `ivRegime` 徽章下单或改扫描 prompt。
- 不要为 `event_front` / skew 补前端算法——活牌 packet 暂时几乎只出
  `rich` / `cheap` / `unknown`，其余键先留词典。
- 不要改 node 半或 `src/client` 以外的文件。

---

## 验收

- `npx vitest run`（client-ui-trading）全绿
- `pnpm i18n:check` 通过
- 总览：只有 `atmIv` 的行显示「制度不明」+ 年化 IV，不显示假分位
- loop：无 packet 文件时页面不炸
- 视觉冒烟：trading-web，期权总览 + 闭环条带

后端说明：[ContextPacket note](../.agents/notes/implemented/feature/2026-09-10-option-bar-context-packet.md)。
旧总览工单仍有效：`docs/workbuddy-handoff-2026-09-08.md`（WB-0–WB-9）。
