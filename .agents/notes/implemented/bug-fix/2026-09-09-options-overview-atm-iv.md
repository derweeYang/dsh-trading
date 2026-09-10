# Agent Note: 总览默认回填近月 ATM IV（iQuant 无历史分位）

Status: implemented

## Problem

本机 `~/.dsh/settings.yaml` 把 `dshtrading.markets.cn.provider` 钉成 `tencent`，覆盖了
router 默认的 `iquant`。期权总览机会卡同时报「IV 缺失」：① 前端默认 `includeIv=0`
（切 IV 排序才打九路 `vol_analytics`）；② 即便打开，`extractIvPercentile` 只认
`iv_percentile` 对象，python 活牌给的是 `ivPercentile` 行数组；③ iQuant 明确没有
历史 IV 路径，分位行一律 `insufficient`。活牌仍能反解近月 ATM IV。

## Decision

- 本机设置改回 `cn.provider: iquant`（GUI 注册表按请求解析，热切换）。
- `OptionOverviewRow` 增加 `atmIv`（年化 0–1）。总览默认走 `implied_vol`（先 `last`
  再 `prevSettle`），进程内缓存 5 分钟；`includeIv=1` 仍只负责历史分位。
- `extractIvPercentile` 同时认 camelCase 行数组（`status=ok`，0–100 归一到 0–1）。
- 机会卡 / 明细表 IV 列：`ivPercentile ?? atmIv`；有 `atmIv` 时不再打「IV 缺失」，
  也不把年化 IV 当成分为位高低。解读另写「近月 ATM IV」，标明不是历史分位。

## Alternatives considered

- **默认 `includeIv=1` 打九路 vol_analytics**：会打爆网关，且 iQuant 分位仍是
  `insufficient`。败。
- **把 ATM IV 写进 `ivPercentile`**：0.22 年化会被 UI 当成 22 分位（偏低）。败。
- **只改设置、把 IV 交给 workbuddy**：卡上仍是盲区。用户要求当场补 IV。

## Consequences

- 总览首屏会多九路（缓存后每 5 分钟）`implied_vol`；失败按行缺席。
- iQuant 的 `ivPercentile` 仍然经常缺席；IV 排序在只有 `atmIv` 时按近月 ATM 排。
- 改 `cn.provider` 后 agent 面连接器仍须新建会话才切换（既有 restart 语义）。
- 盘后 `implied_vol` 曾整页空：`fetch_spot` 只信 2s snapshot，`NO_DATA` 被桥吞掉。
  现货现与 iquant-quote `ticker` 对齐——snapshot 空或 `last=0` 回落日 K 收盘。
  合约 T 板本身已有日 K 回落；缺的是标的现货。改完须重启 `:8090`。
- 桥把失败的 `atmIv` 也缓存 5 分钟，网关刚恢复仍是空。缺席改为 30 秒 TTL。
