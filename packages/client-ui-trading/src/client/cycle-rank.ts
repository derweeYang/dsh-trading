/**
 * 5 分钟闭环卡片的「机会排序」纯函数（2026-09-09 WB-10）。
 *
 * 领航员诉求：九张卡片别再平铺，**最强 / 最弱 / 中间**的标的机会排前面。
 * 强弱口径沿用 WB-9 叠图 `OverlayTrendChart.emphasisOf` 的同一套定义——
 * 按近 5 个交易日累计涨跌幅排名：
 * - 第 1 名 = `strong`（最强）；
 * - 末位 = `weak`（最弱）；
 * - 正中位 = `median`（中间）；
 * - 其余 = `rest`。
 *
 * 累计值由调用方用 `option-insight.cumulativeReturn(row.days)` 算好后传进来，
 * **不在这里另算一遍**——WB-9 定过纪律：图上的终点与卡片名次必须同源，
 * 两处各算一次就会出现「图上最高、卡片不是最强」的打架。
 *
 * 三条纪律：
 * 1. **只排序，不改数**：不因为排前面就美化 regime / 箱沿 / 命中率，卡片内容照抄桥 JSON。
 * 2. **数据缺席不抢档**：没有累计值的标的不参与排名，也就不会冒充「最强/最弱」，
 *    一律落 `rest`——宁可排序失效，也不伪造强弱。
 * 3. **确定性**：同档内「本桶有机会（有箱 + 有候选）」优先，其次保持桥给的原始顺序，
 *    避免每次轮询（30s）卡片跳来跳去。
 *
 * 本模块只做排序判断，不构成投资建议。
 */
import type { OptionCycleLoopRow } from '@dshtrading/api'

/** 机会档位：最强 / 最弱 / 中位 / 其余。 */
export type CycleTier = 'strong' | 'weak' | 'median' | 'rest'

export interface RankedCycleRow {
  readonly row: OptionCycleLoopRow
  readonly tier: CycleTier
  /** 按累计涨跌幅降序的名次（0 = 最强）；数据缺席时为 undefined。 */
  readonly rank: number | undefined
  /** 近 5 交易日累计涨跌幅（%），与叠图终点同源。 */
  readonly cum5d: number | undefined
}

/** 展示顺序：最强 → 最弱 → 中位 → 其余。 */
const TIER_ORDER: Readonly<Record<CycleTier, number>> = { strong: 0, weak: 1, median: 2, rest: 3 }

/**
 * 名次 → 档位；与 `OverlayTrendChart.emphasisOf` 同口径。
 * total === 1 时只给 `strong`（独一份标的不能同时是最强与最弱）。
 */
export function cycleTierOf(rank: number, total: number): CycleTier {
  if (total <= 0 || rank < 0 || rank >= total) return 'rest'
  if (rank === 0) return 'strong'
  if (rank === total - 1) return 'weak'
  if (rank === Math.floor(total / 2)) return 'median'
  return 'rest'
}

/** 本桶有机会 = 出箱 + 至少一条候选模板；没箱只有原因的算没机会。 */
function hasOpportunity(row: OptionCycleLoopRow): boolean {
  const forecast = row.latest?.forecast
  if (forecast === undefined) return false
  const hasBox = forecast.boxLow !== undefined && forecast.boxHigh !== undefined
  return hasBox && forecast.candidates.length > 0
}

/**
 * 闭环行 → 排好序的行。
 *
 * @param rows 桥给的原始顺序（`GET /options/cycles/loop`）。
 * @param cum5d underlying → 近 5 交易日累计涨跌幅（%，`cumulativeReturn(row.days)`）；
 *                          缺席则全部落 `rest`（不排序，也不冒充强弱）。
 */
export function rankCycleRows(
  rows: readonly OptionCycleLoopRow[],
  cum5d?: Readonly<Record<string, number>> | undefined,
): readonly RankedCycleRow[] {
  const indexed = rows.map((row, index) => ({
    row,
    index,
    value: cum5d?.[row.underlying],
  }))

  // 只让有 return5d 的标的参与排名（NaN / 缺席不抢档位）。
  const scored = indexed.filter(item => item.value !== undefined && Number.isFinite(item.value))
  scored.sort((a, b) => Number(b.value) - Number(a.value) || a.index - b.index)

  const rankOf = new Map<string, number>()
  scored.forEach((item, i) => { rankOf.set(item.row.underlying, i) })

  const total = scored.length
  return indexed
    .map(({ row, index, value }) => {
      const rank = rankOf.get(row.underlying)
      return {
        row,
        index,
        rank,
        cum5d: value,
        tier: rank === undefined ? 'rest' : cycleTierOf(rank, total),
      }
    })
    .sort((a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
      || Number(hasOpportunity(b.row)) - Number(hasOpportunity(a.row))
      || a.index - b.index)
    .map(({ row, tier, rank, cum5d: value }) => ({ row, tier, rank, cum5d: value }))
}
