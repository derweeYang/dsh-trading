/**
 * 期权纸账户（多账本）视图词汇与派生量（2026-09-13 WB-15）。
 *
 * 交接口径见 `docs/workbuddy-handoff-2026-09-13-option-paper-books.md`：
 * **交接面 = 桥 JSON，账本逻辑全部在后端，前端只读展示**。因此本模块
 * 刻意**不含任何金额运算**——`cash` / `equity` / `realizedPnl` / `premiumCny` /
 * `marginCny` 一律直接展示；唯一算的是收益率 `(equity − initialCash) / initialCash`
 * （交接单 §C2 明确要求的展示派生量）。
 *
 * 关键口径（交接单 §B2 词汇表）：`asset:'spot'` 的腿 `qty` 是 **ETF 份**，
 * 期权腿是**张**。两者不能同列相加——本模块只出「数值 + 单位键」，不做换算，
 * 免得把「1 张 = 10000 份」的乘数在 UI 层再实现一遍（后端已算好 `premiumCny`）。
 *
 * 闭集枚举（账本 id / 套利方向 / 成交原因 / 价格来源）走 `satisfies`
 * 让缺项在编译期就红；模板名是**开集**（strategy 账本沿用推荐模板，套利账本
 * 是 parity/box），故模板映射返回 `undefined` 让调用方如实回退原文，
 * 不硬造一个「其他」标签把未知说成已知。
 */
import type { MarketLocaleKey } from './contract.ts'
import type {
  OptionArbitrageDirection, OptionPaperBookId, OptionPaperPriceSource, PaperFillReason, PaperLegFill, PaperPosition,
} from '@dshtrading/api'
import { TEMPLATE_KEY } from './option-vocabulary.ts'

/** 账本名（卡片标题 + 成交流水过滤 chips 共用）。 */
export const BOOK_KEY = {
  strategy: 'trade.optPaper.book.strategy',
  arbitrage: 'trade.optPaper.book.arbitrage',
} as const satisfies Record<OptionPaperBookId, MarketLocaleKey>

/**
 * 账本渲染序（期权账户页签的卡片、成交流水 chips、汇总页签的子账户行共用）——
 * 桥按该序列回，UI 也按该序排，缺账本时跳过而不是补桩。
 */
export const OPTION_BOOK_ORDER: readonly OptionPaperBookId[] = ['arbitrage', 'strategy']

/** 套利结构名（`PaperPosition.template` 在套利账本是 'parity' | 'box'）。 */
export const ARB_TEMPLATE_KEY: Readonly<Record<'parity' | 'box', MarketLocaleKey>> = {
  parity: 'trade.optPaper.template.parity',
  box: 'trade.optPaper.template.box',
}

/**
 * 纸账户持仓模板 → 词典键。闭集（推荐模板）与套利结构各查一张表，
 * 都不命中 → undefined（调用方以等宽原文展示，不编标签）。
 */
export function paperTemplateKey(template: string | undefined): MarketLocaleKey | undefined {
  if (template === undefined || template === '') return undefined
  if (template === 'parity' || template === 'box') return ARB_TEMPLATE_KEY[template]
  const known = (TEMPLATE_KEY as Record<string, MarketLocaleKey | undefined>)[template]
  return known
}

/** 套利方向（持仓键方向无关，方向只作展示语义）。 */
export const ARB_DIRECTION_KEY = {
  buy_synthetic_sell_spot: 'trade.optPaper.direction.buy_synthetic_sell_spot',
  sell_synthetic_buy_spot: 'trade.optPaper.direction.sell_synthetic_buy_spot',
  long_box: 'trade.optPaper.direction.long_box',
  short_box: 'trade.optPaper.direction.short_box',
} as const satisfies Record<OptionArbitrageDirection, MarketLocaleKey>

/** 套利方向 → 词典键；旧持仓无该维度 → undefined（不出徽章）。 */
export function arbDirectionKey(direction: string | undefined): MarketLocaleKey | undefined {
  if (direction === undefined || direction === '') return undefined
  return (ARB_DIRECTION_KEY as Record<string, MarketLocaleKey | undefined>)[direction]
}

/** 成交原因（strategy 账本 + arbitrage 账本并集；`skipped` 是 strategy 的 qty=0 桩）。 */
export const REASON_KEY = {
  signal: 'trade.optPaper.reason.signal',
  invalidIf: 'trade.optPaper.reason.invalidIf',
  close5: 'trade.optPaper.reason.close5',
  session: 'trade.optPaper.reason.session',
  skipped: 'trade.optPaper.reason.skipped',
  arb_open: 'trade.optPaper.reason.arb_open',
  arb_converge: 'trade.optPaper.reason.arb_converge',
  arb_reverse: 'trade.optPaper.reason.arb_reverse',
  arb_expiry: 'trade.optPaper.reason.arb_expiry',
} as const satisfies Record<PaperFillReason, MarketLocaleKey>

/** 成交原因 → 词典键；未知值回退 em-dash（旧账本可能带新枚举）。 */
export function paperReasonKey(reason: string | undefined): MarketLocaleKey | undefined {
  if (reason === undefined || reason === '') return undefined
  return (REASON_KEY as Record<string, MarketLocaleKey | undefined>)[reason]
}

/**
 * 成交原因的展示分档（决定徽标配色，不是业务语义）：
 * `open` 建仓 / `converge` 套利边收敛平 / `reverse` 套利边反转平 /
 * `expiry` 到期强平 / `close` 策略侧平仓 / `skip` qty=0 桩。
 *
 * 分档存在的理由：到期强平与破位平仓在盈亏上可能同色，但一个是「计划内到期」、
 * 一个是「信号失效」，视觉上不该混成一类——混了就看不出账本为什么在动。
 */
export type PaperReasonKind = 'open' | 'converge' | 'reverse' | 'expiry' | 'close' | 'skip'

export function paperReasonKind(reason: string | undefined): PaperReasonKind | undefined {
  switch (reason) {
    case 'signal':
    case 'arb_open':
      return 'open'
    case 'arb_converge':
      return 'converge'
    case 'arb_reverse':
      return 'reverse'
    case 'arb_expiry':
      return 'expiry'
    case 'invalidIf':
    case 'close5':
    case 'session':
      return 'close'
    case 'skipped':
      return 'skip'
    default:
      return undefined
  }
}

/** 开 / 平。 */
export const OFFSET_KEY = {
  open: 'trade.optPaper.offset.open',
  close: 'trade.optPaper.offset.close',
} as const satisfies Record<'open' | 'close', MarketLocaleKey>

/** 成交价来源（旧行缺省 → 不出徽章，不假设成 last）。 */
export const PRICE_SOURCE_KEY = {
  last: 'trade.optPaper.price.last',
  prev_settle: 'trade.optPaper.price.prev_settle',
  pick: 'trade.optPaper.price.pick',
  bid: 'trade.optPaper.price.bid',
  ask: 'trade.optPaper.price.ask',
  spot: 'trade.optPaper.price.spot',
} as const satisfies Record<OptionPaperPriceSource, MarketLocaleKey>

/** 腿单位键：期权腿按「张」，现货腿按「份」（转换由后端完成，前端不乘乘数）。 */
export function legUnitKey(leg: PaperLegFill): MarketLocaleKey {
  return leg.asset === 'spot' ? 'trade.optPaper.unit.share' : 'trade.optPaper.unit.contract'
}

/** 现货腿判定（缺省 = option，与 @dshtrading/api 一致）。 */
export function isSpotLeg(leg: PaperLegFill): boolean {
  return leg.asset === 'spot'
}

/**
 * 收益率 = (equity − initialCash) / initialCash。initialCash 非正 → undefined
 * （旧文件理论不可达，但除以 0/负数会给出误导性的百分比，宁可不出）。
 */
export function bookReturnRatio(initialCash: number, equity: number): number | undefined {
  if (!Number.isFinite(initialCash) || initialCash <= 0 || !Number.isFinite(equity)) return undefined
  return (equity - initialCash) / initialCash
}

/** 上证日历日序号（UTC+8 整日），用于到期天数——不依赖运行环境时区。 */
export function shanghaiDayIndex(ms: number): number {
  return Math.floor((ms + 8 * 3_600_000) / 86_400_000)
}

/**
 * 距到期自然日（含今日则 0，已过期为负）。日期串非 `YYYY-MM-DD` → undefined
 * （不猜，不出「临期」高亮）。
 */
export function expiryDaysLeft(expiryDate: string | undefined, nowMs: number): number | undefined {
  if (expiryDate === undefined) return undefined
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiryDate.trim())
  if (matched === null) return undefined
  const due = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])) / 86_400_000
  if (!Number.isFinite(due)) return undefined
  return due - shanghaiDayIndex(nowMs)
}

/** 临期阈值（自然日）：≤ 3 天高亮（交接单 §C3）。 */
export const OPTION_PAPER_EXPIRING_DAYS = 3

/** 是否临期（≤ days 天且未过期；已过期单独由 `expiryDaysLeft < 0` 表达）。 */
export function isExpiringSoon(
  expiryDate: string | undefined,
  nowMs: number,
  days: number = OPTION_PAPER_EXPIRING_DAYS,
): boolean {
  const left = expiryDaysLeft(expiryDate, nowMs)
  return left !== undefined && left >= 0 && left <= days
}

/**
 * 行权价展示：parity = 单值；box = `K1–K2`（升序，交接单 §C3）。
 * 缺 `strikes` → undefined（不出列值，不拿 boxLow/boxHigh 之外的东西补）。
 */
export function strikeLabel(position: PaperPosition): string | undefined {
  const strikes = position.strikes
  if (strikes === undefined || strikes.length === 0) return undefined
  if (strikes.length === 1) return String(strikes[0])
  return String(strikes[0]) + '–' + String(strikes[strikes.length - 1])
}

/** 持仓行稳定键（无 id 时回落 underlying+template，避免列表抖动）。 */
export function positionRowKey(position: PaperPosition): string {
  return position.id !== '' ? position.id : `${position.underlying}:${position.template}:${position.openedBucketStart}`
}

/** 成交行稳定键（同 id 可能跨账本复用，拼账本前缀）。 */
export function fillRowKey(book: OptionPaperBookId, id: string, index: number): string {
  return `${book}:${id}:${String(index)}`
}
