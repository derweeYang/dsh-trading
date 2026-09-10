/**
 * 期权总览顶部视图（2026-09-09 redesign）：把九标的聚合总览从单标的 QuoteStage
 * 期权透镜下「升格」为 MiddleStage 与行情/策略/知识库平级的第 4 个 tab。
 *
 * 本组件是**自取数薄壳**：持有 overview / cycleLoop 快照与排序态，每 60s / 30s
 * 各轮询一次（includeIv 仅排序切 iv 时打开 vol_analytics 分位；近月 ATM IV 由桥默认回填）；
 * 并把 overview / cycleLoop 发布到共享 store，供 QuoteStage T 板的「AI 扫描」读
 * 快照，避免重复打 /options/overview。
 *
 * 跨导航：点行进 T 板 / 扫描预填走 stageActions（MiddleStage 挂载时写入）。
 * 本页技术与行情分析面，不构成投资建议。
 */
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { OptionOverview, OptionOverviewRow, OptionOverviewSort, OptionCycleLoop, OptionBarContextPacket } from '@dshtrading/api'
import { fetchOptionsOverview, fetchOptionsCycleLoop, fetchOptionsBarPacket, fetchOptionsResolve } from './api.ts'
import { colorModeStore } from './color-mode.ts'
import { OptionsOverview } from './OptionsOverview.tsx'
import { OptionsCycleLoop } from './OptionsCycleLoop.tsx'
import { cumulativeReturn } from './option-insight.ts'
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
  /** WB-12：当天最新定时桶 ContextPacket；无文件时桥返回无 `packet` 键 → 这里为 null（不渲染整条）。 */
  const [barPacket, setBarPacket] = useState<OptionBarContextPacket | null>(null)

  /** 排序切换期间丢弃旧应答（避免乱序覆盖）。 */
  const sortRef = useRef(sort)
  /** WB-11：排序应答在途（IV 要打九路 vol_analytics，可能很慢）→ UI 即刻给反馈。 */
  const [sortPending, setSortPending] = useState(false)

  usePoll(async () => {
    const res = await fetchOptionsOverview({ sort, includeIv: sort === 'iv' })
    if (sortRef.current !== sort) return
    setSortPending(false)
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

  /**
   * WB-11：换排序先用已取到的行在客户端重排（纯展示序，不重算任何指标），
   * 点击「IV 分位」立即看到顺序变化；桥应答落地后再用服务端口径覆盖。
   * 缺键行沉底（undefined 视为最小）；IV 全缺席时顺序不变，由 OptionsOverview 出提示。
   */
  const displayOverview = useMemo(() => {
    if (overview === null) return null
    const last = (value: number | undefined): number =>
      value === undefined ? Number.NEGATIVE_INFINITY : value
    const rows = [...overview.rows].sort((a, b) => {
      if (sort === 'iv') return last(b.ivPercentile ?? b.atmIv) - last(a.ivPercentile ?? a.atmIv)
      if (sort === 'holdings') {
        const held = (b.heldQty ?? 0) - (a.heldQty ?? 0)
        if (held !== 0) return held
        return (b.optionQty ?? 0) - (a.optionQty ?? 0)
      }
      return last(b.strengthScore) - last(a.strengthScore)
    })
    return { ...overview, rows }
  }, [overview, sort])

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

  /**
   * WB-12：定时桶 ContextPacket 30s 轮询，与闭环 loop 同频；`usePoll` 已在 tab
   * 不可见时自动停（不 5s 刷桥）。无 packet 文件 → bridge 不写 `packet` 键
   * → 这里存 null，闭环卡片据此决定「不渲染智能体所见」。
   */
  usePoll(async () => {
    const res = await fetchOptionsBarPacket()
    if (res.ok) setBarPacket(res.data)
    else setBarPacket(null)
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

  /**
   * WB-11 修复「点 IV 分位没反应」的真根因：sortRef 只在初始化读过 sort，之后
   * 从未同步——切排序后所有应答都被 `sortRef.current !== sort` 丢弃，表格永不
   * 更新。这里在切换时同步 sortRef + 打开在途态；旧排序的在途应答仍会被丢弃。
   */
  const changeSort = (next: OptionOverviewSort): void => {
    if (next === sort) return
    sortRef.current = next
    setSort(next)
    setSortPending(true)
  }

  return (
    <div className={css.root}>
      <OptionsOverview
        t={t}
        colorMode={colorMode}
        overview={displayOverview}
        failure={overviewFailure}
        loaded={overviewLoaded}
        sort={sort}
        onSortChange={changeSort}
        sorting={sortPending}
        onPickRow={onPickRow}
        {...(onScanAll !== undefined ? { onScanAll } : {})}
        {...(onScanRow !== undefined ? { onScanRow } : {})}
      />
      <OptionsCycleLoop
        t={t}
        loop={cycleLoop}
        failure={cycleFailure}
        loaded={cycleLoaded}
        packet={barPacket}
        names={overview?.rows.reduce<Record<string, string>>((map, row) => {
          map[row.underlying] = row.name
          return map
        }, {})}
        cum5d={overview?.rows.reduce<Record<string, number>>((map, row) => {
          // 与叠图同源：累计值算不出来就不进排名，也就不冒充最强/最弱
          const cum = cumulativeReturn(row.days ?? [])
          if (cum !== undefined) map[row.underlying] = cum
          return map
        }, {})}
      />
    </div>
  )
}
