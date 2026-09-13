/**
 * 子账户汇总（2026-09-14）——把「总资产」从「股票持仓市值合计」升级为
 * 「**每个子账户**的资产合计」：股票三源（模拟 / 实盘 / 真实导入）
 * + 期权双账本（策略 / 套利，各 ¥10 万初始资金，由宿主心跳驱动）。
 *
 * 为什么另起纯函数而不塞进 `aggregateHoldings`：两者口径不同且**都要保留**——
 * `aggregateHoldings` 管「持仓 → 明细 / 按标的汇总 / 盯市」，本模块管
 * 「账户 → 各账户资产额」。期权账本**没有**可参与盯市的 symbol 级明细
 * （它的 `equity` 是后端按 cash + 占用保证金返还 + 腿盯市算好的），塞进去会把
 * 两种记账混成一锅。两者唯一的合并点就是「总资产」这一个数。
 *
 * **口径差异必须在 UI 标注，不能假装同质**：
 * - 股票侧 `basis: 'holdings'` —— Σ 该来源持仓的**折算市值**。本地 paper 账本的
 *   现金不进入明细行，沿用既有语义（本次不引入现金口径，避免半吊子）；
 * - 期权侧 `basis: 'equity'` —— 后端 `equity`（现金 + 占用保证金 + 腿盯市），
 *   CNY 计价 → 经 fx 折算到基准币；缺 CNY 汇率则进未折算分区，**不计入总资产**。
 */
import type { OptionPaperBookId, OptionPaperBookWire } from '@dshtrading/api'
import type { MarketLocaleKey } from './contract.ts'
import type { CurrencySubtotal, HoldingsAggregation } from './holdings-aggregate.ts'
import type { FxSnapshot, PositionOrigin } from './holdings-types.ts'
import { BOOK_KEY, OPTION_BOOK_ORDER } from './option-paper-view.ts'
import { convertCnyToBase } from './position-rounds.ts'

/** 子账户两大类：股票侧按来源、期权侧按账本。 */
export type SubAccountKind = 'stock' | 'option'

/**
 * 资产口径。UI 要据此标注「这个数含不含现金」——期权账本是含现金的权益，
 * 股票侧是纯持仓市值，两者不可直接对比。
 */
export type SubAccountBasis = 'holdings' | 'equity'

export interface SubAccountRow {
  /** 稳定键：`stock:<origin>` / `option:<book>`。 */
  readonly id: string
  readonly kind: SubAccountKind
  readonly basis: SubAccountBasis
  readonly labelKey: MarketLocaleKey
  /** 持仓数（股票侧 = 该来源行数；期权侧 = 该账本持仓数）。 */
  readonly count: number
  /** 折算到基准币的资产额；未折算时为 0（金额进 unconverted）。 */
  readonly amountBase: number
  readonly converted: boolean
  /** 未折算分区（缺汇率 / 缺币种）。 */
  readonly unconverted: readonly CurrencySubtotal[]
}

export interface SubAccountsAggregation {
  readonly rows: readonly SubAccountRow[]
  /** 总资产 = Σ 已折算子账户（未折算分区不计入，与 aggregateHoldings 同语义）。 */
  readonly totalBase: number
  /** 存在未折算子账户或 FX 过期 → 总资产为近似值。 */
  readonly approximate: boolean
  /** 全量未折算分区（跨子账户合并，按币种聚合）。 */
  readonly unconverted: readonly CurrencySubtotal[]
  /** 至少一个期权账本已计入（UI 据此决定是否显示口径脚注）。 */
  readonly hasOptionAccounts: boolean
}

/** 与 `HoldingsPanel.ORIGIN_BADGE_KEY` 同值（两边各自受 `Record<PositionOrigin, …>` 约束）。 */
const ORIGIN_LABEL_KEY: Record<PositionOrigin, MarketLocaleKey> = {
  paper: 'trade.holdings.badge.paper',
  live: 'trade.holdings.badge.live',
  imported: 'trade.holdings.badge.imported',
}

/**
 * 子账户汇总主入口。行序 = 股票三源（`byOrigin` 的 paper/live/imported 固定序）
 * + 期权账本（`OPTION_BOOK_ORDER`，与期权账户页签同序）。
 *
 * 期权账本按桥返回的 `equity` 原样消费，**不在前端重算**（腿乘数与费用口径都在
 * 后端，再算一遍就是把口径搞错——见交接单 §B2）。
 */
export function aggregateSubAccounts(
  holdings: HoldingsAggregation,
  optionBooks: readonly OptionPaperBookWire[],
  fx: FxSnapshot | undefined,
): SubAccountsAggregation {
  const rows: SubAccountRow[] = holdings.byOrigin.map(sub => ({
    id: `stock:${sub.origin}`,
    kind: 'stock',
    basis: 'holdings',
    labelKey: ORIGIN_LABEL_KEY[sub.origin],
    count: sub.count,
    amountBase: sub.totalBase,
    converted: true,
    unconverted: sub.unconverted,
  }))

  const byBook = new Map<OptionPaperBookId, OptionPaperBookWire>()
  for (const book of optionBooks) byBook.set(book.book, book)

  let hasOptionAccounts = false
  for (const id of OPTION_BOOK_ORDER) {
    const book = byBook.get(id)
    if (book === undefined) continue
    hasOptionAccounts = true
    const amountBase = convertCnyToBase(book.equity, fx)
    rows.push({
      id: `option:${id}`,
      kind: 'option',
      basis: 'equity',
      labelKey: BOOK_KEY[id],
      count: book.positions.length,
      amountBase: amountBase ?? 0,
      converted: amountBase !== undefined,
      unconverted: amountBase === undefined ? [{ currency: 'CNY', amount: book.equity }] : [],
    })
  }

  // 跨子账户合并未折算分区（同币种累加），币种代码升序。
  const unconvertedMap = new Map<string, number>()
  let totalBase = 0
  for (const row of rows) {
    totalBase += row.amountBase
    for (const item of row.unconverted) {
      unconvertedMap.set(item.currency, (unconvertedMap.get(item.currency) ?? 0) + item.amount)
    }
  }
  const unconverted = [...unconvertedMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }))

  return {
    rows,
    totalBase,
    approximate: holdings.approximate || unconverted.length > 0,
    unconverted,
    hasOptionAccounts,
  }
}
