/**
 * ETF 期权 5 分钟 K 智能体账本：路径、jsonl、机会校验、开会话决策、盘后折叠。
 * 纯函数 + 显式 fs 参数；不下单、不调 LLM。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  OptionBarOpportunity,
  OptionBarPick,
  OptionBarRecommendation,
  OptionBarSkipReason,
  OptionCycle,
  OptionIntradayBoxRow,
  OptionIntradayCandidate,
  OptionIntradayRegime,
  OptionIntradaySession,
} from '@dshtrading/api'
import { OptionCycleBook } from './option-cycles.js'
import { sessionFlag } from './intraday-box.js'

export const OPTIONS_DATA_ENV = 'DSH_TRADING_OPTIONS_DATA'

export type BarAgentAction = 'idle' | 'launch' | 'stub'

export interface BarAgentDecision {
  readonly action: BarAgentAction
  readonly skipReason?: OptionBarSkipReason
  readonly bucketStart: string
}

const OPPORTUNITY_TABLE: Readonly<
  Record<Exclude<OptionBarOpportunity, 'no_edge'>, { regimes: readonly OptionIntradayRegime[]; templates: readonly OptionIntradayCandidate['template'][] }>
> = {
  theta_rent: { regimes: ['range_hold'], templates: ['butterfly'] },
  rv_vs_iv: { regimes: ['vol_expand'], templates: ['straddle'] },
  direction_delta: { regimes: ['breakout'], templates: ['vertical'] },
  mean_reversion: { regimes: ['mean_revert'], templates: ['vertical'] },
  covered_yield: { regimes: ['range_hold', 'mean_revert', 'breakout', 'vol_expand'], templates: ['covered_call', 'collar'] },
}

export const OPTION_BAR_AGENT_PROMPT = [
  'Follow option-intraday-workflow. Technical analysis only; not investment advice.',
  'You are the unified trader. Do not call researcher_subagent, trader_subagent, or risk_reviewer_subagent.',
  'Do not call *_get_klines. Do not place, cancel, or preview live orders.',
  'Read knowledge_search first (tag ETF期权). Then options overview (sort=strength, includeIv=1) and GET /options/cycles/loop (or cn_get_option_intraday_box).',
  'Templates must come from forecast.candidates. Prefill legs via cn_get_option_strategy only.',
  'First call cn_put_option_bar_recommendation with one JSON object for this bucket (opportunity closed set + edge + logic + playbook).',
  'Then reply in six sections: opportunity+edge; regime thesis; why this template; strike vs box; invalidIf (copy JSON); playbook or no_trade.',
  'If the previous bucket has a score, open with one sentence: whether the last opportunity was falsified.',
].join(' ')

export function optionsDataRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env[OPTIONS_DATA_ENV]
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override)
  return path.resolve(cwd, 'data', 'options')
}

export function shanghaiCalendarDate(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('shanghaiCalendarDate: failed to format Asia/Shanghai date')
  }
  return `${year}-${month}-${day}`
}

export function cyclesPath(root: string, date: string): string {
  return path.join(root, 'cycles', `${date}.jsonl`)
}

export function recommendationsPath(root: string, date: string): string {
  return path.join(root, 'recommendations', `${date}.jsonl`)
}

export function reviewsPath(root: string, date: string): string {
  return path.join(root, 'reviews', `${date}.md`)
}

export async function appendJsonlLine(filePath: string, row: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8')
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const rows: T[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    rows.push(JSON.parse(trimmed) as T)
  }
  return rows
}

export function latestByKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const map = new Map<string, T>()
  for (const row of rows) map.set(keyOf(row), row)
  return [...map.values()]
}

export function replayCyclesIntoBook(book: OptionCycleBook, rows: readonly OptionCycle[]): OptionCycleBook {
  for (const row of latestByKey(rows, (cycle) => cycle.id)) book.upsert(row)
  return book
}

export function opportunityAllowed(input: {
  opportunity: OptionBarOpportunity
  picks: readonly OptionBarPick[]
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>
  heldQtyByUnderlying?: Readonly<Record<string, number | undefined>>
}): string | undefined {
  const { opportunity, picks } = input
  if (opportunity === 'no_edge') {
    return picks.length === 0 ? undefined : 'no_edge forbids picks'
  }
  if (picks.length === 0) return `${opportunity} requires at least one pick`
  const rule = OPPORTUNITY_TABLE[opportunity]
  for (const pick of picks) {
    if (!rule.regimes.includes(pick.regime)) {
      return `${opportunity} forbids regime ${pick.regime}`
    }
    if (!rule.templates.includes(pick.template)) {
      return `${opportunity} forbids template ${pick.template}`
    }
    const forecast = input.forecastByUnderlying[pick.underlying]
    if (forecast === undefined) return `missing forecast for ${pick.underlying}`
    if (!forecast.candidates.some((candidate) => candidate.template === pick.template)) {
      return `template ${pick.template} is not in candidates for ${pick.underlying}`
    }
    if (opportunity === 'covered_yield') {
      const held = input.heldQtyByUnderlying?.[pick.underlying] ?? 0
      if (held < 10_000) return `covered_yield needs heldQty>=10000 for ${pick.underlying}`
    }
  }
  return undefined
}

export function normalizeRecommendation(
  raw: unknown,
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>,
  heldQtyByUnderlying?: Readonly<Record<string, number | undefined>>,
): OptionBarRecommendation {
  if (typeof raw !== 'object' || raw === null) throw new Error('recommendation must be an object')
  const row = raw as Record<string, unknown>
  const opportunity = row.opportunity
  if (
    opportunity !== 'theta_rent'
    && opportunity !== 'rv_vs_iv'
    && opportunity !== 'direction_delta'
    && opportunity !== 'mean_reversion'
    && opportunity !== 'covered_yield'
    && opportunity !== 'no_edge'
  ) {
    throw new Error('invalid opportunity')
  }
  const picks = Array.isArray(row.picks) ? row.picks as OptionBarPick[] : []
  const error = opportunityAllowed({
    opportunity,
    picks,
    forecastByUnderlying,
    ...(heldQtyByUnderlying === undefined ? {} : { heldQtyByUnderlying }),
  })
  if (error !== undefined) throw new Error(error)
  const skipReason = row.skipReason
  if (
    skipReason !== undefined
    && skipReason !== 'session'
    && skipReason !== 'calibrated'
    && skipReason !== 'overlap'
    && skipReason !== 'launch_failed'
  ) {
    throw new Error('invalid skipReason')
  }
  const noTrade = opportunity === 'no_edge' || row.noTrade === true
  return {
    bucketStart: String(row.bucketStart ?? ''),
    asOf: String(row.asOf ?? ''),
    session: row.session as OptionIntradaySession,
    opportunity,
    edge: String(row.edge ?? ''),
    logic: String(row.logic ?? ''),
    playbook: String(row.playbook ?? ''),
    invalidIf: String(row.invalidIf ?? ''),
    picks,
    noTrade,
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(row.previousScore !== undefined
      ? { previousScore: row.previousScore as NonNullable<OptionBarRecommendation['previousScore']> }
      : {}),
  } as OptionBarRecommendation
}

export function makeSkipRecommendation(input: {
  bucketStart: string
  asOf: string
  session: OptionIntradaySession
  skipReason: OptionBarSkipReason
  previousScore?: OptionBarRecommendation['previousScore']
}): OptionBarRecommendation {
  return {
    bucketStart: input.bucketStart,
    asOf: input.asOf,
    session: input.session,
    opportunity: 'no_edge',
    edge: 'no session or no tradeable forecast',
    logic: '',
    playbook: '',
    invalidIf: '',
    picks: [],
    noTrade: true,
    skipReason: input.skipReason,
    ...(input.previousScore === undefined ? {} : { previousScore: input.previousScore }),
  }
}

export function decideBarAgent(input: {
  ticked: boolean
  session: OptionIntradaySession
  inFlight: boolean
  allCalibrated: boolean
  alreadyRecommended: boolean
  bucketStart: string
}): BarAgentDecision {
  const { bucketStart } = input
  if (!input.ticked || input.alreadyRecommended) return { action: 'idle', bucketStart }
  if (input.session !== 'regular') return { action: 'stub', skipReason: 'session', bucketStart }
  if (input.allCalibrated) return { action: 'stub', skipReason: 'calibrated', bucketStart }
  if (input.inFlight) return { action: 'stub', skipReason: 'overlap', bucketStart }
  return { action: 'launch', bucketStart }
}

export function shouldWriteDailyReview(session: OptionIntradaySession, exists: boolean): boolean {
  if (exists) return false
  return session === 'close5' || session === 'closed'
}

export function foldDailyReview(input: {
  date: string
  cycles: readonly OptionCycle[]
  recommendations: readonly OptionBarRecommendation[]
}): string {
  const latestCycles = latestByKey(input.cycles, (cycle) => cycle.id)
  const stats = new Map<string, { hit: number; miss: number; partial: number; skipped: number }>()
  for (const cycle of latestCycles) {
    const row = stats.get(cycle.underlying) ?? { hit: 0, miss: 0, partial: 0, skipped: 0 }
    const verdict = cycle.score?.verdict
    if (verdict === 'hit') row.hit += 1
    else if (verdict === 'miss') row.miss += 1
    else if (verdict === 'partial') row.partial += 1
    else if (verdict === 'skipped') row.skipped += 1
    stats.set(cycle.underlying, row)
  }
  const recs = latestByKey(input.recommendations, (row) => row.bucketStart)
  const valid = recs.filter((row) => row.skipReason === undefined && !row.noTrade)
  const overlaps = recs.filter((row) => row.skipReason === 'overlap').length
  const failed = recs.filter((row) => row.skipReason === 'launch_failed').length
  const scored = latestCycles.filter((cycle) => cycle.score !== undefined && cycle.score.verdict !== 'skipped').length
  const lines = [
    `# 复盘 · ${input.date} ETF 期权 5 分钟 K`,
    '',
    '> 确定性汇总；无 LLM。数字只来自 cycles / recommendations jsonl。非投资建议。',
    '',
    '## 1. 各标的打分',
    '',
    '| 标的 | hit | partial | miss | skipped |',
    '|---|---:|---:|---:|---:|',
  ]
  for (const [underlying, row] of [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${underlying} | ${row.hit} | ${row.partial} | ${row.miss} | ${row.skipped} |`)
  }
  if (stats.size === 0) lines.push('| （无） | 0 | 0 | 0 | 0 |')
  lines.push('', '## 2. 推荐 vs 下一桶', '')
  if (valid.length === 0) lines.push('- 无有效推荐')
  for (const rec of valid) {
    const next = latestCycles.find((cycle) => Date.parse(cycle.bucketStart) > Date.parse(rec.bucketStart))
    const verdict = next?.score?.verdict ?? '（尚无下一桶）'
    lines.push(`- ${rec.bucketStart} ${rec.opportunity} → ${verdict}`)
  }
  lines.push('', '## 3. 误给腿 / 空仓', '')
  lines.push('- 见上表对照；本折叠不重算箱体。')
  lines.push('', '## 4. 跳过', '')
  lines.push(`- overlap: ${overlaps}`)
  lines.push(`- launch_failed: ${failed}`)
  lines.push('', '## 5. 明日剧本', '')
  lines.push(scored < 10 ? '- 样本不足（有效打分 < 10），只记不改 skill。' : '- 对照 miss 集中的 regime，至多改一条选场/否决。')
  lines.push('', '## 6. 免责', '')
  lines.push('技术研究预填，不构成投资建议。')
  lines.push('')
  return lines.join('\n')
}

export function sessionAt(nowMs: number): OptionIntradaySession {
  return sessionFlag(nowMs)
}
