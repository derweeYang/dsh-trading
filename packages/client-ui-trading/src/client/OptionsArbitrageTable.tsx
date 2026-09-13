/**
 * 套利机会表（2026-09-13 WB-13，2026-09-13 增强：分类显示 + 盈利>50 默认过滤）。
 * 在 T 板内对当前期权链运行 scanArbitrage（平价 + 箱型，无风险）与 scanVerticalSpreads
 * （方向性价差，非无风险），全部浏览器内计算（@dshtrading/strategies 纯库）。
 *
 * 输入 = OptionsStage 已加载的 OptionChain，经 fromOptionChain 适配后喂入内核。
 * 因为实时链（api.OptionQuoteRow）无 bid/ask，内核 executable 通常为 false → 显示「理论估算」，
 * 并附 theoryNote 提示以可成交价复核（不伪造可执行性）。
 *
 * 本次增强：
 *  - 按套利机会分类显示：平价套利 / 箱型套利 各自成组（垂直价差仍走独立折叠区）。
 *  - 默认只显示「盈利 > 50 元/张」的机会；「显示全部机会」按钮揭示其余（盈利≤50 的边际机会）。
 *    内核默认 threshold（0.005/股=50/张）会把盈利≤50 直接剔除，故前端主动申请更低的透传下限
 *    （PASS_THROUGH_THRESHOLD），由前端独享 50 这道默认闸门，与后端路由解耦。
 *
 * 本页技术与行情分析面，不构成投资建议。
 */
import { useMemo, useState } from 'react'
import type { OptionChain } from '@dshtrading/api'
import {
  fromOptionChain,
  scanArbitrage,
  scanVerticalSpreads,
  type ArbitrageDirection,
  type ArbitrageOpportunity,
  type VerticalSpread,
} from '@dshtrading/strategies'
import type { MarketLocaleKey } from './contract.ts'
import { fmtPrice } from './format.ts'
import css from './options-arbitrage.module.css'

export type OptionsArbitrageTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 默认只显示盈利 > 该值（元/张）的套利机会；其余折叠到「显示全部机会」里。 */
const MIN_EDGE_PER_CONTRACT = 50
/** 前端向内核申请的透传下限（元/股），低于此视为噪声不计入；与后端默认阈值解耦。 */
const PASS_THROUGH_THRESHOLD = 0.0001

function directionKey(d: ArbitrageDirection): MarketLocaleKey {
  switch (d) {
    case 'sell_synthetic_buy_spot': return 'options.arbitrage.dir.sell_synthetic_buy_spot'
    case 'buy_synthetic_sell_spot': return 'options.arbitrage.dir.buy_synthetic_sell_spot'
    case 'long_box': return 'options.arbitrage.dir.long_box'
    case 'short_box': return 'options.arbitrage.dir.short_box'
  }
}

function strikeRange(low: number | undefined, high: number | undefined): string {
  const lo = low !== undefined ? fmtPrice(low) : '—'
  const hi = high !== undefined ? fmtPrice(high) : '—'
  return `${lo}–${hi}`
}

function kindKey(kind: ArbitrageOpportunity['kind']): MarketLocaleKey {
  return kind === 'parity' ? 'options.arbitrage.kind.parity' : 'options.arbitrage.kind.box'
}

/** 单个套利分类组（平价 / 箱型），独立小标题 + 表格。 */
function ArbGroup({ kind, rows, t }: {
  kind: ArbitrageOpportunity['kind']
  rows: readonly ArbitrageOpportunity[]
  t: OptionsArbitrageTranslate
}): React.JSX.Element {
  return (
    <div className={css.group}>
      <div className={css.groupTitle}>{t(kindKey(kind))}</div>
      <table className={css.table}>
        <thead>
          <tr>
            <th>{t('options.arbitrage.col.strikes')}</th>
            <th>{t('options.arbitrage.col.direction')}</th>
            <th>{t('options.arbitrage.col.edgePerContract')}</th>
            <th>{t('options.arbitrage.col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o, i) => (
            <tr key={i} data-kind={o.kind} data-edge={o.edgePerContract}>
              <td>{o.kind === 'parity' ? (o.strike !== undefined ? fmtPrice(o.strike) : '—') : strikeRange(o.lowStrike, o.highStrike)}</td>
              <td>{t(directionKey(o.direction))}</td>
              <td className={css.edge}>{fmtPrice(o.edgePerContract)}</td>
              <td data-exec={o.executable ? 'yes' : 'no'}>
                {o.executable ? t('options.arbitrage.exec.yes') : t('options.arbitrage.exec.no')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface OptionsArbitrageTableProps {
  t: OptionsArbitrageTranslate
  /** OptionsStage 已加载的期权链（含 spot / expiryDate 时内核才会产出机会）。 */
  chain: OptionChain
  /** 合约乘数（1 张 = multiplier 份 ETF）。 */
  multiplier: number
}

export function OptionsArbitrageTable({ t, chain, multiplier }: OptionsArbitrageTableProps): React.JSX.Element {
  const arb = useMemo(
    () => scanArbitrage(fromOptionChain(chain), { multiplier, threshold: PASS_THROUGH_THRESHOLD }),
    [chain, multiplier],
  )
  const vert = useMemo(() => scanVerticalSpreads(fromOptionChain(chain)), [chain])
  const [showVertical, setShowVertical] = useState(false)
  const [onlyProfitable, setOnlyProfitable] = useState(true)

  const parity = useMemo(() => arb.filter(o => o.kind === 'parity'), [arb])
  const box = useMemo(() => arb.filter(o => o.kind === 'box'), [arb])

  const visibleParity = useMemo(
    () => onlyProfitable ? parity.filter(o => o.edgePerContract > MIN_EDGE_PER_CONTRACT) : parity,
    [parity, onlyProfitable],
  )
  const visibleBox = useMemo(
    () => onlyProfitable ? box.filter(o => o.edgePerContract > MIN_EDGE_PER_CONTRACT) : box,
    [box, onlyProfitable],
  )

  const total = parity.length + box.length
  const hidden = total - (visibleParity.length + visibleBox.length)
  const allExecutable = arb.length > 0 && arb.every(o => o.executable)
  const hasVisible = visibleParity.length + visibleBox.length > 0

  return (
    <section className={css.root} data-dshtrading-options-arbitrage="">
      <div className={css.head}>
        <span className={css.title}>{t('options.arbitrage.title')}</span>
        <span className={css.hint}>{t('options.arbitrage.hint')}</span>
      </div>

      {total === 0
        ? <div className={css.notice}>{t('options.arbitrage.none')}</div>
        : (
          <>
            <div className={css.filterRow}>
              <button type="button" className={css.ghostBtn} onClick={() => { setOnlyProfitable(v => !v) }}>
                {onlyProfitable ? t('options.arbitrage.filter.showAll') : t('options.arbitrage.filter.onlyProfitable')}
              </button>
              <span className={css.hint}>
                {hidden > 0
                  ? t('options.arbitrage.filter.hintHidden', { shown: visibleParity.length + visibleBox.length, hidden, total })
                  : t('options.arbitrage.filter.hintAll', { total })}
              </span>
            </div>

            {visibleParity.length > 0 && <ArbGroup kind="parity" rows={visibleParity} t={t} />}
            {visibleBox.length > 0 && <ArbGroup kind="box" rows={visibleBox} t={t} />}

            {!hasVisible && (
              <div className={css.notice}>{t('options.arbitrage.filter.noneVisible', { total })}</div>
            )}

            {!allExecutable && <div className={css.theory}>{t('options.arbitrage.theoryNote')}</div>}
          </>
        )}

      <div className={css.verticalHead}>
        <button type="button" className={css.ghostBtn} onClick={() => { setShowVertical(v => !v) }}>
          {showVertical ? t('options.arbitrage.hideVertical') : t('options.arbitrage.showVertical')}
        </button>
        <span className={css.hint}>{t('options.arbitrage.verticalNote')}</span>
      </div>

      {showVertical && (
        vert.length === 0
          ? <div className={css.notice}>{t('options.arbitrage.verticalNone')}</div>
          : (
            <>
              <div className={css.verticalTitle}>{t('options.arbitrage.verticalTitle')}</div>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('options.arbitrage.col.kind')}</th>
                    <th>{t('options.arbitrage.col.strikes')}</th>
                    <th>{t('options.arbitrage.col.spread')}</th>
                    <th>{t('options.arbitrage.col.netDebit')}</th>
                    <th>{t('options.arbitrage.col.breakeven')}</th>
                    <th>{t('options.arbitrage.col.maxProfit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {vert.map((v: VerticalSpread, i) => {
                    const rightKey = v.right === 'C' ? 'options.arbitrage.right.call' : 'options.arbitrage.right.put'
                    const dirKey = v.direction === 'bull' ? 'options.arbitrage.dir.bull' : 'options.arbitrage.dir.bear'
                    return (
                      <tr key={i}>
                        <td>{`${t(rightKey)}·${t(dirKey)}`}</td>
                        <td>{strikeRange(v.lowStrike, v.highStrike)}</td>
                        <td>{fmtPrice(v.highStrike - v.lowStrike)}</td>
                        <td className={v.netDebit >= 0 ? css.debit : css.credit}>{fmtPrice(v.netDebit)}</td>
                        <td>{fmtPrice(v.breakeven)}</td>
                        <td>{fmtPrice(v.maxProfitPerShare)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )
      )}
    </section>
  )
}
