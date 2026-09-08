# 期权交易契约与双闸执行（阶段 3）

- 日期：2026-09-08
- 状态：implemented
- 关联 spec：`docs/specs/2026-09-08-refactor-cn-focus.md` 阶段 3（3.1 契约扩展 / 3.2 连接器交易半 / 3.3 内核上桥）
- 提交：`feat(api,connector-options,kit-cn,client-ui-trading): option trading contract + dual-gate execution`

## Problem

期权此前只有只读行情面（tradingCnOptions → python/options 网关），没有交易契约：
T 板看到合约却下不了单、看不到期权持仓；python 内核的 vol_analytics /
underlying_daily / price / parity_check 四个命令也未暴露给 agent 与 GUI。重构目标
要求期权与普通 A 股交易同等重要，且真实下单必须沿用全仓铁律 #3 的 dryRun +
liveTrading 双闸。

## Decision

1. **契约先行（api）**：`OptionOrderRequest`/`OptionOrder`/`OptionPosition` 以期权
   长代码（`510050C2609M02850`）为主键；`quantity` 单位=张，`premiumAmount` =
   price × quantity × multiplier(10000)。`CnOptionsTradeService` 三方法
   （place/cancel/listOptionPositions）走 Context 键 `tradingCnOptionsTrade`。
   OptionStrategyResult 从 `result: unknown` 弱类型草稿改为强类型（legs/payoff/
   greeks/margin 逐块），grep 证实无消费方引用旧形状，安全对齐 python 扁平返回。
2. **交易半三态闸门（connector-options）**：与 connector-qmt 同构——入参规范化
   （长代码/正整数张数/limit 正价）先于闸门；`dryRun` 缺省 true → 本地模拟回执
   （含 premiumAmount）；请求实盘但 `liveTrading=false` →
   TRADING_LIVE_TRADING_DISABLED fail-closed；live 需 config 双开 + 请求
   dryRun=false → QMT 网关期权通道。撤单与真实下单同门槛，防绕过。
3. **QMT 端点契约由 TS 侧定义**：POST /api/v1/trade/option/order、/cancel、GET
   /positions；option_code 传长代码，挂牌代码映射留在网关侧（MiniQMT 分配代码
   不宜在 TS 写死）。
4. **GUI 桥语义与股票交易台一致**：POST /options/order 默认请求 dryRun: false
   （服务缝闸门兜底），桥只做形状校验（400）+ 如实转达错误。
5. **挂载位置**：preset 行（agent.cordis.yml 工具面）provide
   tradingCnOptionsTrade；host 面 dataplane 行维持只读 tradingCnOptions。
6. **内核上桥（kit-cn）**：4 个只读工具（cn_get_option_vol_analytics /
   cn_get_option_underlying_daily / cn_get_option_price / cn_option_parity_check）
   经 getService 惰性解析，报告 JSON 透传不解释。
7. **名册双源防漂移**：TS STATIC_ROWS.iquant 与 python underlyings.json 用同步
   校验测试锁全等。

## Alternatives considered

- GUI 下单默认 dryRun: true（更保守）——放弃：与 placeOrderFromGui 演化后的股票
  语义分叉，用户在 UI 的意图就是真实下单，安全由服务缝闸门统一兜底。
- TS 侧写死挂牌代码映射表——放弃：交易所分配随合约更替，映射属网关运行时知识。
- OptionStrategyResult 维持 unknown——放弃：阶段 4 组合视角（备兑/对冲）要读
  legs/margin 块，弱类型会把形状风险推到前端。

## Consequences

- 期权下单/撤单/持仓全链路可用（dry-run 缺省零风险，live 需两处显式开启）。
- python/options 补声明 volsurface 与 matplotlib 依赖（既有 6 失败的根因，
  SVI 校准与 PNG 图表路径恢复，169 passed）。
- 阶段 4 互联（spot 回填/resolve/holdingQty/T 板面板）可在此基础上推进；
  workbuddy 前端交接需覆盖 GuiOptionOrderBody 形状与 premiumAmount 换算。
