/**
 * 5 分钟闭环时间线（2026-09-09 WB-6；交接单 §WB-6，契约 docs/options-bridge.md）。
 *
 * **页面不算箱体、不打分**——宿主 node 半每 30s 已在对齐上海 5 分钟桶
 * （`POST /options/cycles/tick` 幂等）。本组件只做两件事：
 * 1. 展示 `GET /options/cycles/loop`（九标的最新周期 + 命中率）；
 * 2. 点某标的再拉 `GET /options/cycles?limit=24` 画该标的周期历史。
 *
 * 时间关系（决定卡片怎么画，别搞反）：
 * - 本桶只写 `forecast`；**下一桶**才用已走完的 5 根 1 分钟 K 给上一桶补 `score`。
 *   所以 `latest` 通常只有 forecast，`latest.score` 缺席 = 上桶还没被评估完，
 *   此时显示「待评估」而不是伪造一个 verdict。
 * - 评估对象是「预报箱体 vs 已实现路径」，**不是实盘成交**；miss 不会也不能变成下单。
 *
 * 本页技术与行情分析面，不构成投资建议。
 */
import { useEffect, useState } from 'react'
import type {
  OptionCycle, OptionCycleLoop, OptionCycleLoopRow, OptionCycleScore, OptionIntradayBoxRow,
  OptionBarContextPacket, OptionBarContextRow,
} from '@dshtrading/api'
import type { MarketLocaleKey } from './contract.ts'
import { fetchOptionsCycles } from './api.ts'
import { fmtClock, fmtPrice } from './format.ts'
import { rankCycleRows } from './cycle-rank.ts'
import type { CycleTier } from './cycle-rank.ts'
import {
  CALIBRATION_KEY, IV_REGIME_KEY, REGIME_KEY, SESSION_REASON_KEY, TEMPLATE_KEY, TIER_KEY, VERDICT_KEY,
} from './option-vocabulary.ts'
import css from './options-cycle-loop.module.css'

export type OptionsCycleLoopTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface OptionsCycleLoopProps {
  t: OptionsCycleLoopTranslate
  /** 闭环快照；null = 未取到（原因见 failure）。 */
  loop: OptionCycleLoop | null
  failure: { code: string; message: string } | null
  /** 首个应答是否落地（区分「加载中」与「不可用」）。 */
  loaded: boolean
  /**
   * WB-12：当天最新定时桶 ContextPacket（宿主打标快照）。`null` = 无 packet 文件
   * （正常态）；组件据此**整条不渲染「智能体所见」**，不会空白报错或假装没数据。
   */
  packet?: OptionBarContextPacket | null
  /** underlying → 标的名（总览行提供；缺失回退代码）。 */
  names?: Readonly<Record<string, string>> | undefined
  /**
   * underlying → 近 5 交易日累计涨跌幅（%，由总览行 `cumulativeReturn(days)` 算出）。
   * 用于「最强 / 最弱 / 中位」三档排前（口径与 WB-9 叠图同源）；缺席则不排序、全落 rest。
   */
  cum5d?: Readonly<Record<string, number>> | undefined
  /** 展开历史条数（交接单定 24）。 */
  historyLimit?: number
}

const DEFAULT_HISTORY_LIMIT = 24

/** 桶起点 ISO → HH:mm；解析失败不显示（不拿 Date.now() 冒充）。 */
function bucketClock(bucketStart: string | undefined): string {
  if (bucketStart === undefined) return '—'
  const ms = Date.parse(bucketStart)
  return Number.isFinite(ms) ? fmtClock(ms) : '—'
}

/** 命中率条带：0–1 → 百分比宽度；缺席（样本不足）返回 undefined。 */
function hitRateWidth(hitRate: number | undefined): string | undefined {
  if (hitRate === undefined || !Number.isFinite(hitRate)) return undefined
  return `${Math.round(Math.min(Math.max(hitRate, 0), 1) * 100)}%`
}

export function OptionsCycleLoop({
  t, loop, failure, loaded, packet, names, cum5d, historyLimit = DEFAULT_HISTORY_LIMIT,
}: OptionsCycleLoopProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly OptionCycle[]>([])
  const [historyFailure, setHistoryFailure] = useState<{ code: string; message: string } | null>(null)

  // 展开才拉历史（一次性；九标的各自常驻轮询会打爆桥）。
  useEffect(() => {
    if (expanded === null) {
      setHistory([])
      setHistoryFailure(null)
      return
    }
    let cancelled = false
    void fetchOptionsCycles({ underlying: expanded, limit: historyLimit }).then((res) => {
      if (cancelled) return
      if (res.ok) {
        // 时间线按桶升序（历史在前，最新在后），与「演进」语义一致。
        setHistory([...res.data].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)))
        setHistoryFailure(null)
      } else {
        setHistory([])
        setHistoryFailure({ code: res.code, message: res.message })
      }
    })
    return () => { cancelled = true }
  }, [expanded, historyLimit])

  // 最强 / 最弱 / 中位三档排前（WB-10）；累计值缺席时原样展示，不伪造强弱。
  const ranked = loop === null ? [] : rankCycleRows(loop.rows, cum5d)
  /** WB-12：定时桶 packet 行按 underlying 对齐；null 不清空映射，渲染处据此跳过。 */
  const packetByUnderlying = packet == null
    ? undefined
    : new Map(packet.rows.map((r) => [r.underlying, r]))

  return (
    <div className={css.root} data-dshtrading-options-cycle-loop="">
      <div className={css.bar}>
        <span className={css.title}>{t('options.cycle.title')}</span>
        {loop !== null && loop.lastBucket !== undefined && (
          <span className={css.bucket}>{t('options.cycle.bucket')} {bucketClock(loop.lastBucket)}</span>
        )}
        <span className={css.spacer} />
        {/* running=false（headless / 桥未挂）如实说「未启动」，不假装在走 */}
        {loop !== null && !loop.running && (
          <span className={css.stopped}>{t('options.cycle.stopped')}</span>
        )}
      </div>

      {/* 工作流示意（静态）：L1 选场 → L2 出箱 → 等 5 分钟 → 对照已走完的 1m → 校准 → 下一桶 */}
      <div className={css.workflow}>{t('options.cycle.workflow')}</div>

      {/*
        WB-12：定时桶 ContextPacket 顶条。关键不变量——**无 packet 键时 packet 为 null，
        整条不渲染**，页面不会因为缺文件而空白报错或假装没数据。只做展示，不算制度。
      */}
      {packet != null && (
        <div className={css.packet} data-dshtrading-cycle-packet="">
          <span className={css.sectionLabel}>{t('options.loop.packetTitle')}</span>
          <span className={css.muted}>{t('options.cycle.bucket')} {bucketClock(packet.bucketStart)}</span>
        </div>
      )}

      {failure !== null
        ? <div className={css.notice}>{failure.code}: {failure.message}</div>
        : !loaded
          ? <div className={css.notice}>{t('options.cycle.loading')}</div>
          : loop === null
            ? <div className={css.notice}>{t('options.cycle.unavailable')}</div>
            : loop.rows.length === 0
              ? <div className={css.notice}>{t('options.cycle.empty')}</div>
              : (
                <div className={css.cards}>
                  {ranked.map(({ row, tier }) => (
                    <CycleCard
                      key={row.underlying}
                      t={t}
                      row={row}
                      tier={tier}
                      /** WB-12：按 underlying 对齐的定时桶 packet 行；无 packet 则 undefined → 不出制度徽章。 */
                      packetRow={packetByUnderlying?.get(row.underlying)}
                      name={names?.[row.underlying]}
                      expanded={expanded === row.underlying}
                      onToggle={() => { setExpanded(expanded === row.underlying ? null : row.underlying) }}
                      history={expanded === row.underlying ? history : []}
                      historyFailure={expanded === row.underlying ? historyFailure : null}
                    />
                  ))}
                </div>
              )}

      <span className={css.hint}>{t('options.cycle.hint')}</span>
    </div>
  )
}

function CycleCard(props: {
  t: OptionsCycleLoopTranslate
  row: OptionCycleLoopRow
  /** 机会档位（最强 / 最弱 / 中位 / 其余）；只影响排序与徽章，不改卡片内容。 */
  tier: CycleTier
  /** WB-12：按 underlying 对齐的定时桶 ContextPacket 行；undefined = 无 packet。 */
  packetRow?: OptionBarContextRow | undefined
  name: string | undefined
  expanded: boolean
  onToggle: () => void
  history: readonly OptionCycle[]
  historyFailure: { code: string; message: string } | null
}): React.JSX.Element {
  const { t, row, tier, packetRow, name, expanded, onToggle, history, historyFailure } = props
  const forecast = row.latest?.forecast
  const score = row.latest?.score
  const calibration = row.latest?.calibration
  const hasBox = forecast?.boxLow !== undefined && forecast?.boxHigh !== undefined
  const rate = hitRateWidth(row.stats.hitRate)

  return (
    <div className={css.card} data-dshtrading-cycle-card={row.underlying} data-tier={tier} data-expanded={expanded ? 'true' : undefined}>
      <button type="button" className={css.cardHead} onClick={onToggle} aria-expanded={expanded}>
        {/* 档位徽章：只说明「为什么排前面」，不代表推荐强度；rest 不出徽章 */}
        {tier !== 'rest' && (
          <span className={css.tier} data-kind={tier} title={t('options.cycle.tier.hint')}>
            {t(TIER_KEY[tier])}
          </span>
        )}
        <span className={css.cardName}>{name ?? row.underlying}</span>
        <span className={css.cardCode}>{row.underlying}</span>
        <span className={css.spacer} />
        {/* 命中率条带：缺席 = 样本不足（scored=0），不画 0% 误导 */}
        {rate === undefined
          ? <span className={css.rateText}>{t('options.cycle.sampleShort')}</span>
          : (
            <span className={css.rateWrap} title={t('options.cycle.hitRate')}>
              <span className={css.rateTrack}><span className={css.rateFill} style={{ width: rate }} /></span>
              <span className={css.rateText}>{rate}</span>
            </span>
          )}
      </button>

      {/* 本桶预报：箱沿 / regime / candidates / calibration */}
      <div className={css.section}>
        <span className={css.sectionLabel}>{t('options.cycle.forecast')}</span>
        {forecast === undefined
          ? <span className={css.muted}>{t('options.cycle.noForecast')}</span>
          : (
            <>
              {forecast.regime !== 'no_trade' && (
                <span className={css.badge} data-kind={forecast.regime}>
                  {t(REGIME_KEY[forecast.regime])}
                </span>
              )}
              {hasBox
                ? <span className={css.box}>{t('options.cycle.box', { low: fmtPrice(forecast.boxLow), high: fmtPrice(forecast.boxHigh) })}</span>
                : <span className={css.muted}>{t('options.box.noTrade')}</span>}
              {/* 不出箱只出示原因，不画假箱沿 */}
              {forecast.regime === 'no_trade' && forecast.noTradeReason !== undefined && (
                <span className={css.muted}>
                  {t(SESSION_REASON_KEY[forecast.noTradeReason] ?? 'options.cycle.reason.insufficient')}
                </span>
              )}
              {calibration !== undefined && calibration !== 'none' && (
                <span className={css.badge} data-kind="calibration">{t(CALIBRATION_KEY[calibration])}</span>
              )}
              {/* 箱体 1 分钟量比（近 5 / 近 30 根）——与 packet 的 5/20 日量能是两种量纲，分开标 */}
              {forecast.volumeRatio !== undefined && (
                <span className={css.muted}>{t('options.loop.volumeRatioBox')} {forecast.volumeRatio.toFixed(2)}</span>
              )}
            </>
          )}
      </div>

      {/*
        WB-12：定时桶 ContextPacket 事实（**波动率制度** + 5/20 日量能）。
        与上面的 `forecast.regime`（价格结构）是两套枚举，必须各画各的灯：
        ivRegime 用 `data-kind="iv"`（虚线边）/ regime 用 `data-kind="range_hold"` 等，
        绝不可合并成一个徽章误导成同一维度。
      */}
      {packetRow !== undefined && (
        <div className={css.section}>
          <span className={css.sectionLabel}>{t('options.loop.packetIv')}</span>
          <span
            className={css.badge}
            data-kind="iv"
            data-iv-regime={packetRow.ivRegime}
            title={t('options.overview.ivRegime.hint')}
          >
            {t(IV_REGIME_KEY[packetRow.ivRegime])}
          </span>
          {/* packet 量能是 5d/20d，单独标「5/20 日量能」，禁止混进上面的「箱体量比」 */}
          {packetRow.volumeRatio !== undefined && (
            <span className={css.muted}>{t('options.loop.volumeRatioDaily')} {packetRow.volumeRatio.toFixed(2)}</span>
          )}
        </div>
      )}

      {/* 候选模板：标签，不是下单按钮 */}
      {forecast !== undefined && forecast.candidates.length > 0 && (
        <div className={css.section}>
          <span className={css.sectionLabel}>{t('options.cycle.candidates')}</span>
          {forecast.candidates.map(candidate => (
            <span
              key={candidate.template}
              className={css.tag}
              title={candidate.reason}
            >
              {t(TEMPLATE_KEY[candidate.template] ?? 'options.cycle.candidates')}
            </span>
          ))}
        </div>
      )}

      {/* 上桶评估：有 score 才画对照（score 在下一桶才补，未补 = 待评估） */}
      <div className={css.section}>
        <span className={css.sectionLabel}>{t('options.cycle.previous')}</span>
        {score === undefined
          ? <span className={css.muted}>{t('options.cycle.verdict.pending')}</span>
          : <ScoreLine t={t} score={score} forecast={forecast} />}
      </div>

      {expanded && (
        <div className={css.history}>
          {historyFailure !== null
            ? <span className={css.muted}>{historyFailure.code}</span>
            : history.length === 0
              ? <span className={css.muted}>{t('options.cycle.historyEmpty')}</span>
              : history.map(cycle => (
                <div key={cycle.id} className={css.historyRow}>
                  <span className={css.historyTime}>{bucketClock(cycle.bucketStart)}</span>
                  <span className={css.badge} data-kind={cycle.forecast.regime}>
                    {t(REGIME_KEY[cycle.forecast.regime])}
                  </span>
                  {cycle.forecast.boxLow !== undefined && cycle.forecast.boxHigh !== undefined && (
                    <span className={css.box}>
                      {t('options.cycle.box', { low: fmtPrice(cycle.forecast.boxLow), high: fmtPrice(cycle.forecast.boxHigh) })}
                    </span>
                  )}
                  {cycle.score === undefined
                    ? <span className={css.muted}>{t('options.cycle.verdict.pending')}</span>
                    : <span className={css.badge} data-kind={cycle.score.verdict}>{t(VERDICT_KEY[cycle.score.verdict])}</span>}
                  {cycle.score?.realizedLast !== undefined && (
                    <span className={css.muted}>{t('options.cycle.realized')} {fmtPrice(cycle.score.realizedLast)}</span>
                  )}
                  {cycle.calibration !== 'none' && (
                    <span className={css.muted}>{t(CALIBRATION_KEY[cycle.calibration])}</span>
                  )}
                </div>
              ))}
        </div>
      )}
    </div>
  )
}

/** 上桶评估一行：verdict + 已实现末值 vs 预报箱沿。 */
function ScoreLine(props: {
  t: OptionsCycleLoopTranslate
  score: OptionCycleScore
  forecast: OptionIntradayBoxRow | undefined
}): React.JSX.Element {
  const { t, score, forecast } = props
  const low = forecast?.boxLow
  const high = forecast?.boxHigh
  const inside = score.realizedLast !== undefined
    && low !== undefined && high !== undefined
    && score.realizedLast >= low && score.realizedLast <= high
  return (
    <>
      <span className={css.badge} data-kind={score.verdict}>{t(VERDICT_KEY[score.verdict])}</span>
      {score.skipReason !== undefined && (
        <span className={css.muted}>{t(SESSION_REASON_KEY[score.skipReason])}</span>
      )}
      {score.realizedLast !== undefined && (
        <span className={css.realized} data-inside={inside ? 'true' : 'false'}>
          {t('options.cycle.realized')} {fmtPrice(score.realizedLast)}
          {low !== undefined && high !== undefined && (
            <> · {t('options.cycle.box', { low: fmtPrice(low), high: fmtPrice(high) })}</>
          )}
        </span>
      )}
    </>
  )
}
