/**
 * ETF 期权 5 分钟 K 智能体账本：路径、jsonl、机会校验、开会话决策、盘后折叠。
 * 纯函数 + 显式 fs 参数；不下单、不调 LLM。
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  OptionBarContextPacket,
  OptionBarContextRow,
  OptionBarDailyIv,
  OptionBarFact,
  OptionBarOpportunity,
  OptionBarPick,
  OptionBarRecommendation,
  OptionBarSessionEvent,
  OptionBarSessionRecord,
  OptionBarSkipReason,
  OptionCycle,
  OptionCycleLoop,
  OptionIntradayBoxRow,
  OptionIntradayCandidate,
  OptionIntradayRegime,
  OptionIntradaySession,
  OptionIvRegime,
  OptionOverviewStrategy,
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
  'Use only the ContextPacket. Do not recompute IV, HV, boxes, or volume ratios. Quote ivRegime / divergence / invalidIf verbatim. If ivRegime=unknown, do not claim percentile.',
  'First call cn_put_option_bar_recommendation with one JSON object for this bucket (opportunity closed set + edge + logic + playbook).',
  'Then reply in six sections: opportunity+edge; regime thesis; why this template; strike vs box; invalidIf (copy JSON); playbook or no_trade.',
  'If the previous bucket has a score, open with one sentence: whether the last opportunity was falsified.',
].join(' ')

export const IV_PERCENTILE_HIGH = 0.8
export const IV_PERCENTILE_LOW = 0.2
export const IV_HV_RICH = 1.3
export const IV_HV_CHEAP = 0.7
/** 近月 ATM / 次月 ATM ≥ 此值 → event_front（期限倒挂）。 */
export const IV_EVENT_FRONT = 1.15

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

export function paperAccountPath(root: string): string {
  return path.join(root, 'paper', 'account.json')
}

export function paperPositionsPath(root: string): string {
  return path.join(root, 'paper', 'positions.json')
}

export function paperFillsPath(root: string, date: string): string {
  return path.join(root, 'paper', 'fills', `${date}.jsonl`)
}

export function recommendationsPath(root: string, date: string): string {
  return path.join(root, 'recommendations', `${date}.jsonl`)
}

export function optionSessionsPath(root: string, date: string): string {
  return path.join(root, 'sessions', `${date}.jsonl`)
}

export function reviewsPath(root: string, date: string): string {
  return path.join(root, 'reviews', `${date}.md`)
}

export function packetsPath(root: string, date: string): string {
  return path.join(root, 'packets', `${date}.jsonl`)
}

export function ivDailyPath(root: string): string {
  return path.join(root, 'iv-daily.jsonl')
}

export const IV_PERCENTILE_WINDOW = 60

export function atmIvPercentile(
  history: readonly { readonly date: string; readonly atmIv: number }[],
  currentIv: number,
  window = IV_PERCENTILE_WINDOW,
): number | undefined {
  if (window < 2 || !Number.isFinite(currentIv)) return undefined
  const byDate = new Map<string, number>()
  for (const row of history) {
    if (Number.isFinite(row.atmIv)) byDate.set(row.date, row.atmIv)
  }
  const values = [...byDate.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, iv]) => iv)
  const last = values[values.length - 1]
  const series = last === currentIv ? values : [...values, currentIv]
  if (series.length < window) return undefined
  const tail = series.slice(-window)
  const current = tail[tail.length - 1]
  if (current === undefined) return undefined
  const below = tail.filter((item) => item < current).length
  const equal = tail.filter((item) => item === current).length
  return (below + 0.5 * equal) / window
}

export function foldIvDaily(input: {
  readonly date: string
  readonly existing: readonly OptionBarDailyIv[]
  readonly packet: OptionBarContextPacket
}): OptionBarDailyIv[] {
  const map = new Map<string, OptionBarDailyIv>()
  for (const row of input.existing) {
    map.set(`${row.date}:${row.underlying}`, row)
  }
  for (const row of input.packet.rows) {
    if (row.atmIv === undefined || !Number.isFinite(row.atmIv)) continue
    map.set(`${input.date}:${row.underlying}`, {
      date: input.date,
      underlying: row.underlying,
      atmIv: row.atmIv,
      ...(row.hv20 === undefined ? {} : { hv20: row.hv20 }),
    })
  }
  return [...map.values()].sort((left, right) => {
    const byDate = left.date.localeCompare(right.date)
    return byDate !== 0 ? byDate : left.underlying.localeCompare(right.underlying)
  })
}

/** 用 packets/*.jsonl 回填 iv-daily（每文件 last-wins）。活牌 implied_vol 无 asOf；历史空洞走 replay_atm_iv。 */
export async function backfillIvDailyFromPackets(root: string): Promise<OptionBarDailyIv[]> {
  const dir = path.join(root, 'packets')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let existing = await readJsonl<OptionBarDailyIv>(ivDailyPath(root))
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue
    const date = name.slice(0, -'.jsonl'.length)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const packets = await readJsonl<OptionBarContextPacket>(path.join(dir, name))
    const latest = packets[packets.length - 1]
    if (latest === undefined) continue
    existing = foldIvDaily({ date, existing, packet: latest })
  }
  const file = ivDailyPath(root)
  await mkdir(path.dirname(file), { recursive: true })
  const body = existing.length === 0 ? '' : `${existing.map((row) => JSON.stringify(row)).join('\n')}\n`
  await writeFile(file, body, 'utf8')
  return existing
}

/** 回放种子写入 iv-daily：已有 date+underlying（packet/日终）占主，不覆盖。 */
export function mergeReplayIvDaily(
  existing: readonly OptionBarDailyIv[],
  replay: readonly OptionBarDailyIv[],
): OptionBarDailyIv[] {
  const map = new Map<string, OptionBarDailyIv>()
  for (const row of existing) {
    map.set(`${row.date}:${row.underlying}`, row)
  }
  for (const row of replay) {
    if (row.atmIv === undefined || !Number.isFinite(row.atmIv)) continue
    const key = `${row.date}:${row.underlying}`
    if (map.has(key)) continue
    map.set(key, {
      date: row.date,
      underlying: row.underlying,
      atmIv: row.atmIv,
      ...(row.hv20 === undefined ? {} : { hv20: row.hv20 }),
    })
  }
  return [...map.values()].sort((left, right) => {
    const byDate = left.date.localeCompare(right.date)
    return byDate !== 0 ? byDate : left.underlying.localeCompare(right.underlying)
  })
}

export async function applyReplayIvDaily(
  root: string,
  replay: readonly OptionBarDailyIv[],
): Promise<OptionBarDailyIv[]> {
  const existing = await readJsonl<OptionBarDailyIv>(ivDailyPath(root))
  const merged = mergeReplayIvDaily(existing, replay)
  const file = ivDailyPath(root)
  await mkdir(path.dirname(file), { recursive: true })
  const body = merged.length === 0 ? '' : `${merged.map((row) => JSON.stringify(row)).join('\n')}\n`
  await writeFile(file, body, 'utf8')
  return merged
}

export function latestPacketForBucket(
  rows: readonly OptionBarContextPacket[],
  bucketStart: string,
): OptionBarContextPacket | undefined {
  const matched = rows.filter((row) => row.bucketStart === bucketStart)
  if (matched.length === 0) return undefined
  return matched[matched.length - 1]
}

export async function loadPacketForBucket(
  root: string,
  date: string,
  bucketStart: string,
): Promise<OptionBarContextPacket | undefined> {
  const rows = await readJsonl<OptionBarContextPacket>(packetsPath(root, date))
  return latestPacketForBucket(rows, bucketStart)
}

export function packetByUnderlyingOf(
  packet: OptionBarContextPacket | undefined,
): Readonly<Record<string, OptionBarContextRow | undefined>> | undefined {
  if (packet === undefined) return undefined
  const map: Record<string, OptionBarContextRow | undefined> = {}
  for (const row of packet.rows) map[row.underlying] = row
  return map
}

function asUnitInterval(value: number): number {
  return value > 1 ? value / 100 : value
}

export function tagIvRegime(input: {
  readonly ivPercentile?: number
  readonly atmIv?: number
  readonly nextAtmIv?: number
  readonly hv20?: number
}): OptionIvRegime {
  const atm = input.atmIv
  const next = input.nextAtmIv
  if (
    atm !== undefined && next !== undefined
    && Number.isFinite(atm) && next > 0
    && atm / next >= IV_EVENT_FRONT
  ) {
    return 'event_front'
  }
  const rawPct = input.ivPercentile
  if (rawPct !== undefined && Number.isFinite(rawPct)) {
    const pct = asUnitInterval(rawPct)
    if (pct >= IV_PERCENTILE_HIGH) return 'rich'
    if (pct <= IV_PERCENTILE_LOW) return 'cheap'
  }
  const hv = input.hv20
  if (atm !== undefined && hv !== undefined && Number.isFinite(atm) && hv > 0) {
    if (atm > IV_HV_RICH * hv) return 'rich'
    if (atm < IV_HV_CHEAP * hv) return 'cheap'
  }
  return 'unknown'
}

export function buildBarContextPacket(input: {
  readonly bucketStart: string
  readonly asOf: string
  readonly loop: Pick<OptionCycleLoop, 'rows'>
  readonly factsByUnderlying?: Readonly<Record<string, OptionBarFact | undefined>>
}): OptionBarContextPacket {
  const rows: OptionBarContextRow[] = []
  for (const loopRow of input.loop.rows) {
    const forecast = loopRow.latest?.forecast
    const facts = input.factsByUnderlying?.[loopRow.underlying]
    const ivRegime = tagIvRegime({
      ...(facts?.ivPercentile === undefined ? {} : { ivPercentile: facts.ivPercentile }),
      ...(facts?.atmIv === undefined ? {} : { atmIv: facts.atmIv }),
      ...(facts?.nextAtmIv === undefined ? {} : { nextAtmIv: facts.nextAtmIv }),
      ...(facts?.hv20 === undefined ? {} : { hv20: facts.hv20 }),
    })
    const templates = forecast?.candidates.map((item) => item.template) ?? []
    const invalidIf = forecast?.candidates[0]?.invalidIf
    rows.push({
      underlying: loopRow.underlying,
      ivRegime,
      regime: forecast?.regime ?? 'no_trade',
      candidates: templates,
      ...(loopRow.latest?.id === undefined ? {} : { cycleId: loopRow.latest.id }),
      ...(forecast?.boxLow === undefined ? {} : { boxLow: forecast.boxLow }),
      ...(forecast?.boxHigh === undefined ? {} : { boxHigh: forecast.boxHigh }),
      ...(invalidIf === undefined ? {} : { invalidIf }),
      ...(facts?.atmIv === undefined ? {} : { atmIv: facts.atmIv }),
      ...(facts?.nextAtmIv === undefined ? {} : { nextAtmIv: facts.nextAtmIv }),
      ...(facts?.hv20 === undefined ? {} : { hv20: facts.hv20 }),
      ...(facts?.ivPercentile === undefined ? {} : { ivPercentile: facts.ivPercentile }),
      ...(facts?.return5d === undefined ? {} : { return5d: facts.return5d }),
      ...(facts?.volumeRatio === undefined ? {} : { volumeRatio: facts.volumeRatio }),
      ...(facts?.divergence === undefined ? {} : { divergence: facts.divergence }),
      ...(facts?.heldQty === undefined ? {} : { heldQty: facts.heldQty }),
    })
  }
  return { bucketStart: input.bucketStart, asOf: input.asOf, rows }
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

/**
 * 聚合 sessions 台账事件：同一 bucketStart+sessionId 的 launch/settle 按字段 last-wins 合并。
 * 容忍乱序、settle-only（launch 写失败）、launch-only（in-flight / 宿主重启）。
 */
export function foldOptionBarSessions(rows: readonly OptionBarSessionEvent[]): OptionBarSessionRecord[] {
  const map = new Map<string, OptionBarSessionRecord>()
  for (const row of rows) {
    const key = `${row.bucketStart}|${row.sessionId ?? ''}`
    const prev = map.get(key) ?? { bucketStart: row.bucketStart }
    map.set(key, {
      ...prev,
      ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
      ...(row.launchedAt === undefined ? {} : { launchedAt: row.launchedAt }),
      ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
      ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
      ...(row.error === undefined ? {} : { error: row.error }),
    })
  }
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
  packetByUnderlying?: Readonly<Record<string, OptionBarContextRow | undefined>>
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
      const held = input.heldQtyByUnderlying?.[pick.underlying]
        ?? input.packetByUnderlying?.[pick.underlying]?.heldQty
        ?? 0
      if (held < 10_000) return `covered_yield needs heldQty>=10000 for ${pick.underlying}`
    }
    const packet = input.packetByUnderlying?.[pick.underlying]
    if (packet === undefined) continue
    if (pick.ivRegime !== undefined && pick.ivRegime !== packet.ivRegime) {
      return `pick ivRegime ${pick.ivRegime} disagrees with packet ivRegime ${packet.ivRegime}`
    }
    const ivRegime = packet.ivRegime
    if (opportunity === 'theta_rent' && ivRegime !== 'rich' && ivRegime !== 'event_front') {
      return `theta_rent forbids ivRegime ${ivRegime}`
    }
    if (opportunity === 'rv_vs_iv' && ivRegime === 'rich') {
      return `rv_vs_iv forbids ivRegime ${ivRegime}`
    }
    if (opportunity === 'covered_yield' && packet.divergence === 'weak_rally') {
      return `covered_yield forbids weak_rally`
    }
    if (opportunity === 'mean_reversion' && packet.divergence === 'accelerating_sell') {
      return `mean_reversion forbids accelerating_sell`
    }
  }
  return undefined
}

export function normalizeRecommendation(
  raw: unknown,
  forecastByUnderlying: Readonly<Record<string, OptionIntradayBoxRow | undefined>>,
  heldQtyByUnderlying?: Readonly<Record<string, number | undefined>>,
  packetByUnderlying?: Readonly<Record<string, OptionBarContextRow | undefined>>,
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
    ...(packetByUnderlying === undefined ? {} : { packetByUnderlying }),
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

export function latestPacket(
  rows: readonly OptionBarContextPacket[],
): OptionBarContextPacket | undefined {
  if (rows.length === 0) return undefined
  return rows.reduce((best, row) =>
    Date.parse(row.bucketStart) >= Date.parse(best.bucketStart) ? row : best)
}

export async function loadLatestPacket(
  root: string,
  nowMs: number,
): Promise<OptionBarContextPacket | undefined> {
  try {
    const rows = await readJsonl<OptionBarContextPacket>(
      packetsPath(root, shanghaiCalendarDate(nowMs)),
    )
    return latestPacket(rows)
  } catch {
    return undefined
  }
}

export function latestRecommendation(
  rows: readonly OptionBarRecommendation[],
): OptionBarRecommendation | undefined {
  const latest = latestByKey(rows, (row) => row.bucketStart)
  if (latest.length === 0) return undefined
  return latest.reduce((best, row) =>
    Date.parse(row.bucketStart) >= Date.parse(best.bucketStart) ? row : best)
}

/** 读当天 recommendations jsonl 的最新一行。缺文件 / 坏行 → undefined，不抛。 */
export async function loadLatestRecommendation(
  root: string,
  nowMs: number,
): Promise<OptionBarRecommendation | undefined> {
  const filePath = recommendationsPath(root, shanghaiCalendarDate(nowMs))
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
  const parsed: OptionBarRecommendation[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const row = JSON.parse(trimmed) as unknown
      if (typeof row !== 'object' || row === null) continue
      const rec = row as OptionBarRecommendation
      if (typeof rec.bucketStart !== 'string' || rec.bucketStart === '') continue
      parsed.push(rec)
    } catch {
      continue
    }
  }
  return latestRecommendation(parsed)
}

/** 把当天最新推荐投影到总览行。无账本 → 不写 strategy 键。 */
export function overviewStrategyOf(
  underlying: string,
  rec: OptionBarRecommendation | undefined,
  packetRow?: OptionBarContextRow,
): OptionOverviewStrategy | undefined {
  if (rec === undefined) return undefined
  const pick = rec.picks.find((item) => item.underlying === underlying)
  const ivRegime = packetRow?.ivRegime ?? pick?.ivRegime
  if (pick !== undefined) {
    return {
      opportunity: rec.opportunity,
      template: pick.template,
      edge: rec.edge,
      noTrade: rec.noTrade,
      bucketStart: rec.bucketStart,
      ...(rec.logic === '' ? {} : { logic: rec.logic }),
      ...(rec.playbook === '' ? {} : { playbook: rec.playbook }),
      ...(rec.invalidIf === '' ? {} : { invalidIf: rec.invalidIf }),
      ...(rec.skipReason === undefined ? {} : { skipReason: rec.skipReason }),
      ...(ivRegime === undefined ? {} : { ivRegime }),
    }
  }
  return {
    opportunity: 'no_edge',
    edge: rec.edge,
    noTrade: true,
    bucketStart: rec.bucketStart,
    ...(rec.logic === '' ? {} : { logic: rec.logic }),
    ...(rec.playbook === '' ? {} : { playbook: rec.playbook }),
    ...(rec.skipReason === undefined ? {} : { skipReason: rec.skipReason }),
    ...(ivRegime === undefined ? {} : { ivRegime }),
  }
}

export function attachOverviewStrategies<T extends { readonly underlying: string }>(
  rows: readonly T[],
  rec: OptionBarRecommendation | undefined,
  packet?: OptionBarContextPacket,
): Array<T & { strategy?: OptionOverviewStrategy }> {
  if (rec === undefined) return [...rows]
  const byUnderlying = packetByUnderlyingOf(packet)
  return rows.map((row) => {
    const strategy = overviewStrategyOf(row.underlying, rec, byUnderlying?.[row.underlying])
    return strategy === undefined ? row : { ...row, strategy }
  })
}
