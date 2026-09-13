/**
 * 垂直套利组合（Vertical Spread）—— 方向性价差，非无风险套利。
 *
 * 同到期、不同行权价的一买一卖，用卖出腿抵减买入腿权利金，封顶盈亏。
 * 四种：牛市看涨 / 熊市看涨 / 牛市看跌 / 熊市看跌。
 *   netDebit = 付的权金 − 收的权金（>0 借记，<0 贷记）
 *   看涨价差 盈亏平衡 = 低K + |netDebit|；看跌价差 盈亏平衡 = 高K − |netDebit|
 *   借记价差：最大盈利 = 价差 − netDebit，最大亏损 = netDebit
 *   贷记价差：最大盈利 = −netDebit（信用），最大亏损 = 价差 + netDebit
 */
import type { ArbitrageChain, ArbitrageLeg } from './types.ts'
import { execPrices } from './prices.ts'

export type VerticalRight = 'C' | 'P'
export type VerticalDirection = 'bull' | 'bear'

export interface VerticalSpread {
  readonly right: VerticalRight
  readonly direction: VerticalDirection
  readonly lowStrike: number
  readonly highStrike: number
  /** 净借记（正=净支出，负=净收入） */
  readonly netDebit: number
  readonly maxProfitPerShare: number
  readonly maxLossPerShare: number
  /** 到期损益平衡价 */
  readonly breakeven: number
  readonly legs: readonly ArbitrageLeg[]
}

export function buildVerticalSpread(
  chain: ArbitrageChain,
  spec: { right: VerticalRight; direction: VerticalDirection; lowStrike: number; highStrike: number },
): VerticalSpread | undefined {
  const { right, direction, lowStrike, highStrike } = spec
  if (!(highStrike > lowStrike)) return undefined

  const rows = right === 'C' ? chain.calls : chain.puts
  const low = rows.find((r) => r.strike === lowStrike)
  const high = rows.find((r) => r.strike === highStrike)
  if (low === undefined || high === undefined) return undefined

  let paid: number | undefined
  let received: number | undefined
  let legs: ArbitrageLeg[]
  if (right === 'C' && direction === 'bull') {
    paid = execPrices(low).ask
    received = execPrices(high).bid
    legs = [
      { code: low.code, right: 'C', action: 'buy', strike: lowStrike },
      { code: high.code, right: 'C', action: 'sell', strike: highStrike },
    ]
  } else if (right === 'C' && direction === 'bear') {
    paid = execPrices(high).ask
    received = execPrices(low).bid
    legs = [
      { code: high.code, right: 'C', action: 'buy', strike: highStrike },
      { code: low.code, right: 'C', action: 'sell', strike: lowStrike },
    ]
  } else if (right === 'P' && direction === 'bull') {
    paid = execPrices(low).ask
    received = execPrices(high).bid
    legs = [
      { code: low.code, right: 'P', action: 'buy', strike: lowStrike },
      { code: high.code, right: 'P', action: 'sell', strike: highStrike },
    ]
  } else {
    paid = execPrices(high).ask
    received = execPrices(low).bid
    legs = [
      { code: high.code, right: 'P', action: 'buy', strike: highStrike },
      { code: low.code, right: 'P', action: 'sell', strike: lowStrike },
    ]
  }
  if (paid === undefined || received === undefined || !Number.isFinite(paid) || !Number.isFinite(received)) {
    return undefined
  }

  const netDebit = paid - received
  const spread = highStrike - lowStrike
  const absNet = Math.abs(netDebit)
  const breakeven = right === 'C' ? lowStrike + absNet : highStrike - absNet
  const maxProfitPerShare = netDebit >= 0 ? spread - netDebit : -netDebit
  const maxLossPerShare = netDebit >= 0 ? netDebit : spread + netDebit

  return { right, direction, lowStrike, highStrike, netDebit, maxProfitPerShare, maxLossPerShare, breakeven, legs }
}

/** 枚举全部 (right × direction × 两两行权价) 的垂直价差。 */
export function scanVerticalSpreads(chain: ArbitrageChain): VerticalSpread[] {
  const rights: VerticalRight[] = ['C', 'P']
  const dirs: VerticalDirection[] = ['bull', 'bear']
  const strikes = [
    ...new Set([...chain.calls.map((c) => c.strike), ...chain.puts.map((p) => p.strike)]),
  ].sort((a, b) => a - b)
  const out: VerticalSpread[] = []
  for (const right of rights) {
    for (const direction of dirs) {
      for (let i = 0; i < strikes.length; i++) {
        for (let j = i + 1; j < strikes.length; j++) {
          const low = strikes[i] as number
          const high = strikes[j] as number
          const sp = buildVerticalSpread(chain, { right, direction, lowStrike: low, highStrike: high })
          if (sp !== undefined) out.push(sp)
        }
      }
    }
  }
  return out
}
