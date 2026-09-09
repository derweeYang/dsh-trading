/**
 * 期权总览顶部视图（2026-09-09 redesign）：把九标的聚合总览从单标的 QuoteStage
 * 期权透镜下「升格」为 MiddleStage 与行情/策略/知识库平级的第 4 个 tab。
 *
 * 本组件是**自取数薄壳**：持有 overview / cycleLoop 快照与排序态，每 60s / 30s
 * 各轮询一次（includeIv 仅排序切 iv 时打开——九路 vol_analytics 会打爆网关）；
 * 并把 overview / cycleLoop 发布到共享 store，供 QuoteStage T 板的「AI 扫描」读
 * 快照，避免重复打 /options/overview。
 *
 * 跨导航：点行进 T 板 / 扫描预填走 stageActions（MiddleStage 挂载时写入）。
 * 本页技术与行情分析面，不构成投资建议。
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import type { OptionOverview, OptionOverviewRow, OptionOverviewSort, OptionCycleLoop } from '@dshtrading/api'
import { fetchOptionsOverview, fetchOptionsCycleLoop, fetchOptionsResolve } from './api.ts'
import { colorModeStore } from './color-mode.ts'
import { OptionsOverview } from './OptionsOverview.tsx'
import { OptionsCycleLoop } from './OptionsCycleLoop.tsx'
import { stageActions, optionsOverviewStore, optionsCycleLoopStore } from './stage-actions.ts'
import { usePoll } from './usePoll.ts'
import type { StageViewProps } from './stage-views.ts'
import css from './options-overview-middle.module.css'

const OPTIONS_OVERVIEW_POLL_MS = 60000
const OPTIONS_CYCLE_LOOP_POLL_MS = 30000

export function OptionsOverviewMiddleView({ t }: StageViewProps): React.JSX.Element {
  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)
  const [sort, setSort] = useState<OptionOverviewSort>('strength')
  const [overview, setOverview] = useState<OptionOverview | null>(null)
  const [overviewFailure, setOverviewFailure] = useState<{ code: string; message: string } | null>(null)
  const [overviewLoaded, setOverviewLoaded] = useState(false)
  const [cycleLoop, setCycleLoop] = useState<OptionCycleLoop | null>(null)
  const [cycleFailure, setCycleFailure] = useState<{ code: string; message: string } | null>(null)
  const [cycleLoaded, setCycleLoaded] = useState(false)

  /** 排序切换期间丢弃旧应答（避免乱序覆盖）。 */
  const sortRef = useRef(sort)

  usePoll(async () => {
    const res = await fetchOptionsOverview({ sort, includeIv: sort === 'iv' })
    if (sortRef.current !== sort) return
    if (res.ok) {
      setOverview(res.data)
      setOverviewFailure(null)
      optionsOverviewStore.set(res.data)
    } else {
      setOverview(null)
      setOverviewFailure({ code: res.code, message: res.message })
    }
    setOverviewLoaded(true)
  }, OPTIONS_OVERVIEW_POLL_MS, [sort])

  usePoll(async () => {
    const res = await fetchOptionsCycleLoop()
    if (res.ok) {
      setCycleLoop(res.data)
      setCycleFailure(null)
      optionsCycleLoopStore.set({ loop: res.data, loaded: true, failure: null })
    } else {
      setCycleLoop(null)
      setCycleFailure({ code: res.code, message: res.message })
      optionsCycleLoopStore.set({ loop: null, loaded: true, failure: { code: res.code, message: res.message } })
    }
    setCycleLoaded(true)
  }, OPTIONS_CYCLE_LOOP_POLL_MS, [])

  const actions = stageActions.current
  const fill = actions.fillComposer

  const onPickRow = (row: OptionOverviewRow): void => {
    // 解构为 const 局部：闭包内 narrowing 才能保持（对象属性会被 TS 视为可变）。
    const { selectInstrument, switchToQuote } = actions
    if (selectInstrument === undefined || switchToQuote === undefined) return
    void fetchOptionsResolve(row.spotSymbol ?? row.underlying).then((res) => {
      const spot = res.ok ? res.data.link?.spotSymbol : undefined
      if (spot === undefined) return
      selectInstrument({ market: 'cn', symbol: spot, name: row.name })
      switchToQuote()
    })
  }

  const onScanAll = fill === undefined || overview === null
    ? undefined
    : (): void => { void fill(overview.scanAllPrompt) }
  const onScanRow = fill === undefined
    ? undefined
    : (row: OptionOverviewRow): void => { void fill(row.scanPrompt) }

  return (
    <div className={css.root}>
      <OptionsOverview
        t={t}
        colorMode={colorMode}
        overview={overview}
        failure={overviewFailure}
        loaded={overviewLoaded}
        sort={sort}
        onSortChange={setSort}
        onPickRow={onPickRow}
        {...(onScanAll !== undefined ? { onScanAll } : {})}
        {...(onScanRow !== undefined ? { onScanRow } : {})}
      />
      <OptionsCycleLoop
        t={t}
        loop={cycleLoop}
        failure={cycleFailure}
        loaded={cycleLoaded}
        names={overview?.rows.reduce<Record<string, string>>((map, row) => {
          map[row.underlying] = row.name
          return map
        }, {})}
      />
    </div>
  )
}
