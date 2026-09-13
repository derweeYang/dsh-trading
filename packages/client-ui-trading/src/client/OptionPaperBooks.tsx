/**
 * 期权虚拟账户分区（2026-09-13 WB-15，资产面板新股页签）。
 *
 * 交接口径：`docs/workbuddy-handoff-2026-09-13-option-paper-books.md`——
 * **交接面 = 桥 JSON，账本逻辑全部在后端，前端只读展示**。
 * 后端（Cursor/Claude 泳道）已把期权纸账户升级为双账本（strategy 策略 /
 * arbitrage 套利，各 10 万），由宿主 30s 心跳 `optionCycleTick` 自动驱动，
 * 桥已开放 4 条路由（accounts / account / fills / reset）。本组件只消费。
 *
 * 三条纪律（直接来自交接单，别自行「优化」掉）：
 * 1. **不自己触发心跳**：`optionCycleTick` 由宿主驱动，页面唯一动作是 30s 轮询
 *    只读端点；`POST /options/cycles/tick` 是回放/调试口，资产面板不调。
 * 2. **不做金额换算**：`cash` / `equity` / `realizedPnl` / `premiumCny` /
 *    `marginCny` / `cashAfter` 一律直接展示——后端已按「期权腿 ×10000、现货腿
 *    不乘乘数」的口径算好，前端任何再乘除都会把口径搞错。唯一派生量是
 *    `(equity − initialCash) / initialCash` 的收益率（交接单 §C2 明确要求）。
 * 3. **重置必须二次确认**，且按账本单独进行（回 10 万），不是把两个账本一起清。
 *
 * 失败诚实：桥缺席 / 业务错误 → 出错误码原文，不画「权益 0」——把故障显示成
 * 事实是这类只读面板最坏的失真（同 `OptionsOverview` 的处理）。
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { OptionPaperBookId, OptionPaperBookWire, PaperFill, PaperLegFill, PaperPosition } from '@dshtrading/api'
import {
  OPTION_PAPER_FILLS_LIMIT, fetchOptionPaperAccounts, fetchOptionPaperFills, resetOptionPaper,
} from './api.ts'
import { IconChevronRight } from './icons.tsx'
import { colorModeStore } from './color-mode.ts'
import type { ColorMode } from './color-mode.ts'
import type { MarketLocaleKey } from './contract.ts'
import { directionColor, fmtPrice, fmtPercent } from './format.ts'
import { usePoll } from './usePoll.ts'
import {
  BOOK_KEY, OFFSET_KEY, PRICE_SOURCE_KEY, arbDirectionKey, bookReturnRatio, expiryDaysLeft,
  fillRowKey, isExpiringSoon, isSpotLeg, legUnitKey, paperReasonKey, paperReasonKind,
  paperTemplateKey, positionRowKey, strikeLabel,
} from './option-paper-view.ts'
import css from './holdings-panel.module.css'
import own from './option-paper-books.module.css'

/** 翻译函数形状（与 HoldingsPanel / OptionsOverview 同构；本组件不引面板模块，避免值循环）。 */
export type OptionPaperBooksTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionPaperBooksProps {
  t: OptionPaperBooksTranslate
}

/** 期权纸账户轮询周期：与宿主心跳同频（30s），不更密——账本每跳最多动一次。 */
const POLL_MS = 30_000

const BOOK_ORDER: readonly OptionPaperBookId[] = ['arbitrage', 'strategy']

/** 腿的买卖标签走既有交易词典（不新造一份）。 */
const SIDE_KEY: Record<'buy' | 'sell', MarketLocaleKey> = { buy: 'trade.buy', sell: 'trade.sell' }

function LegRow({ t, leg, colorMode }: {
  t: OptionPaperBooksTranslate
  leg: PaperLegFill
  colorMode: ColorMode
}): React.JSX.Element {
  const spot = isSpotLeg(leg)
  return (
    <div className={own.legRow} data-leg-asset={spot ? 'spot' : 'option'}>
      <span className={own.sidePill} style={{ color: directionColor(leg.side === 'buy' ? 1 : -1, colorMode) }}>
        {t(SIDE_KEY[leg.side])}
      </span>
      <span className={own.legCode}>{leg.code}</span>
      {spot && <span className={own.tag}>{t('trade.optPaper.leg.spot')}</span>}
      {leg.spotSymbol !== undefined && <span className={own.legCode}>{leg.spotSymbol}</span>}
      <span className={own.legSpacer} />
      <span className={own.num}>{leg.qty}</span>
      <span className={own.legUnit}>{t(legUnitKey(leg))}</span>
      <span className={own.num}>{fmtPrice(leg.fillPrice)}</span>
      {leg.priceSource !== undefined && <span className={own.tag}>{t(PRICE_SOURCE_KEY[leg.priceSource])}</span>}
    </div>
  )
}

function PositionCard({ t, position, colorMode, nowMs }: {
  t: OptionPaperBooksTranslate
  position: PaperPosition
  colorMode: ColorMode
  nowMs: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const templateLabel = paperTemplateKey(position.template)
  const directionLabel = arbDirectionKey(position.direction)
  const strikes = strikeLabel(position)
  const daysLeft = expiryDaysLeft(position.expiryDate, nowMs)
  const expiring = isExpiringSoon(position.expiryDate, nowMs)
  return (
    <div className={own.posRow} data-opt-paper-position={positionRowKey(position)} data-template={position.template}>
      <div className={own.posRowHead}>
        <button
          type="button"
          className={own.caretBtn}
          aria-expanded={open}
          aria-label={t('trade.optPaper.legs')}
          data-opt-paper-legs-toggle=""
          onClick={() => setOpen(v => !v)}
        >
          <span className={own.caret} data-expanded={open ? 'true' : undefined}><IconChevronRight size={11} /></span>
        </button>
        <span className={own.posSymbol}>{position.underlying}</span>
        {templateLabel !== undefined
          ? <span className={own.tag}>{t(templateLabel)}</span>
          : <span className={own.tagMono}>{position.template}</span>}
        {directionLabel !== undefined && <span className={own.tag}>{t(directionLabel)}</span>}
        <span className={own.headSpacer} />
        {expiring && <span className={own.expiringBadge}>{t('trade.optPaper.expiring')}</span>}
      </div>
      <div className={own.posMeta}>
        <span>{t('trade.optPaper.col.strikes')}{' '}
          <span className={own.num}>{strikes ?? '—'}</span></span>
        <span>{t('trade.optPaper.col.expiry')}{' '}
          <span className={own.num} data-opt-paper-expiry-days={daysLeft === undefined ? undefined : String(daysLeft)}>
            {position.expiryDate ?? '—'}
          </span></span>
        <span>{t('trade.optPaper.col.qty')}{' '}
          <span className={own.num}>{position.qty}</span></span>
        <span>{t('trade.optPaper.col.openEdge')}{' '}
          <span className={own.num}>{position.openEdgePerShare !== undefined ? fmtPrice(position.openEdgePerShare) : '—'}</span></span>
        <span>{t('trade.optPaper.col.margin')}{' '}
          <span className={own.num}>{fmtPrice(position.marginCny)}</span></span>
        {position.invalidIf !== '' && <span className={own.invalidIf} title={position.invalidIf}>{position.invalidIf}</span>}
      </div>
      {open && (
        <div className={own.legList}>
          {position.legs.map((leg, idx) => (
            <LegRow key={position.id + '#leg' + String(idx)} t={t} leg={leg} colorMode={colorMode} />
          ))}
        </div>
      )}
    </div>
  )
}

function BookCard({ t, book, colorMode, nowMs, onReset }: {
  t: OptionPaperBooksTranslate
  book: OptionPaperBookWire
  colorMode: ColorMode
  nowMs: number
  onReset: (book: OptionPaperBookId) => void
}): React.JSX.Element {
  const ratio = bookReturnRatio(book.account.initialCash, book.equity)
  return (
    <div className={own.bookCard} data-opt-paper-book={book.book}>
      <div className={own.bookHead}>
        <span className={own.bookName}>{t(BOOK_KEY[book.book])}</span>
        <span className={own.bookBadge}>
          {t('trade.optPaper.positionsCount', { count: book.positions.length })}
        </span>
        <span className={own.headSpacer} />
        <button
          type="button"
          className={css.ghostBtn}
          data-opt-paper-reset={book.book}
          title={t('trade.optPaper.reset')}
          onClick={() => onReset(book.book)}
        >
          {t('trade.optPaper.reset')}
        </button>
      </div>
      <div className={own.metrics}>
        <span className={own.metric}>
          <span className={own.metricLabel}>{t('trade.optPaper.cash')}</span>
          <span className={own.metricValue}>{fmtPrice(book.account.cash)}</span>
        </span>
        <span className={own.metric}>
          <span className={own.metricLabel}>{t('trade.optPaper.equity')}</span>
          <span className={own.metricValue}>{fmtPrice(book.equity)}</span>
        </span>
        <span className={own.metric}>
          <span className={own.metricLabel}>{t('trade.optPaper.initialCash')}</span>
          <span className={own.metricValue}>{fmtPrice(book.account.initialCash)}</span>
        </span>
        <span className={own.metric}>
          <span className={own.metricLabel}>{t('trade.optPaper.realized')}</span>
          <span
            className={own.metricValue}
            style={{ color: directionColor(book.account.realizedPnl, colorMode) }}
            data-opt-paper-realized={String(book.account.realizedPnl)}
          >
            {(book.account.realizedPnl >= 0 ? '+' : '') + fmtPrice(book.account.realizedPnl)}
          </span>
        </span>
        <span className={own.metric}>
          <span className={own.metricLabel}>{t('trade.optPaper.returnRate')}</span>
          <span
            className={own.metricValue}
            style={{ color: ratio === undefined ? undefined : directionColor(ratio, colorMode) }}
            data-opt-paper-return={ratio === undefined ? undefined : String(ratio)}
          >
            {ratio === undefined ? '—' : (ratio >= 0 ? '+' : '') + fmtPercent(ratio * 100)}
          </span>
        </span>
      </div>
      {book.positions.length === 0
        ? <div className={own.bookEmpty}>{t('trade.optPaper.empty')}</div>
        : book.positions.map(position => (
          <PositionCard
            key={positionRowKey(position)}
            t={t}
            position={position}
            colorMode={colorMode}
            nowMs={nowMs}
          />
        ))}
    </div>
  )
}

function FillRow({ t, fill, book, colorMode }: {
  t: OptionPaperBooksTranslate
  fill: PaperFill
  book: OptionPaperBookId
  colorMode: ColorMode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const reasonLabel = paperReasonKey(fill.reason)
  const kind = paperReasonKind(fill.reason)
  const templateLabel = paperTemplateKey(fill.template)
  return (
    <div className={own.fillRow} data-opt-paper-fill={fill.id} data-fill-reason={fill.reason}>
      <div className={own.fillHead}>
        <button
          type="button"
          className={own.caretBtn}
          aria-expanded={open}
          aria-label={t('trade.optPaper.legs')}
          disabled={fill.legs.length === 0}
          data-opt-paper-fill-toggle=""
          onClick={() => setOpen(v => !v)}
        >
          <span className={own.caret} data-expanded={open ? 'true' : undefined}><IconChevronRight size={11} /></span>
        </button>
        <span className={own.timeCell}>{new Date(fill.asOf).toLocaleString()}</span>
        <span className={own.fillUnderlying}>{fill.underlying ?? '—'}</span>
        {fill.template !== undefined && (templateLabel !== undefined
          ? <span className={own.tag}>{t(templateLabel)}</span>
          : <span className={own.tagMono}>{fill.template}</span>)}
        {reasonLabel !== undefined && (
          <span className={own.reasonBadge} data-reason-kind={kind}>{t(reasonLabel)}</span>
        )}
        <span className={own.headSpacer} />
        <span className={own.num}>{fill.premiumCny >= 0 ? '+' : ''}{fmtPrice(fill.premiumCny)}</span>
      </div>
      <div className={own.posMeta}>
        <span>{t(OFFSET_KEY[fill.offset])}</span>
        <span>{t('trade.optPaper.col.qty')} <span className={own.num}>{fill.qty}</span></span>
        <span>{t('trade.optPaper.col.premium')} <span className={own.num}>{fmtPrice(fill.premiumCny)}</span></span>
        <span>{t('trade.optPaper.col.fee')} <span className={own.num}>{fmtPrice(fill.feeCny ?? 0)}</span></span>
        <span>{t('trade.optPaper.col.cashAfter')} <span className={own.num}>{fmtPrice(fill.cashAfter)}</span></span>
      </div>
      {open && fill.legs.length > 0 && (
        <div className={own.legList}>
          {fill.legs.map((leg, idx) => (
            <LegRow key={fillRowKey(book, fill.id, idx)} t={t} leg={leg} colorMode={colorMode} />
          ))}
        </div>
      )}
    </div>
  )
}

export function OptionPaperBooks({ t }: OptionPaperBooksProps): React.JSX.Element {
  const [books, setBooks] = useState<readonly OptionPaperBookWire[] | null>(null)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)
  const [fillsBook, setFillsBook] = useState<OptionPaperBookId>('strategy')
  const [fills, setFills] = useState<readonly PaperFill[] | null>(null)
  const [resetFailure, setResetFailure] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)

  // 30s 轮询两账本（挂载即拉、卸载即停、页面不可见暂停由 usePoll 承担）。
  // 失败记账但不回滚已渲染的账本：单次抖动不该把已有权益数字抹成空态；
  // 首次就失败（books 仍为 null）才把错误码摆到台上。
  usePoll(() => {
    void fetchOptionPaperAccounts().then((res) => {
      if (res.ok) {
        setBooks(res.data.books)
        setFailure(null)
      } else {
        setFailure({ code: res.code, message: res.message })
      }
      setNowMs(Date.now())
    })
  }, POLL_MS, [])

  // 流水与账户解耦轮询（切账本立即重拉；limit 与桥缺省一致）。
  usePoll(() => {
    void fetchOptionPaperFills(fillsBook, OPTION_PAPER_FILLS_LIMIT).then((res) => {
      if (res.ok) setFills(res.data)
    })
  }, POLL_MS, [fillsBook])

  const onReset = (book: OptionPaperBookId): void => {
    if (typeof window === 'undefined') return
    if (!window.confirm(t('trade.optPaper.resetConfirm', { book: t(BOOK_KEY[book]) }))) return
    setResetFailure(false)
    void resetOptionPaper(book).then((res) => {
      if (!res.ok) {
        setResetFailure(true)
        return
      }
      // 回包即该账本的新快照：就地替换，不等下一跳轮询。
      setBooks(prev => prev === null
        ? [res.data]
        : prev.map(item => (item.book === res.data.book ? res.data : item)))
      setNowMs(Date.now())
      void fetchOptionPaperFills(book, OPTION_PAPER_FILLS_LIMIT).then((fillsRes) => {
        if (fillsRes.ok && fillsBook === book) setFills(fillsRes.data)
      })
    })
  }

  const ordered = useMemo(() => {
    if (books === null) return null
    const byId = new Map(books.map(b => [b.book, b]))
    // 桥按 [arbitrage, strategy] 回；这里按固定顺序渲染并容忍缺账本。
    return BOOK_ORDER.flatMap(id => {
      const found = byId.get(id)
      return found === undefined ? [] : [found]
    })
  }, [books])

  const unavailable = ordered === null && failure !== null

  return (
    <div className={own.root} data-dshtrading-option-paper-books="">
      <div className={own.heading}>{t('trade.optPaper.title')}</div>
      <div className={own.hint}>{t('trade.optPaper.hint')}</div>
      {ordered === null && !unavailable && (
        <div className={css.empty}>{t('trade.optPaper.loading')}</div>
      )}
      {unavailable && failure !== null && (
        <div className={own.errorRow} role="alert" data-opt-paper-failure={failure.code}>
          {t('trade.optPaper.unavailable', { code: failure.code })}
        </div>
      )}
      {ordered !== null && ordered.length === 0 && failure === null && (
        <div className={css.empty}>{t('trade.optPaper.empty')}</div>
      )}
      {ordered?.map(book => (
        <BookCard
          key={book.book}
          t={t}
          book={book}
          colorMode={colorMode}
          nowMs={nowMs}
          onReset={onReset}
        />
      ))}
      {resetFailure && <div className={own.errorRow} role="alert">{t('trade.optPaper.resetFailed')}</div>}

      <div className={css.sectionTitle}>{t('trade.optPaper.fills.title')}</div>
      <div className={css.chips}>
        {BOOK_ORDER.map(id => (
          <button
            key={id}
            type="button"
            className={css.chip}
            data-active={fillsBook === id ? 'true' : undefined}
            data-opt-paper-fills-book={id}
            onClick={() => setFillsBook(id)}
          >
            {t(BOOK_KEY[id])}
          </button>
        ))}
      </div>
      {fills === null
        ? <div className={css.empty}>{t('trade.optPaper.loading')}</div>
        : fills.length === 0
          ? <div className={css.empty}>{t('trade.optPaper.fills.empty')}</div>
          : fills.map((fill, idx) => (
            <FillRow key={fillRowKey(fillsBook, fill.id, idx)} t={t} fill={fill} book={fillsBook} colorMode={colorMode} />
          ))}

      <div className={own.disclaimer}>{t('trade.optPaper.disclaimer')}</div>
    </div>
  )
}
