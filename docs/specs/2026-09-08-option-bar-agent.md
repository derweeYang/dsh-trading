# Spec：ETF 期权 5 分钟 K 智能体（落盘 + 交易时段推荐 + 确定性盘后复盘）

- 日期：2026-09-08
- 状态：proposed
- 决策记录：[`.agents/notes/proposed/feature/2026-09-08-option-bar-agent.md`](../../.agents/notes/proposed/feature/2026-09-08-option-bar-agent.md)
- 分工：Cursor / Claude 做契约、落盘、tick 触发、skill、种子卡片；workbuddy 只展示推荐卡与复盘，不改 `packages/client-ui-*/src/client/**` 以外的桥

## 1. 产品

每个 **Asia/Shanghai `regular` 5 分钟桶**收盘后，开 **一次** trader 会话：读已算好的箱体 / 总览 JSON，写出推荐策略。人要看到：

- 交易逻辑
- **赚的是哪类机会的钱**（闭集，见 §5）
- 操作策略（开平、持有视界、张数、义务仓）或 `no_trade`

盘后 **不开** LLM。用当天 jsonl 收成一篇复盘 md。预填 ≠ 下单；双闸不变。不构成投资建议。

## 2. 范围

做：

- 本仓 `data/options/` 文件账本（cycles / recommendations / reviews）
- L0 闭环从内存环改为「内存 + 当日 jsonl」；进程重启回放当天 cycles
- `optionCycleTick` 在新桶且 `sessionFlag === 'regular'` 时触发一次 LLM
- 推荐 JSON 契约 + `option-intraday-workflow` 六段输出
- knowledge-stock → DSH 卡片的初始化投影（制度 / 纪律，不灌网文胜率）
- 交易员 skill 白名单加上 `option-intraday-workflow`

不做：

- 不用右侧栏 `*/5` cron 算箱体或打分（打分仍是 `kit-cn` 纯函数）
- 不在 `no_trade` 时段开会话（`open15` / `lunch` / `close5` / `closed`）
- 不改箱体公式、Greeks、保证金算法
- 不自动 `POST /options/order`
- 不把每日复盘写入 `knowledge-stock` L5
- 不改 `packages/client-ui-*/src/client/**`（展示归 workbuddy）

## 3. 两套时钟

| 层 | 触发 | 频率 | 产出 |
|---|---|---|---|
| L0 | 宿主 `setInterval(30s)` → `optionCycleTick` | 同桶幂等 | 预报本桶、打分上一桶、追加 `cycles/*.jsonl` |
| L3 | L0 **新桶**且 `sessionFlag === 'regular'` | 一根 5 分钟 K 一次 | **一个** trader 会话 + 一行 `recommendations/*.jsonl` |
| 盘后 | 首次进入 `close5` 或当日 `closed` | 每天至多一次 | `reviews/YYYY-MM-DD.md`（无 LLM） |

`sessionFlag` 与箱体同源（`packages/kit-cn/src/intraday-box.ts`）：

| 时段 | 墙钟 | LLM |
|---|---|---|
| 开盘 15 分 | 09:30–09:45 | 否 |
| regular 上午 | 09:45–11:25 | 是 |
| 午休边 | 11:25–11:30、13:00–13:05 | 否 |
| regular 下午 | 13:05–14:55 | 是 |
| 尾盘 5 分 | 14:55–15:00 | 否 |
| 周末 / 其余 | — | 否 |

一根 K = 一次智能体，九标的漏斗在这一次做完。禁止每标的各开一轮。上一轮会话未结束 → 本桶不排队，recommendations 写桩 `skipReason=overlap`。

非 `regular` 新桶：cycles 照写；recommendations 只追加桩（`opportunity=no_edge`，`skipReason=session`）。全市场 `calibrated` 同理，`skipReason=calibrated`，不开会话。

## 4. 本仓数据目录

```text
data/options/
  README.md
  cycles/YYYY-MM-DD.jsonl
  recommendations/YYYY-MM-DD.jsonl
  reviews/YYYY-MM-DD.md
```

- 路径相对仓库根。可用环境变量 `DSH_TRADING_OPTIONS_DATA` 覆盖，默认 `data/options`。
- gitignore：`data/options/cycles/`、`data/options/recommendations/`、`data/options/reviews/`。保留 `README.md`。
- 不写 `~/.dsh/`，不写 `knowledge-stock/L5_operations/`。
- `.trading-journal/` 仍只记「做了什么」。

### 4.1 cycles 行

每标的每桶一行。字段 = 现有 `OptionCycle`（`id` / `underlying` / `bucketStart` / `asOf` / `forecast` / `score?` / `calibration`）。同一 `id` 先写 forecast，下一桶把带 `score` 的整行再追加（append-only；读时按 `id` 取最后一条）。

启动时把当天 jsonl 回放进 `OptionCycleBook`，再接 30s tick。环长度仍 48 桶/标的。

### 4.2 recommendations 行

每个 `bucketStart` 至多一条有效推荐（桩也算一条）。幂等键 = `bucketStart`。  
`logic` = 制度假设与为何此模板（含行权价相对箱体）。`playbook` = 开平条件、持有视界、张数上限、义务仓。两者都是字符串，禁止贴 1 分钟 K。

```json
{
  "bucketStart": "2026-09-08T01:45:00.000Z",
  "asOf": "2026-09-08T01:45:12.000Z",
  "session": "regular",
  "opportunity": "theta_rent",
  "edge": "range_hold 下收时间价值；权利金来自偏贵的 IV，不是赌方向",
  "logic": "…",
  "playbook": "…",
  "invalidIf": "1-minute close outside [2.9910, 3.0090]",
  "picks": [{
    "underlying": "510050",
    "regime": "range_hold",
    "template": "butterfly",
    "legs": [],
    "cycleId": "510050:1757305500000"
  }],
  "noTrade": false,
  "skipReason": null,
  "previousScore": { "cycleId": "510050:1757305200000", "verdict": "hit" }
}
```

`skipReason` 闭集：`session` | `calibrated` | `overlap` | `launch_failed` | 缺席。  
`opportunity` 为 `no_edge` 时 `noTrade=true`，`picks` 可空。  
`invalidIf` / 箱沿 / 权利金 / Greeks / 保证金只许抄工具 JSON。  
`template` 必须属于该行 `forecast.candidates`；否则整单改 `no_edge`。

### 4.3 reviews 文件

首次进入当日 `close5`（或当天从未 `regular` 而后 `closed`）写一次，已存在则不覆盖。六节，全部引用 jsonl，不调模型、不拉 1 分钟 K：

1. 各标的 hit / partial / miss / skipped 计数  
2. 每条有效推荐：`opportunity` 与下一桶 `score.verdict`  
3. 误给腿 / 该给腿却空仓  
4. `overlap` / `launch_failed` 次数  
5. 至多一条明日剧本候选（样本 &lt; 10 只记「不足」）  
6. 免责：技术研究预填，非投资建议  

## 5. 机会闭集

模型不得自造第四种「感觉」。`opportunity` ↔ 允许的 `regime` + `template`：

| opportunity | 允许 regime | 允许 template | 赚的钱 |
|---|---|---|---|
| `theta_rent` | `range_hold` | `butterfly` | 时间价值 / 波动率溢价 |
| `rv_vs_iv` | `vol_expand` | `straddle` | 已实现波动大于隐含 |
| `direction_delta` | `breakout` | `vertical` | 方向突破的 delta |
| `mean_reversion` | `mean_revert` | `vertical` | 回归 + 权利金 |
| `covered_yield` | 非 `no_trade` | `covered_call` / `collar` | 底仓增强 / 减持溢价；须 `heldQty` 够 1 张 |
| `no_edge` | 任意 | — | 不交易 |

现行箱体 `candidatesFor` 只出 `butterfly` / `vertical` / `straddle`。`covered_yield` 仅当候选里真有备兑/领口且 `heldQty >= 10000`。禁止为了备兑发明候选。

总览纪律不变：`weak_rally` 不做多头卖方；`accelerating_sell` 不做无保护短 put；同源双挂先合并。

## 6. LLM 会话

- 预设：`trader`（禁止 master 三子代理）。
- 由 tick **事件**拉起，复用 `TasksRunner.launch`，不登记成用户可改 cron 的右侧栏任务（避免和 L0 墙钟错位）。
- Prompt 静态（Layer 2）：先 `knowledge_search`（首标签 `ETF期权`）→ 读 `GET /options/overview?sort=strength&includeIv=1` 与 `GET /options/cycles/loop` → 需要腿时 `cn_get_option_strategy`。禁止 `*_get_klines`、禁止下单工具、禁止动态包。
- 先写 recommendations 行，再输出六段给人看：`opportunity`+`edge` → 制度 → 模板 → 行权价相对箱体 → `invalidIf` → `playbook` 或 `no_trade`。
- 上一桶已有 `score` 时，六段之前用一句话对照上次推荐是否被证伪。
- 工具失败或会话启动失败：桩 `skipReason=launch_failed`，不重试本桶。

## 7. 知识初始化（knowledge-stock → 卡片）

`D:\workspace\myquant\projects\knowledge-stock` 是长文 SSOT。DSH `knowledge_search` 只读 `~/.dsh/knowledge/cards.json`。

首批约 10 张 `manual` 卡，`source.url` 指回 stock 文件或本 spec / skill 路径，第一标签必须是 `ETF期权`：

1. 九标的 + 乘数 / 欧式 / 第四个周三（L2 `etf_options_rules.md`）— high  
2. 现货 T+1 vs 期权 T+0 — high  
3. 义务仓 12%/7% 与备兑免保证金（数字以内核为准）— high  
4. 同源双挂合并 — high  
5. 箱体只引用工具 JSON — high  
6. `weak_rally` / `accelerating_sell` 禁令 — medium  
7. 模板地图（仅 `candidates` 会出现的结构）— medium  
8. 反方：价差 vs 半宽、临近到期、深市流动性 — high  
9. 无 `invalidIf` 不谈买卖 — high  
10. 复盘只改剧本、不改箱体公式 — high  

不进卡片：`etf_options_practice_web.md` 胜率、具体权利金区间、`intraday_decision.md` 的 MA20/量比（现货盯盘，与箱体冲突）。

盘中召回卡片。可复用的制度结论才 `knowledge_ingest`（URL 指回当天 `reviews/`）。证伪下架须人确认。

## 8. 错误与重叠

- 单标的 1m 失败：该行 `no_trade`，不整页失败（现行为）。  
- 期权网关失败：仍可出箱体与 `no_edge`；不要腿。  
- 目录不可写：tick 打日志，闭环内存继续；LLM 不启动。  
- 重叠：跳过，不取消上一轮。  
- 日历：`sessionFlag` 不管节假日；节假日若行情源无 1m，箱体会 `insufficient`，LLM 因非 regular 或全 `no_trade` 不会开。

## 9. 测试

- `sessionFlag` 边界：09:44 不开、09:45 开、11:25 不开、13:05 开、14:55 不开。  
- 同 `bucketStart` 第二次 tick 不写第二份 forecast、不启第二轮 LLM。  
- 回放当天 jsonl 后 `loop.latest` 与文件最后一条一致。  
- 推荐校验：模板不在 `candidates` → 拒绝落成有效推荐。  
- 复盘：`close5` 第一次 tick 写出 md；第二次不覆盖。  
- overlap：伪造「上一轮进行中」→ 本桶桩 `overlap`。  
- 现有 box / cycle 单测保持全绿。

## 10. 验收

1. 交易日 regular 时段，每根新 5 分钟 K 至多一轮 trader 会话。  
2. 午休、开盘 15 分、尾盘 5 分、周末：零会话，只有桩。  
3. `data/options/cycles/` 与 `recommendations/` 按日追加。  
4. 当日首次进入 `close5`（14:55 起）写出一篇复盘 md，过程无 LLM；不覆盖已有文件。  
5. 推荐含闭集 `opportunity` 与「赚哪类钱」的 `edge`。  
6. 无自动实盘单。
