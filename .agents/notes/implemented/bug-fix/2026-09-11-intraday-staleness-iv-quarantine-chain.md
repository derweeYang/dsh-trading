# Agent Note: 盘中数据停更/串位 + IV 离群 + paper no_quote + 复盘午夜抢写（2026-09-11 事故五连修）

Status: implemented

## Problem

2026-09-11 期权 5 分钟 paper 流水线复盘暴露五个串联缺陷：

1. **1m K 线停更透传**：iquant-quote 网关 `klines` 不校验尾 bar 时间戳。厂商本地
   历史库盘中停更后（10:10 起 510050 1m 尾 bar 冻结），停更数据照常回给 cycles，
   箱体 10:10→13:35 全天定格，推荐全程基于冻结数据。
2. **snapshot 跨标的串位**：SDK 进程级共享 drain 队列导致 snapshot 拿到别的标的
   tick（4.575/7.597 出现在 510050 数据里）；`_daily_cache` 无 TTL 进程终身有效，
   错误的回退收盘价全天污染。
3. **IV 离群值无检疫**：bsm.py 反解上界 5.0 会"合法收敛"出 3~5 的年化 IV
   （当日多标的 atmIv 3.76-4.89），被 `tagIvRegime` 判成 event_front，LLM 上下文
   被污染。
4. **paper 全部 no_quote**：两处 `getChain` 注入只传 underlying 不传 expiryMonth，
   `getOptionChain` 必填校验直接 throw → 所有 vertical 空 legs 推荐 0 成交
   （当日 4 条推荐全 no_quote）。
5. **复盘午夜抢写**：午夜跨日第一个 tick session='closed'、exists=false，旧口径
   `!exists && closed` 为真 → 00:02 把复盘抢写成全 0 空版，盘中真实统计被无视。

## Decision

- **网关 fail-loud**（`live.py`）：`klines()` 对分钟级 period 做 `_assert_klines_fresh`
  （`KLINE_STALE_MS=3min`，expected_latest_open_ms 按上海时段推算，午休回指 11:30、
  收盘回指 15:00、盘前/周末跳过）；停更 raise `STALE_DATA` 且不回写缓存。
  `snapshot()` 删除跨标的回退 `next(iter(collected.values()))`；`_daily_cache` 加
  60s TTL 且盘中不命中。`history_bars` wait 非 0 打日志。
- **消费端第二道闸**（`intraday-box.ts`）：`buildIntradayBox` 尾 bar 落后
  `KLINE_STALE_MS`(3.5min) → `no_trade/stale_klines`；ticker 与 lastClose 偏差
  超 `LAST_TOLERANCE`(0.5%) → 弃用 ticker 用 close。
- **IV 检疫**（`option-bar-ledger.ts`）：`quarantineIv` 区间 [0.01, 1.5]，逐值
  剔除；`tagIvRegime`/`buildBarContextPacket`/`atmIvPercentile`/`foldIvDaily`/
  `mergeReplayIvDaily`/`extractAtmIv`（option-overview）全部过闸。
- **链路修复**：新增 `fetchNearestChain`（expiries → 未到期最近月 → chain 带
  expiryMonth），`options-tools.ts` 与 `option-bar-agent.ts` 两处注入改用之；
  `quoteFillPriceWithSource` 拒绝 last=0/prevSettle=0；connector-options invoke 加
  `AbortSignal.timeout(30s)`。
- **复盘口径**：`shouldWriteDailyReview` 新增 `hasClosedBuckets`（当日 cycles 有
  ≥14:50 尾盘桶 = 盘收完）；close5 覆盖重写吸收最新打分，closed 仅首写。
  `foldDailyReview` 加 fills 参数，统计 `paper no_quote: N` 跳过行。
  iv-daily 折叠（幂等 last-wins）独立于复盘闸门，close5/closed 都折。

## Alternatives considered

- **只修网关不修消费端**：网关重启前旧数据仍在缓存/上游，第二道闸必须存在。
- **IV 离群整行剔除**：逐值检疫保留区间内的 nextAtmIv/hv20，信息量更大；event_front
  判定天然要求 atm+next 都在区间。
- **复盘 exists 判定保留旧口径**：无法区分"午夜空档"与"盘后首写"，尾盘桶是唯一
  可靠的"盘收完"信号。

## Consequences

- 网关修复需**重启 :5810 进程**才生效（活体验证：停更标的 `klines` limit=60 应报
  `STALE_DATA` 而非返回冻结数据）。
- `stale_klines` 进 `noTradeReason` 枚举（api type 扩展），T 板可显示停更原因。
- tick 偏差超 0.5% 时箱体 last 用 1m close 而非 tick（防串位，代价是 tick 实时性）。
- IV 合理区间上界 1.5（150% 年化）硬编码；若未来真实极端行情（如 2015）IV 超 1.5
  会被误剔——期权 ATM 深度值反解贴 5.0 上界是主因，宁可保守。
- Python 45 测试 + kit-cn 148 测试 + monorepo 116 文件 1068 测试全绿。
