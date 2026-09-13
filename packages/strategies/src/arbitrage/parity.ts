/**
 * 平价套利矩阵（Put-Call Parity Arbitrage）。
 *
 * 欧式期权恒等式：C + K·e^{-rT} = P + S₀·e^{-qT}  →  C − P = S₀·e^{-qT} − K·e^{-rT}
 * 偏差 deviation = (C − P) − (S₀·e^{-qT} − K·e^{-rT})：
 *   deviation > 0（call 相对贵）→ 卖合成(卖C买P)、买现货远(买标的借K)：方向 sell_synthetic_buy_spot
 *   deviation < 0（put 相对贵）→ 买合成(买C卖P)、卖现货远(卖标的贷K)：方向 buy_synthetic_sell_spot
 */
import type {
  ArbitrageChain,
  ArbitrageLeg,
  ArbitrageOpportunity,
  ArbitrageQuoteRow,
} from './types.ts'
import { yearsToExpiry, discountFactor } from './time.ts'
import { midOrLast, execPrices } from './prices.ts'

export interface ParityOptions {
  /** 连续无风险利率（年化），默认 0.02 */
  rate?: number
  /** 连续股息率（年化），默认 0 */
  dividendYield?: number
  /** 偏差阈值（元/股），低于此不计为机会，默认 0.005 */
  threshold?: number
  /** 单边交易费估算（元/张），用于扣除，默认 0 */
  feePerContract?: number
  /** 合约乘数，默认 10000 */
  multiplier?: number
  /** 评估时点 YYYY-MM-DD，默认取 chain.asOf 或 now */
  asOf?: string
}

export interface ParityRow {
  readonly strike: number
  readonly callMid: number
  readonly putMid: number
  /** 合成远期多头 C − P（中间价） */
  readonly syntheticForward: number
  /** 现货远期 S₀·e^{-qT} − K·e^{-rT} */
  readonly cashForward: number
  /** 中间价偏差 */
  readonly deviation: number
  readonly direction: 'call_rich' | 'put_rich' | 'fair'
  /** 可执行边界中的最大正值（元/股，费前） */
  readonly edgePerShare: number
  readonly executable: boolean
  readonly legs: readonly ArbitrageLeg[]
}

export function parityMatrix(chain: ArbitrageChain, options: ParityOptions = {}): ParityRow[] {
  const rate = options.rate ?? 0.02
  const q = options.dividendYield ?? 0
  const asOf = options.asOf ?? chain.asOf
  const T = yearsToExpiry(chain.expiryDate, asOf)
  if (chain.spot === undefined || T === undefined) return []

  const spot = chain.spot
  const cashForwardBase = spot * discountFactor(q, T) // S₀·e^{-qT}
  const kDisc = (K: number): number => K * discountFactor(rate, T) // K·e^{-rT}

  const callsByStrike = new Map<number, ArbitrageQuoteRow>()
  for (const c of chain.calls) callsByStrike.set(c.strike, c)
  const putsByStrike = new Map<number, ArbitrageQuoteRow>()
  for (const p of chain.puts) putsByStrike.set(p.strike, p)

  const rows: ParityRow[] = []
  for (const [strike, call] of callsByStrike) {
    const put = putsByStrike.get(strike)
    if (put === undefined) continue
    const cMid = midOrLast(call)
    const pMid = midOrLast(put)
    if (cMid === undefined || pMid === undefined) continue

    const synthetic = cMid - pMid
    const cashForward = cashForwardBase - kDisc(strike)
    const deviation = synthetic - cashForward

    const cExec = execPrices(call)
    const pExec = execPrices(put)
    const executable = cExec.executable && pExec.executable

    // 卖合成(卖C买P)+买现货远：利润 = (C_bid − P_ask) − cashForward
    const edgeSellSynth = (cExec.bid - pExec.ask) - cashForward
    // 买合成(买C卖P)+卖现货远：利润 = cashForward − (C_ask − P_bid)
    const edgeBuySynth = cashForward - (cExec.ask - pExec.bid)

    let direction: ParityRow['direction'] = 'fair'
    let edgePerShare = 0
    let legs: ArbitrageLeg[] = []
    if (deviation > 0) {
      direction = 'call_rich'
      edgePerShare = executable ? edgeSellSynth : deviation
      legs = [
        { code: call.code, right: 'C', action: 'sell', strike },
        { code: put.code, right: 'P', action: 'buy', strike },
      ]
    } else if (deviation < 0) {
      direction = 'put_rich'
      edgePerShare = executable ? edgeBuySynth : -deviation
      legs = [
        { code: call.code, right: 'C', action: 'buy', strike },
        { code: put.code, right: 'P', action: 'sell', strike },
      ]
    }
    rows.push({
      strike,
      callMid: cMid,
      putMid: pMid,
      syntheticForward: synthetic,
      cashForward,
      deviation,
      direction,
      edgePerShare,
      executable,
      legs,
    })
  }
  return rows
}

export function scanParityArbitrage(chain: ArbitrageChain, options: ParityOptions = {}): ArbitrageOpportunity[] {
  const threshold = options.threshold ?? 0.005
  const multiplier = options.multiplier ?? 10000
  const fee = options.feePerContract ?? 0
  const rows = parityMatrix(chain, options)
  const out: ArbitrageOpportunity[] = []
  for (const r of rows) {
    if (r.direction === 'fair') continue
    const netEdge = r.edgePerShare * multiplier - 2 * fee // 两腿各一费
    if (netEdge <= threshold * multiplier) continue
    const direction: ArbitrageOpportunity['direction'] =
      r.direction === 'call_rich' ? 'sell_synthetic_buy_spot' : 'buy_synthetic_sell_spot'
    out.push({
      kind: 'parity',
      underlying: chain.underlying,
      expiryMonth: chain.expiryMonth,
      strike: r.strike,
      edgePerShare: r.edgePerShare,
      edgePerContract: r.edgePerShare * multiplier,
      direction,
      legs: r.legs,
      note: `平价偏离 ${r.deviation.toFixed(4)} 元/股，方向=${r.direction}`,
      executable: r.executable,
    })
  }
  out.sort((a, b) => b.edgePerContract - a.edgePerContract)
  return out
}
