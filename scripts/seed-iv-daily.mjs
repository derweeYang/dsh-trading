/**
 * 用 options 网关 replay_atm_iv 回放近月 ATM IV，写入 data/options/iv-daily.jsonl。
 * 已有 date+underlying（packet / 日终）占主。不要 import kit-cn 源码图（.js 扩展解析会炸）。
 *
 *   node scripts/seed-iv-daily.mjs
 *
 * 依赖：已重启的 dsh-options :8090（含 replay_atm_iv）+ iquant-quote :5810。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = process.env.DSH_TRADING_OPTIONS_DATA
  ? path.resolve(process.env.DSH_TRADING_OPTIONS_DATA)
  : path.join(root, 'data', 'options')
const file = path.join(dataRoot, 'iv-daily.jsonl')
const gateway = (process.env.DSH_OPTIONS_GATEWAY_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '')
const rate = Number(process.env.DSH_OPTIONS_REPLAY_RATE ?? '0.02')
const lookbackDays = Number(process.env.DSH_OPTIONS_REPLAY_LOOKBACK ?? '80')
const maxTermDays = Number(process.env.DSH_OPTIONS_REPLAY_MAX_TERM ?? '45')
const underlying = process.env.DSH_OPTIONS_REPLAY_UNDERLYING ?? 'all'

const res = await fetch(`${gateway}/v1/replay_atm_iv`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    source: 'iquant',
    underlying,
    rate,
    lookbackDays,
    maxTermDays,
  }),
})
const body = await res.json()
if (body?.ok !== true) {
  throw new Error(`replay_atm_iv failed: ${JSON.stringify(body?.error ?? body)}`)
}
const result = body.result
const replay = (result.rows ?? []).filter((row) => Number.isFinite(row.atmIv)).map((row) => ({
  date: row.date,
  underlying: row.underlying,
  atmIv: row.atmIv,
  ...(typeof row.hv20 === 'number' ? { hv20: row.hv20 } : {}),
}))

let existing = []
try {
  const text = await readFile(file, 'utf8')
  existing = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const map = new Map(existing.map((row) => [`${row.date}:${row.underlying}`, row]))
for (const row of replay) {
  const key = `${row.date}:${row.underlying}`
  if (!map.has(key)) map.set(key, row)
}
const merged = [...map.values()].sort((a, b) => {
  const byDate = a.date.localeCompare(b.date)
  return byDate !== 0 ? byDate : a.underlying.localeCompare(b.underlying)
})
await mkdir(path.dirname(file), { recursive: true })
await writeFile(file, merged.length === 0 ? '' : `${merged.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

const byUnd = {}
for (const row of merged) {
  byUnd[row.underlying] = (byUnd[row.underlying] ?? 0) + 1
}
console.log(JSON.stringify({
  gateway: `${gateway}/v1/replay_atm_iv`,
  okDays: result.okDays,
  skippedDays: result.skippedDays,
  failures: result.failures,
  written: merged.length,
  perUnderlying: byUnd,
  path: file,
}, null, 2))
