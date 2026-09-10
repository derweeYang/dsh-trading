/**
 * 期权状态词汇 → 词典键（2026-09-09 WB-3/WB-6）。
 *
 * 箱体状态机（regime / session / noTradeReason / calibration / verdict / 模板名）
 * 是**闭集**，且 T 板箱体条与闭环时间线两处都要渲染。集中一处避免两处各写一份
 * 映射——漂移时只会「一处漏翻」，而这类漏翻在 UI 上就是直接露出英文枚举值。
 *
 * 值全部是 `@dshtrading/api` 的联合字面量，用 `satisfies` 让缺项在编译期就红。
 */
import type { MarketLocaleKey } from './contract.ts'
import type { CycleTier } from './cycle-rank.ts'
import type {
  OptionCycleVerdict, OptionIntradayCandidate, OptionIntradayRegime, OptionIntradaySession,
  OptionIvRegime,
} from '@dshtrading/api'

/** 箱体状态机（no_trade 时无箱沿、candidates 为空）。 */
export const REGIME_KEY = {
  range_hold: 'options.cycle.regime.range_hold',
  mean_revert: 'options.cycle.regime.mean_revert',
  breakout: 'options.cycle.regime.breakout',
  vol_expand: 'options.cycle.regime.vol_expand',
  no_trade: 'options.cycle.regime.no_trade',
} as const satisfies Record<OptionIntradayRegime, MarketLocaleKey>

/**
 * 会话门 / 不出箱原因共用一张表：`noTradeReason` 的类型是
 * `OptionIntradaySession | 'insufficient' | 'calibrated'`（见 @dshtrading/api）。
 */
export const SESSION_REASON_KEY = {
  regular: 'options.cycle.session.regular',
  open15: 'options.cycle.session.open15',
  lunch: 'options.cycle.session.lunch',
  close5: 'options.cycle.session.close5',
  closed: 'options.cycle.session.closed',
  insufficient: 'options.cycle.reason.insufficient',
  calibrated: 'options.cycle.reason.calibrated',
} as const satisfies Record<OptionIntradaySession | 'insufficient' | 'calibrated', MarketLocaleKey>

/** 上桶评估结论（下一桶才补；未补 = pending，不是 skipped）。 */
export const VERDICT_KEY = {
  hit: 'options.cycle.verdict.hit',
  partial: 'options.cycle.verdict.partial',
  miss: 'options.cycle.verdict.miss',
  skipped: 'options.cycle.verdict.skipped',
} as const satisfies Record<OptionCycleVerdict, MarketLocaleKey>

/** 连续 miss 后的箱沿校准状态。 */
export const CALIBRATION_KEY = {
  none: 'options.cycle.calibration.none',
  widened: 'options.cycle.calibration.widened',
  suppressed: 'options.cycle.calibration.suppressed',
} as const satisfies Record<'none' | 'widened' | 'suppressed', MarketLocaleKey>

/**
 * 机会档位徽章（WB-10）：最强 / 最弱 / 中位。
 * `rest` 没有档位含义（既非两端也非中位），不出徽章——不出比贴个误导标签强。
 */
export const TIER_KEY = {
  strong: 'options.cycle.tier.strong',
  weak: 'options.cycle.tier.weak',
  median: 'options.cycle.tier.median',
} as const satisfies Record<Exclude<CycleTier, 'rest'>, MarketLocaleKey>

/**
 * IV 制度徽章（2026-09-10 WB-10）。
 *
 * **闭集 + 宿主打标**：`row.ivRegime` 与定时桶 `ContextPacket` 同一 `tagIvRegime`
 * 产出，页面只做枚举 → 词典的翻译。活牌无历史分位与 HV20 时几乎全是 `unknown`
 * ——那是正确状态，不是前端该兜底修补的 bug（禁止用 atmIv 猜「偏高/偏低」）。
 *
 * 与 `REGIME_KEY`（箱体状态机）**不是同一个枚举**：前者是波动率贵贱/偏斜，
 * 后者是价格结构。两处共屏时必须各画各的灯，不可合并。
 */
export const IV_REGIME_KEY = {
  rich: 'options.overview.ivRegime.rich',
  cheap: 'options.overview.ivRegime.cheap',
  event_front: 'options.overview.ivRegime.event_front',
  skew_put: 'options.overview.ivRegime.skew_put',
  skew_call: 'options.overview.ivRegime.skew_call',
  unknown: 'options.overview.ivRegime.unknown',
} as const satisfies Record<OptionIvRegime, MarketLocaleKey>

/** 候选策略模板（标签，不是下单按钮）。 */
export const TEMPLATE_KEY = {
  covered_call: 'options.template.covered_call',
  collar: 'options.template.collar',
  vertical: 'options.template.vertical',
  straddle: 'options.template.straddle',
  butterfly: 'options.template.butterfly',
} as const satisfies Record<OptionIntradayCandidate['template'], MarketLocaleKey>
