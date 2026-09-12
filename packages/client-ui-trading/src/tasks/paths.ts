/**
 * 定时任务账本路径：按 $DSH_HOME + profile 隔离，避免多宿主抢同一把锁。
 * 显式 DSH_TRADING_TASKS_LEDGER 仍覆盖（测试与运维定点）。
 */
import os from 'node:os'
import path from 'node:path'

export function sanitizeProfileSegment(raw: string | undefined): string {
  const replaced = (raw ?? '').trim().replace(/[\\/]+/g, '-')
  const stripped = replaced.replace(/^\.+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return stripped === '' ? 'default' : stripped
}

export function defaultTasksLedgerPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const override = env.DSH_TRADING_TASKS_LEDGER
  if (typeof override === 'string' && override !== '') return override
  const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  const profile = sanitizeProfileSegment(env.DSH_PROFILE ?? env.DSH_TRADING_PROFILE)
  return path.join(home, 'trading-tasks', profile, 'ledger-v1.json')
}
