# @dshtrading/connector-tencent

> **状态：已实证（本出口可用）**。2026-08-31 实测：报价（qt.gtimg.cn）与日/周/月 K（web.ifzq.gtimg.cn fqkline）从本开发出口均可返回真实数据，cn（贵州茅台）真实网络验证 PASS，证据 `spikes/impl-cn-hk/REPORT.md` 与 `r1/r2/r3-*` 原始文件。

dsh-trading **cn 市场切片**行情连接器：经腾讯公共行情端点实现 `@dshtrading/api` 的 `MarketDataService` 契约，并提供 `cn_get_ticker` / `cn_get_klines` / `cn_place_order` 三工具（下单三段闸门与其它 cn 连接器同构）。

## 挂载形态

- Config 键 `market: 'cn'`（单市场固定）；插件名为 `dsh-trading-tencent`；
- cn-trader preset 行 id `dsh-trading-cn-connector` 挂载本包，provide `tradingCnMarketData` + 注册 `cn_get_ticker/cn_get_klines/cn_place_order`；
- isolate 组键 = 服务名（preset 挂载硬规则）。
- 历史注记：本包原为 cn/hk 单包双市场多实例模式（手册 §8），2026-09-08 市场收敛为 cn-only 时拆除 hk 分流（hk 半随 `@dshtrading/hk` 删除）。

## 已知局限（实现时已内置）

- 报价响应为 **GBK 编码**，客户端用 `TextDecoder('gbk')` 解码（Node 全 ICU 内置）；
- cn 成交量单位是**手**（×100 归一到股）；
- K 线行字段序是**开收高低量**；支持 interval = 1d/1w/1M（前权 qfq）与分钟线（mkline）。

## 合规记录（README 铁律 #5）

**腾讯公共行情端点：公开、无 key、无官方授权；个人使用边界自负**，以腾讯服务条款为准。本仓不缓存、不批量抓取、不再分发行情数据。腾讯不提供交易 API——live 下单路径恒为 `TRADING_NOT_IMPLEMENTED`（券商 API 是后续任务）。
