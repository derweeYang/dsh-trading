# ETF ↔ 期权互联桥契约（阶段 4 后端半）

- 日期：2026-09-08
- 状态：implemented
- 关联 spec：`docs/specs/2026-09-08-refactor-cn-focus.md` 阶段 4
- 提交：`feat(api,kit-cn,client-ui-trading,python-options): option underlying link + holding-aware strategies`

## Problem

期权 T 板与 ETF 现货页是两座孤岛：T 板不知道标的现价（ATM 高亮无从谈起）、
现货页跳不到期权、备兑组合视角无法按真实持仓预填现货腿、名册看不到
「哪些标的我有底仓」。

## Decision

1. **现价拼接在桥侧做**：`GET /options/chain` 装配后从 `tradingCnMarketData`
   拉标的 ticker 覆盖 `chain.spot`。现货符号经名册交易所推导（SSE→.SH /
   SZSE→.SZ）；行情缺席/抛错/SYNTH 标的一律保留 python 链自带 spot，不阻塞 T 板。
2. **resolve 是纯本地规范化**：`GET /options/resolve?symbol=` 长代码 ↔ 现货
   双向解析（正则与 connector-options rest.ts / python synth.parse_long_code
   三方对齐，strike=5 位编码÷1000）；名册命中才给 `UnderlyingLink`
   （spotSymbol/callPrefix/putPrefix），名册外 6 位码仍返回规范化 underlying。
   桥不依赖 connector-options 包（桥只面向服务缝），正则复制 + 行为测试锁。
3. **holdingQty 语义 = 份额推张数**：python `_apply_holding_qty` 对
   covered_call/collar 写 `qty = floor(holdingQty/multiplier)` 进 templateParams，
   现货腿（qty×multiplier）与期权腿（qty）自动匹配；不足 1 张、非正数、
   非备兑模板一律 BAD_REQUEST 显式拒绝。桥/agent 工具只校验正数后透传。
4. **heldQty 聚合在名册响应**：`GET /options/underlyings` 从台账聚合同标的
   份额（cn 市场 symbol 去 .SH/.SZ 后缀求和，多账户/裸码均计）；聚合失败
   不阻塞名册；无持仓条目保持键缺席（exactOptionalPropertyTypes）。

## Alternatives considered

- 桥直接依赖 connector-options 的 normalizeCnUnderlying——放弃：桥只面向
  服务缝（host 注入），引连接器实现包会破坏分层；改用本地正则 + 测试锁。
- spot 回填放进 connector-options（服务缝内做）——放弃：现价来自
  tradingCnMarketData（另一条服务缝），桥是两条缝唯一交汇处。
- holdingQty 直接指定张数——放弃：用户台账记的是份额（ETF 份），份额→张数
  换算（÷multiplier 向下取整）是领域规则，应内聚在 python 内核一处。

## Consequences

- T 板 ATM 高亮、现货↔期权双向跳转、备兑/领口按真实底仓预填的桥契约齐备，
  workbuddy 前端可开工（交接文档引用本次端点形状）。
- 长代码解析正则现存三份（bridge / connector-options / python），靠行为测试
  锁一致；后续若加新标的规则，三处同改。
- 名册响应的 heldQty 依赖 holdings 服务挂载；headless 部署键缺席，前端按空处理。
