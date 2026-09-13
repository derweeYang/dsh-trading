/**
 * T+1 预测模块 —— MiddleStage 自取数薄壳（2026-09-12）。
 *
 * 与 OptionsOverviewMiddleView 同级：作为中栏第 5 个 tab（order 11）挂载，持有
 * 看板 / 跟踪回溯两态与编辑器模态。数据全部经 api.ts 打桥（桥走本地 JSONL 缝，
 * 网关未起也能用）；不依赖单标的上下文。30s 轮询（tab 不可见时 usePoll 自动停）。
 *
 * 本页技术与行情分析面，预测由用户/Agent 结构化录入，不构成投资建议。
 */
import { useState } from 'react'
import type { OptionPrediction, OptionPredictionBoard, OptionPredictionTrack } from '@dshtrading/api'
import {
  fetchOptionPredictions, fetchOptionPredictionTrack,
} from './api.ts'
import { usePoll } from './usePoll.ts'
import { fmtClock } from './format.ts'
import type { StageViewProps } from './stage-views.ts'
import { OptionsPredictionBoard } from './OptionsPredictionBoard.tsx'
import { OptionsPredictionTrack } from './OptionsPredictionTrack.tsx'
import { OptionsPredictionEditor } from './OptionsPredictionEditor.tsx'
import css from './options-prediction.module.css'

const PREDICTION_POLL_MS = 30000

/**
 * 跟踪回溯一次拉取的时间线条数上限（P2-9，2026-09-12）。桥契约明确：`limit` 只约束返回的
 * 预测条数，**统计仍按全量算**——所以加界只影响列表长度、不动任何指标口径。不传的话 30s
 * 轮询每次都全量重取整段历史，载荷与重渲染成本随预测累积线性增长（轮询是隐形的，不设界
 * 就等于让这个成本长期无上限）。
 */
const TRACK_LIMIT = 50

type Tab = 'board' | 'track'
interface EditorState {
  mode: 'create' | 'settle'
  preset?: { underlying?: string }
  prediction?: OptionPrediction
}

export function OptionsPredictionMiddleView({ t }: StageViewProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('board')
  const [focus, setFocus] = useState<string | undefined>(undefined)

  const [board, setBoard] = useState<OptionPredictionBoard | null>(null)
  const [boardFailure, setBoardFailure] = useState<{ code: string; message: string } | null>(null)
  const [boardLoaded, setBoardLoaded] = useState(false)

  const [track, setTrack] = useState<OptionPredictionTrack | null>(null)
  const [trackFailure, setTrackFailure] = useState<{ code: string; message: string } | null>(null)
  const [trackLoaded, setTrackLoaded] = useState(false)

  /**
   * 最近一次成功落地的时间（HH:mm:ss，按页签各记一份）。轮询本身是隐形的：不给出回执时，
   * 用户无法区分「这一页是活的、只是没有新数据」与「这一页卡住了/没在刷新」（P2-9）。
   */
  const [boardRefreshedAt, setBoardRefreshedAt] = useState<string | undefined>(undefined)
  const [trackRefreshedAt, setTrackRefreshedAt] = useState<string | undefined>(undefined)

  const [editor, setEditor] = useState<EditorState | null>(null)

  usePoll(async () => {
    const res = await fetchOptionPredictions()
    if (res.ok) { setBoard(res.data); setBoardFailure(null); setBoardRefreshedAt(fmtClock(Date.now())) }
    else { setBoard(null); setBoardFailure({ code: res.code, message: res.message }) }
    setBoardLoaded(true)
  }, PREDICTION_POLL_MS, [])

  usePoll(async () => {
    if (tab !== 'track') return
    const res = await fetchOptionPredictionTrack({
      ...(focus !== undefined ? { underlying: focus } : {}),
      limit: TRACK_LIMIT,
    })
    if (res.ok) { setTrack(res.data); setTrackFailure(null); setTrackRefreshedAt(fmtClock(Date.now())) }
    else { setTrack(null); setTrackFailure({ code: res.code, message: res.message }) }
    setTrackLoaded(true)
  }, PREDICTION_POLL_MS, [focus, tab])

  const openTrack = (underlying?: string): void => {
    setFocus(underlying)
    setTab('track')
  }
  const openCreate = (): void => { setEditor({ mode: 'create', preset: focus !== undefined ? { underlying: focus } : {} }) }
  const openSettle = (prediction: OptionPrediction): void => { setEditor({ mode: 'settle', prediction }) }

  const onSaved = (): void => {
    setEditor(null)
    // 立即刷新（轮询下个周期前先看到结果）；界限与轮询同口径，避免两条路径行为不一致。
    void fetchOptionPredictions().then((res) => {
      if (res.ok) { setBoard(res.data); setBoardFailure(null); setBoardRefreshedAt(fmtClock(Date.now())) }
    })
    if (tab === 'track') {
      void fetchOptionPredictionTrack({
        ...(focus !== undefined ? { underlying: focus } : {}),
        limit: TRACK_LIMIT,
      }).then((res) => {
        if (res.ok) { setTrack(res.data); setTrackFailure(null); setTrackRefreshedAt(fmtClock(Date.now())) }
      })
    }
  }

  /** 当前页签的新鲜度回执（P2-9）：只在该页签有成功落地时间时渲染。 */
  const refreshedAt = tab === 'track' ? trackRefreshedAt : boardRefreshedAt
  const refreshHint = refreshedAt === undefined
    ? undefined
    : t('options.prediction.autoRefresh', {
      time: refreshedAt,
      interval: String(PREDICTION_POLL_MS / 1000),
    })

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.tabs}>
          <button type="button" className={css.tab} data-active={tab === 'board'} onClick={() => { setTab('board') }}>{t('options.prediction.tab.board')}</button>
          <button type="button" className={css.tab} data-active={tab === 'track'} onClick={() => { setTab('track') }}>{t('options.prediction.tab.track')}</button>
        </div>
        {/* 轮询新鲜度回执（P2-9）：紧贴页签，让「没新数据」与「没在刷新」可区分 */}
        {refreshHint !== undefined && <span className={css.refreshed}>{refreshHint}</span>}
        <span className={css.spacer} />
        <button type="button" className={css.primaryBtn} onClick={openCreate}>{t('options.prediction.new')}</button>
      </div>

      {tab === 'board'
        ? (
          <OptionsPredictionBoard
            t={t}
            board={board}
            failure={boardFailure}
            loaded={boardLoaded}
            onOpenTrack={openTrack}
            onNew={openCreate}
          />
        )
        : (
          <OptionsPredictionTrack
            t={t}
            underlying={focus}
            track={track}
            failure={trackFailure}
            loaded={trackLoaded}
            onSettle={openSettle}
            {...(focus !== undefined ? { onClearFocus: () => { setFocus(undefined) } } : {})}
          />
        )}

      {editor !== null && (
        <OptionsPredictionEditor
          t={t}
          mode={editor.mode}
          {...(editor.preset !== undefined ? { preset: editor.preset } : {})}
          {...(editor.prediction !== undefined ? { prediction: editor.prediction } : {})}
          onClose={() => { setEditor(null) }}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
