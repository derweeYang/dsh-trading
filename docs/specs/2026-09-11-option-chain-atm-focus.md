# Spec: 期权链日 K 预热 + ATM 焦点收窄（修 overview 首屏慢）

日期：2026-09-11　分支：`option-chain-atm-focus`　状态：已确认

## 1. 问题

页面「九标的 5 日走势」首屏慢（冷缓存 20~25s）。实测定位：

- 5 日走势数据本身（`:5810 /v1/klines` 日 K 21 根 × 9）热缓存 ~2ms，**不是瓶颈**。
- 瓶颈是同一个 `GET /options/overview` 请求里的 ATM IV：
  `bridge #overviewAtmIv` → `:8090 implied_vol` → `_snapshot_iquant` 全量拉链 →
  `:5810 option_chain` 盘外对**链上每合约串行** `_last_daily_quote`（每合约一次
  SDK `history_bars`），被 `daily_deadline=8s` 截断 → 单标的次月冷链 ~10s，
  九标的并发 20~25s。deadline 后的合约拿 0 价，IV 静默缺行。
- 触发时机：网关重启后首屏（preheat 未覆盖链日 K）；桥端 `#atmIvCache` 5 分钟
  TTL 过期后的首次加载；盘中 `_daily_cache` 60s 过期时链上非流动合约逐个回落。

## 2. 目标

- 冷启动后首次打开 `/options/overview` 的 ATM IV 环节不再以 8s×N 量级阻塞；
  ATM IV 冷链拉取降到亚秒级（只回落 ATM 附近档位）。
- 网关重启后后台把九标的近月/次月链打热，后续首屏免冷打。

## 3. 非目标

- 不改 `GET /options/overview` 的 API 形状（不做 IV 异步回填）。
- 不动 `vol_analytics` / `strategy` / `parity_check`（它们需要全链，继续全链拉）。
- 不做 `_last_daily_quote` 并行化（收窄后已无必要；SDK 并发安全未验证）。

## 4. 方案

### 4.1 iquant-quote：`option_chain` 增加可选 `atmFocus`

- `POST /v1/option_chain` body 增加可选字段：
  `atmFocus: {"spot": <正数>, "strikes": <1..10>}`。
- 语义：只返回按 `|strike − spot|` 最近的 **strikes 个行权价档**的 C/P 对
  （响应是**截短链**：calls/puts 各 ≤strikes 行，按 strike 升序）；
  仅对这些合约做 tick / 日 K 回落。**缺省不传 → 行为与现在完全一致（全链）**。
- 校验失败（spot 非正数、strikes 越界）→ `BAD_REQUEST`，不影响全链路径。
- `service.py handle_command` 透传 `atmFocus`；`live.py option_chain` 实施收窄：
  收窄在 `option_instruments` 结果上先按 strike 距离选档，再对选中合约取价。
- T 板（`chain` 不带 atmFocus）、`option_instruments` 不受影响。

### 4.2 python/options：`implied_vol` 的 iquant 截面带 `atmFocus` 下传

- `pricing._snapshot_iquant`：调整顺序——先 `iquant.fetch_spot`（已有，快），
  再把 `atmFocus: {"spot": spot, "strikes": 3}` 并入 `chain.handle_chain` 的
  请求体（iquant 源才传；synth/akshare 不传）。
- `chain._chain_iquant`：透传请求里的 `atmFocus` 给 `run_quote("option_chain", …)`。
- `strikes=3`（每侧含 ATM 共 3 档行权价，C/P 成对）：覆盖 bridge
  `extractAtmIv`（取与 spot 最近 strike 的 IV）与离群 IV 剔除后的兜底。
- 请求显式传 `"atmFocus": null`/false 时不收窄（显式全链，供离线复算）。

### 4.3 iquant-quote：预热扩展

- `preheat_symbols` 缺省清单补齐九标的（现缺 510500、159922），仍可用
  `IQUANT_QUOTE_PREHEAT_SYMBOLS` 覆盖。
- `preheat()` 在现有 ticker/1m 预热后新增链预热（daemon 线程内串行，尽力而为）：
  1. **ATM 波**（保首屏）：每标的 × 当月/次月（YYMM，当月已过第四个周三则
     跳过该月），用 ticker 拿到的 last 作为 spot，带 `atmFocus{spot, strikes:3}`
     拉 `option_chain`——把 ATM 档合约的 `_daily_cache` 打热。
  2. **全链波**（保 T 板）：同月份清单逐链全量拉一遍（不带 atmFocus）。
     盘外日 K 当日复用，一轮 ≈2~3 分钟；失败每链记一行，不重试。
- 到期月计算与 bridge `seasonalExpiryMonths()[0..1]` 对齐（当月、次月）。

## 5. 风险与对策

- **收窄后 ATM 判定依赖请求方给的 spot**：spot 失真 → 选错档。对策：strikes=3
  留两侧余量；bridge 的 `extractAtmIv` 本就用响应内 `spot` 找最近 strike，
  不因截短而错档。
- **盘中 tick 路径**：`_collect_ticks` 订阅量随收窄变小（只订 ATM 档合约）——
  iv 链盘中更快，无正确性影响（T 板仍全量订阅）。
- **预热抢 SDK**：预热线程与首屏请求并发打 `history_bars`。ATM 波每链仅
  ~6 合约，冲击可忽略；全链波排在 ATM 波之后，最坏情况与现状（用户请求
  自己冷打全链）等价，不劣化。
- **当月链摘牌**（第四个周三后 2609 已到期）：预热按 expiryDate 跳过已过期
  月；bridge 拉过期月得 NO_DATA 属既有行为，不在本次修复范围。

## 6. 验收

1. 单测：iquant-quote（atmFocus 解析/收窄/校验、preheat 月份选择）、
   options（_snapshot_iquant 传参、chain 透传）全绿。
2. 重启 `:5810` 网关后实测（盘外）：
   - 预热日志出现九标的 × 近/次月 ATM 波完成；
   - 冷缓存 `implied_vol`（未预热的远月，如 2612）带 atmFocus 手工调用
     <1s（对比现状 ~10s）；
   - `GET /options/overview`（桥端或直接 `:8090` 组合）首屏 ATM IV 环节
     不再出现 8s+ 行；整体返回较修复前明显下降。
3. 回归：不带 atmFocus 的 `option_chain` 返回行数与结构不变（T 板不受影响）。

## 7. 涉及文件

- `python/iquant-quote/src/dsh_iquant_quote/live.py`（option_chain 收窄、到期月工具）
- `python/iquant-quote/src/dsh_iquant_quote/service.py`（透传）
- `python/iquant-quote/src/dsh_iquant_quote/gateway.py`（preheat 扩展）
- `python/iquant-quote/tests/`（新增用例）
- `python/options/src/dsh_options/pricing.py`（_snapshot_iquant）
- `python/options/src/dsh_options/chain.py`（_chain_iquant 透传）
- `python/options/tests/`（新增用例）
