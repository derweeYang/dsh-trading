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
  OptionPaperBookId,
  OptionPaperDeskDay,
  PaperFill,
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
  'If a row has dayPrior, cite it as a same-day directional prior (not a box). Templates still come from candidates. dayPrior is not a hard gate and must not invent an opportunity.',
  'First call cn_put_option_bar_recommendation with one JSON object for this bucket (opportunity closed set + edge + logic + playbook).',
  'Then reply in six sections: opportunity+edge; regime thesis; why this template; strike vs box; invalidIf (copy JSON); playbook or no_trade.',
  'If the previous bucket has a score, open with one sentence: whether the last opportunity was falsified.',
].join(' ')

export const IV_PERCENTILE_HIGH = 0.8
export const IV_PERCENTILE_LOW = 0.2
export const IV_HV_RICH = 1.3
export const IV_HV_CHEAP = 0.7
/** 年化 IV/HV 合理区间：深度实值反解会贴 bsm 上界 5.0 收敛出 3~5 的离群值
 * （2026-09-11 多标的 atmIv 3.76-4.89 被标成 event_front），区间外一律置空。 */
export const IV_ABS_MIN = 0.01
export const IV_ABS_MAX = 1.5

export function quarantineIv(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Number.isFinite(value) && value >= IV_ABS_MIN && value <= IV_ABS_MAX
    ? value
    : undefined
}
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

/** 纸账户多账本：paper/<book>/{account.json, positions.json, fills/<date>.jsonl}。 */
export function paperAccountPath(root: string, book: OptionPaperBookId = 'strategy'): string {
  return path.join(root, 'paper', book, 'account.json')
}

export function paperPositionsPath(root: string, book: OptionPaperBookId = 'strategy'): string {
  return path.join(root, 'paper', book, 'positions.json')
}

export function paperFillsPath(root: string, book: OptionPaperBookId, date: string): string {
  return path.join(root, 'paper', book, 'fills', `${date}.jsonl`)
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

/** 总览慢数据快照：5 分钟桶 `snapshotBarFacts` 覆写；GET /options/overview 只读此文件。 */
export function overviewSnapshotPath(root: string): string {
  return path.join(root, 'overview.json')
}

export interface OptionOverviewSnapshotFile {
  readonly asOf: string
  readonly rows: readonly unknown[]
}

export async function loadOverviewSnapshot(root: string): Promise<OptionOverviewSnapshotFile | undefined> {
  try {
    const text = await readFile(overviewSnapshotPath(root), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    const rec = parsed as { asOf?: unknown; rows?: unknown }
    if (typeof rec.asOf !== 'string' || rec.asOf.trim() === '' || !Array.isArray(rec.rows)) return undefined
    return { asOf: rec.asOf, rows: rec.rows }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeOverviewSnapshot(
  root: string,
  snapshot: OptionOverviewSnapshotFile,
): Promise<void> {
  const file = overviewSnapshotPath(root)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ asOf: snapshot.asOf, rows: snapshot.rows })}\n`, 'utf8')
}

export const IV_PERCENTILE_WINDOW = 60

export function atmIvPercentile(
  history: readonly { readonly date: string; readonly atmIv: number }[],
  currentIv: number,
  window = IV_PERCENTILE_WINDOW,
): number | undefined {
  if (window < 2 || quarantineIv(currentIv) === undefined) return undefined
  const byDate = new Map<string, number>()
  for (const row of history) {
    if (quarantineIv(row.atmIv) !== undefined) byDate.set(row.date, row.atmIv)
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
    const atmIv = quarantineIv(row.atmIv)
    if (atmIv === undefined) continue
    map.set(`${input.date}:${row.underlying}`, {
      date: input.date,
      underlying: row.underlying,
      atmIv,
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
    const atmIv = quarantineIv(row.atmIv)
    if (atmIv === undefined) continue
    const key = `${row.date}:${row.underlying}`
    if (map.has(key)) continue
    map.set(key, {
      date: row.date,
      underlying: row.underlying,
      atmIv,
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
  const atm = quarantineIv(input.atmIv)
  const next = quarantineIv(input.nextAtmIv)
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
  const hv = quarantineIv(input.hv20)
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
    // IV/HV 入口检疫：离群值（贴反解上界的 3~5）不进 packet，LLM 只见干净值或缺失。
    const atmIv = quarantineIv(facts?.atmIv)
    const nextAtmIv = quarantineIv(facts?.nextAtmIv)
    const hv20 = quarantineIv(facts?.hv20)
    const ivRegime = tagIvRegime({
      ...(facts?.ivPercentile === undefined ? {} : { ivPercentile: facts.ivPercentile }),
      ...(atmIv === undefined ? {} : { atmIv }),
      ...(nextAtmIv === undefined ? {} : { nextAtmIv }),
      ...(hv20 === undefined ? {} : { hv20 }),
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
      ...(atmIv === undefined ? {} : { atmIv }),
      ...(nextAtmIv === undefined ? {} : { nextAtmIv }),
      ...(hv20 === undefined ? {} : { hv20 }),
      ...(facts?.ivPercentile === undefined ? {} : { ivPercentile: facts.ivPercentile }),
      ...(facts?.return5d === undefined ? {} : { return5d: facts.return5d }),
      ...(facts?.volumeRatio === undefined ? {} : { volumeRatio: facts.volumeRatio }),
      ...(facts?.divergence === undefined ? {} : { divergence: facts.divergence }),
      ...(facts?.heldQty === undefined ? {} : { heldQty: facts.heldQty }),
      ...(facts?.dayPrior === undefined ? {} : { dayPrior: facts.dayPrior }),
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

export function shouldWriteDailyReview(input: {
  session: OptionIntradaySession
  exists: boolean
  /** 当日 cycles 已出现尾盘桶（bucketStart >= 14:50）= 盘确实收完了。 */
  hasClosedBuckets: boolean
}): boolean {
  // 只在盘收完后写：午夜跨日的第一个 tick session='closed' 但当日尚无盘中桶，
  // 曾把复盘抢写成全 0 定格全天（2026-09-11 复盘 00:02 落盘，盘中 4 条推荐全被无视）。
  if (!input.hasClosedBuckets) return false
  // close5 允许覆盖重写：冲掉历史遗留的午夜空版。
  if (input.session === 'close5') return true
  return !input.exists && input.session === 'closed'
}

/** 日级账本口径核心：foldDailyReview（盘后 md）与纸账户工作台（页面统计）共用，
 * 保证两侧数字同源。去重一律 last-wins：cycles 按 id、recommendations 按 bucketStart。 */
export interface DailyLedgerCore {
  readonly latestCycles: readonly OptionCycle[]
  readonly verdictsByUnderlying: ReadonlyMap<string, { hit: number; miss: number; partial: number; skipped: number }>
  /** 去重后有效候选（无 skipReason 且非 noTrade）——md「有效推荐」同集。 */
  readonly candidates: readonly OptionBarRecommendation[]
  /** 去重推荐行的 skipReason 计数。 */
  readonly skipReasons: ReadonlyMap<string, number>
  /** fills 中 reason=skipped 行的 skip 字段计数。 */
  readonly paperSkips: ReadonlyMap<string, number>
  /** verdict !== 'skipped' 的有效打分数。 */
  readonly scored: number
}

export function dailyLedgerCore(input: {
  cycles: readonly OptionCycle[]
  recommendations: readonly OptionBarRecommendation[]
  /** paper fills（含 skip 行）；缺省 = 不统计执行层跳过。 */
  fills?: readonly { reason?: unknown; skip?: unknown }[]
}): DailyLedgerCore {
  const latestCycles = latestByKey(input.cycles, (cycle) => cycle.id)
  const verdictsByUnderlying = new Map<string, { hit: number; miss: number; partial: number; skipped: number }>()
  for (const cycle of latestCycles) {
    const row = verdictsByUnderlying.get(cycle.underlying) ?? { hit: 0, miss: 0, partial: 0, skipped: 0 }
    const verdict = cycle.score?.verdict
    if (verdict === 'hit') row.hit += 1
    else if (verdict === 'miss') row.miss += 1
    else if (verdict === 'partial') row.partial += 1
    else if (verdict === 'skipped') row.skipped += 1
    verdictsByUnderlying.set(cycle.underlying, row)
  }
  const recs = latestByKey(input.recommendations, (row) => row.bucketStart)
  const candidates = recs.filter((row) => row.skipReason === undefined && !row.noTrade)
  const skipReasons = new Map<string, number>()
  for (const row of recs) {
    if (row.skipReason === undefined) continue
    skipReasons.set(row.skipReason, (skipReasons.get(row.skipReason) ?? 0) + 1)
  }
  const paperSkips = new Map<string, number>()
  for (const fill of input.fills ?? []) {
    if (fill.reason !== 'skipped' || typeof fill.skip !== 'string') continue
    paperSkips.set(fill.skip, (paperSkips.get(fill.skip) ?? 0) + 1)
  }
  const scored = latestCycles.filter((cycle) => cycle.score !== undefined && cycle.score.verdict !== 'skipped').length
  return { latestCycles, verdictsByUnderlying, candidates, skipReasons, paperSkips, scored }
}

export function foldDailyReview(input: {
  date: string
  cycles: readonly OptionCycle[]
  recommendations: readonly OptionBarRecommendation[]
  /** paper fills（含 skip 行）；缺省 = 不统计执行层跳过。 */
  fills?: readonly { reason?: unknown; skip?: unknown }[]
}): string {
  const core = dailyLedgerCore(input)
  const overlaps = core.skipReasons.get('overlap') ?? 0
  const failed = core.skipReasons.get('launch_failed') ?? 0
  const lines = [
    `# 复盘 · ${input.date} ETF 期权 5 分钟 K`,
    '',
    '> 确定性汇总；无 LLM。数字只来自 cycles / recommendations / paper fills jsonl。非投资建议。',
    '',
    '## 1. 各标的打分',
    '',
    '| 标的 | hit | partial | miss | skipped |',
    '|---|---:|---:|---:|---:|',
  ]
  for (const [underlying, row] of [...core.verdictsByUnderlying.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${underlying} | ${row.hit} | ${row.partial} | ${row.miss} | ${row.skipped} |`)
  }
  if (core.verdictsByUnderlying.size === 0) lines.push('| （无） | 0 | 0 | 0 | 0 |')
  lines.push('', '## 2. 推荐 vs 下一桶', '')
  if (core.candidates.length === 0) lines.push('- 无有效推荐')
  for (const rec of core.candidates) {
    const next = core.latestCycles.find((cycle) => Date.parse(cycle.bucketStart) > Date.parse(rec.bucketStart))
    const verdict = next?.score?.verdict ?? '（尚无下一桶）'
    lines.push(`- ${rec.bucketStart} ${rec.opportunity} → ${verdict}`)
  }
  lines.push('', '## 3. 误给腿 / 空仓', '')
  lines.push('- 见上表对照；本折叠不重算箱体。')
  lines.push('', '## 4. 跳过', '')
  lines.push(`- overlap: ${overlaps}`)
  lines.push(`- launch_failed: ${failed}`)
  for (const [skip, count] of [...core.paperSkips.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- paper ${skip}: ${count}`)
  }
  lines.push('', '## 5. 明日剧本', '')
  lines.push(core.scored < 10 ? '- 样本不足（有效打分 < 10），只记不改 skill。' : '- 对照 miss 集中的 regime，至多改一条选场/否决。')
  lines.push('', '## 6. 免责', '')
  lines.push('技术研究预填，不构成投资建议。')
  lines.push('')
  return lines.join('\n')
}

export function sessionAt(nowMs: number): OptionIntradaySession {
  return sessionFlag(nowMs)
}

/** 纸账户工作台：默认覆盖近 10 日账本（cycles/recommendations/paper fills 三目录日期并集）。 */
export const PAPER_DESK_DEFAULT_DAYS = 10
export const PAPER_DESK_MAX_DAYS = 30
export const PAPER_DESK_RECENT_FILL_LIMIT = 50

/** 单日执行链路统计：候选桶三态划分（成交 / 纸账跳过 / 记录缺口）+ 打分分布。 */
export function foldPaperDeskDay(input: {
  date: string
  cycles: readonly OptionCycle[]
  recommendations: readonly OptionBarRecommendation[]
  fills: readonly PaperFill[]
}): OptionPaperDeskDay {
  const core = dailyLedgerCore({ cycles: input.cycles, recommendations: input.recommendations, fills: input.fills })
  let filled = 0
  let gapBuckets = 0
  for (const rec of core.candidates) {
    // close fill 复用开仓桶 bucketStart，只看 offset=open 行
    const open = input.fills.find((fill) => fill.offset === 'open' && fill.bucketStart === rec.bucketStart)
    if (open === undefined) gapBuckets += 1
    else if (open.reason === 'signal' && open.qty > 0) filled += 1
    // open.reason === 'skipped' → 已计入 paperSkips，不重复计
  }
  let hit = 0
  let partial = 0
  let miss = 0
  let skipped = 0
  for (const row of core.verdictsByUnderlying.values()) {
    hit += row.hit
    partial += row.partial
    miss += row.miss
    skipped += row.skipped
  }
  return {
    date: input.date,
    candidates: core.candidates.length,
    filled,
    gapBuckets,
    skipReasons: mapToRecord(core.skipReasons),
    paperSkips: mapToRecord(core.paperSkips),
    verdicts: { hit, partial, miss, skipped },
    scored: core.scored,
  }
}

function mapToRecord(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

const LEDGER_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** 三账本目录日期并集，新→旧；目录缺失/坏名跳过。fills 读 strategy 账本
 *  （与 recommendations/cycles 同链路；arb 账本归资产面板），并兼容懒迁移前的旧布局。 */
async function ledgerDates(root: string): Promise<string[]> {
  const dates = new Set<string>()
  for (const dir of ['cycles', 'recommendations', path.join('paper', 'strategy', 'fills'), path.join('paper', 'fills')]) {
    let names: readonly string[]
    try {
      names = await readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of names) {
      const match = LEDGER_DATE_RE.exec(name)
      if (match !== null) dates.add(match[1]!)
    }
  }
  return [...dates].sort((a, b) => b.localeCompare(a))
}

export interface PaperDeskLedger {
  /** 近 N 日，新→旧；三账本全空的日期不出行。 */
  readonly days: readonly OptionPaperDeskDay[]
  /** 跨日近期流水（asOf 新→旧，非法时间戳沉底），截 PAPER_DESK_RECENT_FILL_LIMIT。 */
  readonly recentFills: readonly PaperFill[]
  readonly dayCount: number
}

/** 读近 N 日三账本并折叠成工作台快照；单日坏数据跳过，目录全缺返回空结果不抛。 */
export async function loadPaperDesk(
  root: string,
  days: number = PAPER_DESK_DEFAULT_DAYS,
): Promise<PaperDeskLedger> {
  const limit = Math.max(1, Math.min(Math.trunc(days) || PAPER_DESK_DEFAULT_DAYS, PAPER_DESK_MAX_DAYS))
  const dates = (await ledgerDates(root)).slice(0, limit)
  const perDay = await Promise.all(dates.map(async (date) => {
    try {
      const [cycles, recommendations, strategyFills, legacyFills] = await Promise.all([
        readJsonl<OptionCycle>(cyclesPath(root, date)),
        readJsonl<OptionBarRecommendation>(recommendationsPath(root, date)),
        // 多账本（feat/option-paper-books）：desk 读 strategy 账本（与候选/打分同链路）；
        // readJsonl 对 ENOENT 返回 []，并读旧布局目录兼容懒迁移前数据，纯读不触发迁移。
        readJsonl<PaperFill>(paperFillsPath(root, 'strategy', date)),
        readJsonl<PaperFill>(path.join(root, 'paper', 'fills', `${date}.jsonl`)),
      ])
      const fills = [...strategyFills, ...legacyFills]
      if (cycles.length === 0 && recommendations.length === 0 && fills.length === 0) return undefined
      return { day: foldPaperDeskDay({ date, cycles, recommendations, fills }), fills }
    } catch {
      // 账本是 append-only agent 写入，坏日跳过不炸整个端点
      return undefined
    }
  }))
  const ok = perDay.filter((entry) => entry !== undefined) as { day: OptionPaperDeskDay; fills: PaperFill[] }[]
  const recentFills = ok
    .flatMap((entry) => entry.fills)
    .sort((a, b) => {
      const at = Date.parse(a.asOf)
      const bt = Date.parse(b.asOf)
      const as = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
      const bs = Number.isFinite(bt) ? bt : Number.NEGATIVE_INFINITY
      return bs - as
    })
    .slice(0, PAPER_DESK_RECENT_FILL_LIMIT)
  return { days: ok.map((entry) => entry.day), recentFills, dayCount: ok.length }
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
