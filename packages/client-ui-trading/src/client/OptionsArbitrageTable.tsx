/**
 * 套利机会表（2026-09-13 WB-13；同日二轮增强：分类显示 + 盈利>50 过滤 + 收益排序/前10 + 点击看组合）。
 * 在 T 板内对当前期权链运行 scanArbitrage（平价 + 箱型，无风险）与 scanVerticalSpreads
 * （方向性价差，非无风险），全部浏览器内计算（@dshtrading/strategies 纯库）。
 *
 * 输入 = OptionsStage 已加载的 OptionChain，经 fromOptionChain 适配后喂入内核。
 * 因为实时链（api.OptionQuoteRow）无 bid/ask，内核 executable 通常为 false → 显示「理论估算」，
 * 并附 theoryNote 提示以可成交价复核（不伪造可执行性）。
 *
 * 增强要点：
 *  - 按套利机会分类显示：平价套利 / 箱型套利 各自成组（垂直价差仍走独立折叠区）。
 *  - 默认只显示「套利收益 > 50 元/张」的机会（收益 = edgePerContract）；「显示全部机会」揭示其余。
 *    内核默认 threshold（0.005/股=50/张）会把 ≤50 直接剔除，故前端主动申请更低的透传下限
 *    （PASS_THROUGH_THRESHOLD），由前端独享 50 这道默认闸门。
 *  - 每组默认按收益从大到小排序、只显示前 10 条，「显示更多」逐级展开（+10）。
 *  - 点击任一行 → 展开「具体操作组合」（各腿买卖/认购认沽/行权价/合约代码；平价另附现货腿）。
 *
 * 本页技术与行情分析面，不构成投资建议。
 */
import { Fragment, useMemo, useState } from 'react'
import type { OptionChain } from '@dshtrading/api'
import {
  fromOptionChain,
  scanArbitrage,
  scanVerticalSpreads,
  type ArbitrageDirection,
  type ArbitrageLeg,
  type ArbitrageOpportunity,
  type VerticalSpread,
} from '@dshtrading/strategies'
import type { MarketLocaleKey } from './contract.ts'
import { fmtPrice } from './format.ts'
import css from './options-arbitrage.module.css'

export type OptionsArbitrageTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 默认只显示套利收益 > 该值（元/张）的机会；其余折叠到「显示全部机会」里。 */
const MIN_EDGE_PER_CONTRACT = 50
/** 前端向内核申请的透传下限（元/股），低于此视为噪声不计入；与后端默认阈值解耦。 */
const PASS_THROUGH_THRESHOLD = 0.0001
/** 每组默认显示行数；「显示更多」每次追加的行数。 */
const DEFAULT_VISIBLE_ROWS = 10
const ROWS_STEP = 10

function directionKey(d: ArbitrageDirection): MarketLocaleKey {
  switch (d) {
    case 'sell_synthetic_buy_spot': return 'options.arbitrage.dir.sell_synthetic_buy_spot'
    case 'buy_synthetic_sell_spot': return 'options.arbitrage.dir.buy_synthetic_sell_spot'
    case 'long_box': return 'options.arbitrage.dir.long_box'
    case 'short_box': return 'options.arbitrage.dir.short_box'
  }
}

function kindKey(kind: ArbitrageOpportunity['kind']): MarketLocaleKey {
  return kind === 'parity' ? 'options.arbitrage.kind.parity' : 'options.arbitrage.kind.box'
}

function rightKey(right: 'C' | 'P'): MarketLocaleKey {
  return right === 'C' ? 'options.arbitrage.right.call' : 'options.arbitrage.right.put'
}

function actionKey(action: 'buy' | 'sell'): MarketLocaleKey {
  return action === 'buy' ? 'options.arbitrage.leg.buy' : 'options.arbitrage.leg.sell'
}

function strikeRange(low: number | undefined, high: number | undefined): string {
  const lo = low !== undefined ? fmtPrice(low) : '—'
  const hi = high !== undefined ? fmtPrice(high) : '—'
  return `${lo}–${hi}`
}

function strikesCell(o: ArbitrageOpportunity): string {
  return o.kind === 'parity'
    ? (o.strike !== undefined ? fmtPrice(o.strike) : '—')
    : strikeRange(o.lowStrike, o.highStrike)
}

/** 具体操作组合：每腿 = 动作 + 认购/认沽 + 行权价 + 合约代码；平价另附现货腿。 */
function describeLegs(o: ArbitrageOpportunity, t: OptionsArbitrageTranslate): string[] {
  const lines = o.legs.map(
    (l: ArbitrageLeg) => `${t(actionKey(l.action))} ${t(rightKey(l.right))} ${fmtPrice(l.strike)} (${l.code})`,
  )
  if (o.kind === 'parity') {
    const spotKey: MarketLocaleKey = o.direction === 'sell_synthetic_buy_spot'
      ? 'options.arbitrage.leg.spotBuy'
      : 'options.arbitrage.leg.spotSell'
    lines.push(`${t(spotKey)} ${o.underlying}`)
  }
  return lines
}

/** 单行稳定 key（过滤/展开时行会重排，用内容而非下标）。 */
function rowKey(o: ArbitrageOpportunity): string {
  return `${o.kind}-${o.strike ?? ''}-${o.lowStrike ?? ''}-${o.highStrike ?? ''}-${o.direction}`
}

/** 单个套利分类组（平价 / 箱型）：独立小标题 + 表格 + 前10/显示更多 + 行内展开组合。 */
function ArbGroup({ kind, rows, t }: {
  kind: ArbitrageOpportunity['kind']
  rows: readonly ArbitrageOpportunity[]
  t: OptionsArbitrageTranslate
}): React.JSX.Element {
  const [limit, setLimit] = useState(DEFAULT_VISIBLE_ROWS)
  const [expanded, setExpanded] = useState<string | null>(null)

  // 默认按套利收益（元/张）从大到小排序。
  const sorted = useMemo(() => [...rows].sort((a, b) => b.edgePerContract - a.edgePerContract), [rows])
  const shown = sorted.slice(0, limit)
  const remaining = sorted.length - shown.length

  return (
    <div className={css.group} data-arb-group={kind}>
      <div className={css.groupTitle}>{t(kindKey(kind))}</div>
      <table className={css.table}>
        <thead>
          <tr>
            <th>{t('options.arbitrage.col.strikes')}</th>
            <th>{t('options.arbitrage.col.direction')}</th>
            <th>{t('options.arbitrage.col.profit')}</th>
            <th>{t('options.arbitrage.col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((o) => {
            const key = rowKey(o)
            const open = expanded === key
            return (
              <Fragment key={key}>
                <tr
                  className={css.rowClick}
                  data-kind={o.kind}
                  data-edge={o.edgePerContract}
                  data-arb-row={key}
                  title={t('options.arbitrage.rowHint')}
                  tabIndex={0}
                  onClick={() => { setExpanded(open ? null : key) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setExpanded(open ? null : key)
                    }
                  }}
                >
                  <td>{strikesCell(o)}</td>
                  <td>{t(directionKey(o.direction))}</td>
                  <td className={css.edge}>{fmtPrice(o.edgePerContract)}</td>
                  <td data-exec={o.executable ? 'yes' : 'no'}>
                    {o.executable ? t('options.arbitrage.exec.yes') : t('options.arbitrage.exec.no')}
                  </td>
                </tr>
                {open && (
                  <tr data-arb-combo={key}>
                    <td colSpan={4}>
                      <div className={css.combo}>
                        <div className={css.comboTitle}>
                          {`${t('options.arbitrage.combo.title')} · ${t(directionKey(o.direction))}`}
                        </div>
                        <ul className={css.legList}>
                          {describeLegs(o, t).map((line, k) => <li key={k}>{line}</li>)}
                        </ul>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {remaining > 0 && (
        <button type="button" className={css.ghostBtn} onClick={() => { setLimit(l => l + ROWS_STEP) }}>
          {t('options.arbitrage.showMore', { remaining })}
        </button>
      )}
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
                    const rightK = v.right === 'C' ? 'options.arbitrage.right.call' : 'options.arbitrage.right.put'
                    const dirK = v.direction === 'bull' ? 'options.arbitrage.dir.bull' : 'options.arbitrage.dir.bear'
                    return (
                      <tr key={i}>
                        <td>{`${t(rightK)}·${t(dirK)}`}</td>
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
