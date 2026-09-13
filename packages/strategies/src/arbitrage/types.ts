/**
 * ETF 期权套利策略模块 —— 纯函数类型契约（零运行时依赖，浏览器可打包）。
 *
 * 设计要点：
 * - 输入用本地最小类型 ArbitrageChain，故意不依赖 @dshtrading/api 的 OptionChain，
 *   以保持纯库的零运行时依赖；适配器 fromOptionChain() 负责从后端 OptionChain 转换。
 * - 所有金额为「元/股」(per share)，edgePerContract 已乘合约乘数（默认 10000）。
 * - executable=false 表示仅用 last/prevSettle 估算（无买卖盘），需以可成交价复核后才可下单。
 */

export type OptionRight = 'C' | 'P'

/** T 型报价一行（镜像 api.OptionQuoteRow 的相关字段，扩展 bid/ask 以支持可执行边界）。 */
export interface ArbitrageQuoteRow {
  readonly code: string
  readonly strike: number
  readonly last?: number
  readonly prevSettle?: number
  readonly bid?: number
  readonly ask?: number
}

/** 单标的单到期月期权链（套利模块的输入）。 */
export interface ArbitrageChain {
  readonly underlying: string
  readonly expiryMonth: string
  readonly expiryDate?: string
  readonly asOf?: string
  readonly spot?: number
  readonly multiplier?: number
  readonly calls: readonly ArbitrageQuoteRow[]
  readonly puts: readonly ArbitrageQuoteRow[]
}

export type ArbitrageKind = 'parity' | 'box'

export type ArbitrageDirection =
  | 'buy_synthetic_sell_spot'
  | 'sell_synthetic_buy_spot'
  | 'long_box'
  | 'short_box'

export interface ArbitrageLeg {
  readonly code: string
  readonly right: OptionRight
  readonly action: 'buy' | 'sell'
  readonly strike: number
}

export interface ArbitrageOpportunity {
  readonly kind: ArbitrageKind
  readonly underlying: string
  readonly expiryMonth: string
  /** parity：配对的行权价 */
  readonly strike?: number
  /** box：低/高行权价 */
  readonly lowStrike?: number
  readonly highStrike?: number
  /** 元/股（边界或中间价幅度） */
  readonly edgePerShare: number
  /** 元/张 = edgePerShare × multiplier */
  readonly edgePerContract: number
  readonly direction: ArbitrageDirection
  readonly legs: readonly ArbitrageLeg[]
  readonly note: string
  /** 仅用中间价估算（无买卖盘）时为 false，需以可成交价复核 */
  readonly executable: boolean
}
