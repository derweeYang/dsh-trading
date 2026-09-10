# Agent Note: iv-daily 合约日线回放种子

Status: implemented

## Problem

总览 IV 分位要满 60 个交易日的 `iv-daily.jsonl`。活牌 `implied_vol` 拒绝 `asOf`，iquant/akshare 没有历史 IV 字段，本机又只有当天几行，点「IV 分位」只能空转。

## Decision

新增内核子命令 `replay_atm_iv`（`source=synth|iquant`）：对每个交易日在**当前合约清单**里选剩余期限 ≤ `maxTermDays`（缺省 45）的近月，取距现货最近的行权价，用 **C/P 日线收盘** 走本库 BSM 反演，平均已收敛 IV，并按近 21 根现货收盘写 `hv20`。iquant 合约日线用 `shortCode` + `SHO`/`SZO`。

写入 `iv-daily.jsonl` 走 `mergeReplayIvDaily`：**已有 date+underlying 占主**（packet / 日终不覆盖）。项目入口 `scripts/seed-iv-daily.mjs` POST 本机 options 网关，不把回放挂进 60s 总览轮询。akshare 不接（已到期月代码是登记缺口）。

`vol_analytics` 活牌分位仍标 `insufficient`；总览本机分位只读 `iv-daily`。

## Alternatives considered

- **给 implied_vol 开 asOf**：T 板没有历史截面，会编造。败。
- **每桶 / includeIv 打 vol_analytics**：打爆网关且分位仍 insufficient。败。
- **Wind/东财现成 IV 列灌进 iv-daily**：与本库 ATM 反演口径漂移。败。
- **用已上市远月填摘牌近月**：期限结构混进「近月 ATM」序列。败——用 maxTermDays 直接跳过。

## Consequences

首次种子通常只有「最近一个未摘牌近月」覆盖的交易日（往往十几到四十天），不是满 60。摘牌月补不回来，只能继续日终 append。脚本依赖 `:8090` 与 iquant-quote live。不改 client 半。
