import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultTasksLedgerPath, sanitizeProfileSegment } from '../src/tasks/paths.ts'

describe('defaultTasksLedgerPath', () => {
  it('按 DSH_HOME + profile 隔离账本目录', () => {
    expect(defaultTasksLedgerPath({ DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'trading-web' }))
      .toBe(join('/tmp/dsh-home', 'trading-tasks', 'trading-web', 'ledger-v1.json'))
    expect(defaultTasksLedgerPath({ DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'trading-dev' }))
      .toBe(join('/tmp/dsh-home', 'trading-tasks', 'trading-dev', 'ledger-v1.json'))
  })

  it('DSH_TRADING_TASKS_LEDGER 显式覆盖优先', () => {
    expect(defaultTasksLedgerPath({
      DSH_HOME: '/tmp/dsh-home',
      DSH_PROFILE: 'trading-web',
      DSH_TRADING_TASKS_LEDGER: '/tmp/custom/ledger.json',
    })).toBe('/tmp/custom/ledger.json')
  })

  it('profile 段剥离路径分隔符', () => {
    expect(sanitizeProfileSegment('../evil/name')).toBe('evil-name')
    expect(sanitizeProfileSegment('')).toBe('default')
  })
})
