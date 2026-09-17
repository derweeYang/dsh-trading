# impl-akshare-cov：可转债全市场快照（东财 datacenter RPT_BOND_CB_LIST）

母变更：connector-akshare 扩展 `getCovSnapshot()` + 工具 `cn_get_cb_quotes`（转债转股折价跟踪线的数据源）。
真网验证铁律（AGENTS.md：连接器改动另需真实网络验证，spikes/impl-*/ 留原始响应证据）——本目录即证据。

## 端点与抓取

- URL：`https://datacenter-web.eastmoney.com/api/data/v1/get`
- 关键参数：`reportName=RPT_BOND_CB_LIST`、`columns=ALL`、`pageSize=500`（分页）、
  `quoteColumns` 携带实时列（正股价 f2@CONVERT_STOCK_CODE / 转股价 f235 / 转股价值 f236 /
  债现价 f2@SECURITY_CODE / 转股溢价率 f237）、`source=WEB&client=WEB`
- 复刻对象：`akshare.bond_zh_cov()`（同端点同参数；TS 侧直连不复刻 DataFrame 清洗）
- 抓取时间 / 出网：见 `fetch-timestamp.txt`（本机直连，UA `Mozilla/5.0`，无鉴权）
- 复现：`python -X utf8 fetch_cov.py`（写 p1/p2 全量原始 JSON）；本文物只保留了
  **verbatim 切片**（首 30 行 + 完整信封 pages/count），全量文件过大不入库

## 结构性断言（不锚定行情数值）

- 全量验证（2026-09-17 盘后）：`pages=3 count=1053`，p1+p2 共 1000 行
- 关键列全部存在：`SECURITY_CODE / SECURITY_NAME_ABBR / CONVERT_STOCK_CODE /
  CONVERT_STOCK_PRICE / TRANSFER_PRICE / TRANSFER_VALUE / CURRENT_BOND_PRICE /
  TRANSFER_PREMIUM_RATIO`
- 量纲核对（verify_fields.py，逐位一致）：转股价值 = `100/转股价 × 正股价`；
  转股溢价率单位 = **百分数**（45.5 = 45.5%），重算 `(债现价−转股价值)/转股价值×100` 一致
- 存续/退市判别（check_status_fields.py）：**`DELIST_DATE`**——退市行（强赎/到期摘牌）带日期，
  存续行为 null；退市行 `TRANSFER_PRICE/CURRENT_BOND_PRICE` 亦为 null
- 无报价形态：未上市新券与退市券的价列为 `'-'` 或 `null`（盘后快照 priced≈311/1000，
  其中退市与未上市占绝大多数；负溢价 0 行）

## ToS / 边界

- 东财公开端点、无官方授权，个人使用边界自负（与仓库既有 push2/腾讯端点同口径）
- 铁律 #4：market data 只为本机消费拉取，不缓存再分发；本目录仅保留验证所需切片证据

## 已知限制（消费方须知）

- 本端点**无成交额/换手字段** → 转债折价扫描现阶段无流动性闸，台账记录为准不做执行依据
- `TRANSFER_VALUE / TRANSFER_PREMIUM_RATIO` 是快照列，可能与正股 tick 不同拍——
  扫描层必须重算核对（偏差过大剔除该行，防「陈旧净值」伪影）
