# Agent Note: 可转债转股折价跟踪线（数据源 + 扫描 + 300s 台账）

Status: implemented

## Problem

第一梯队第二类机会：转股溢价率 < 0（转债价 < 转股价值 = 100/转股价×正股价）
时的买债→转股→T+1 卖股收敛。要求全市场覆盖、免费可得数据源、纯观察轨台账
（不动纸面账本——T+1 隔夜正股风险与摩擦模型先看分布再谈撮合）。约束：
连接器改动必须真网取证（AGENTS 铁律）；东财端点 ToS 为公开端点个人使用、不再分发。

## Decision

- **数据源**：扩展现有 `connector-akshare`（不新建包、不动 python/options——
  那是期权内核作用域）。TS 直连东财 `datacenter-web/api/data/v1/get`
  `RPT_BOND_CB_LIST`（复刻 akshare `bond_zh_cov` 底层 HTTP，pattern 抄
  `cn_get_sector_fund_flow`），分页 ≤5 页×500；仅保留存续
  （`DELIST_DATE` 空）且 债现价/正股价/转股价 三要素齐全行（'-'/null → 缺省）。
  spike 证据 `spikes/impl-akshare-cov/`：量纲逐位核对（转股价值可重算一致、
  溢价率单位=百分数）、退市判别字段确认、盘后 priced≈311/1000、负溢价 0 行。
- **api**：`CbQuoteRow` + MarketDataService 可选方法 `getCovSnapshot?()`
  （沿 getFundamentals?/getOrderbook? 可选方法惯例——未实现市场降级为「未提供」）。
- **扫描**（kit-cn `cb-discount.ts` 纯函数）：**一律重算**转股价值与溢价率，
  快照列偏差 >0.5% 判 stale 剔除（防「陈旧净值」伪影，同 last 价伪影教训）；
  闸 = 溢价 ≤ −1%（默认）+ 转债价 ≥ 70（避债底边缘）；输出费后净溢价
  （双边佣金近似 0.05%，可配）。已知限制：端点无成交额/换手 → 无流动性闸，
  台账记录不构成执行依据。
- **运行面**：工具 `cn_get_cb_quotes`（连接器注册）+ `cn_get_cb_discount_scan`
  （kit-cn 注册，lookupMarket 取数，provider 无能力时显式降级报错）；
  桥侧 30s tick 挂 300s 节流（`shouldRunCbScan` 纯函数）、仅 regular 会话、
  fire-and-forget，落 `data/options/cb/<date>.jsonl`（每轮一行计数 + top10，
  gitignore）。**路由现实**：cn 行情单激活（docs/exchange-routing.md），
  active 为 iquant 时无 getCovSnapshot → 每日一条能力缺失通知行（不洪水），
  要启用转债线需把 cn provider 路由到 akshare。

## Alternatives considered

- **进 python/options 网关**：该网关是期权内核（registry/underlyings 全期权域），
  塞转债破坏作用域——弃。
- **新建 connector-cb 包**：连接器是数据面概念，转债不进行情 router——
  扩展现有 akshare 连接器最薄。
- **盘口逐券补流动性**（push2 千次请求）：先跑分布，流动性闸列为后续。

## Impact

- connector-akshare 7 用例、kit-cn cb-discount 8 用例全绿；复盘「套利跟踪」
  节新增转债行（扫描轮数/错误/stale/最深溢价/命中轮）。
- 09-18 验收锚点：cn 路由在 akshare 时 `data/options/cb/` 首轮台账；
  iquant 路由下每日能力缺失行清晰可见（显式优于静默）。
