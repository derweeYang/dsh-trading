/**
 * 中栏舞台：中栏 = 视图注册表 + 顶部切换条（行情 | 策略 | 知识库 | …）。
 *
 * 视图注册表是中栏的开放扩展点（issue #34 / P5）：quote 视图由 shell 自注册
 * 到 registry；策略/知识视图由 client-ui-strategies / client-ui-knowledge 经
 * tradingStageViews 服务注册。任何 client 插件 inject 该服务 register 即新增
 * 中栏 tab。同一时刻仅挂载活动视图（切换即卸载，图表态由 store/localStorage
 * 承接，后台视图零渲染开销）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readJson, writeJson } from './store.ts'
import { stageViews } from './stage-views.ts'
import { setStageActions, requestQuoteLens } from './stage-actions.ts'
import { tradeDeskStore, toggleTradeDesk, writeTradeDeskOpen } from './trade-desk-store.ts'
import { QuoteStage } from './QuoteStage.tsx'
import type { FillComposerFn } from './fill-composer.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { ChartState } from './chart-state.ts'
import type { Observable, SelectionState } from './store.ts'
import type { Instrument } from './types.ts'
import css from './stage.module.css'

/** 插件视图的注册 definition 形状（quote 由 shell 内建，不走此面）。 */
export interface MiddleViewDefinition {
  id: string
  titleKey: MarketLocaleKey
  order?: number
  render: ComponentType<import('./stage-views.ts').StageViewProps>
}

const STAGE_KEY = 'dshtrading.stage.v1'

function isRegisteredView(raw: unknown): boolean {
  return typeof raw === 'string' && stageViews.get(raw) !== undefined
}

function readStageView(): string {
  const raw = readJson<unknown>(STAGE_KEY, 'quote')
  // 持久化值指向未安装的插件视图（卸载场景）→ 回落 quote。
  return isRegisteredView(raw) ? raw as string : 'quote'
}

function writeStageView(view: string): void {
  writeJson(STAGE_KEY, view)
}

/** Registration-side business face. */
export interface MiddleStageInjected {
  hooks: {
    selection: Observable<SelectionState>
    chart: Observable<ChartState>
  }
  toggleIndicator: (id: string) => void
  setIndicatorParams: (id: string, params: Record<string, number>, scopeKey?: string) => void
  /** 按标的可见性（symbol visibility；scopeKey = `${market}:${symbol}`，缺省忽略）。 */
  setIndicatorVisible: (id: string, visible: boolean, scopeKey?: string) => void
  /** 全局移除：卸载所有标的上的该指标实例。 */
  removeIndicator: (id: string) => void
  /** 删除自定义指标（issue #30，透传给 QuoteStage 指标选择器）。 */
  deleteIndicator: (id: string) => Promise<boolean>
  /** 切换全局标的（透传给 QuoteStage：期权总览点行进 T 板）。 */
  selectInstrument?: (instrument: Instrument) => void
  /** 行情上下文 → 会话输入框（透传给 QuoteStage「发给 Agent」，只填入不发送）。 */
  fillComposer?: FillComposerFn
}

export type MiddleStageProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MiddleStageInjected>

export function MiddleStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, setIndicatorVisible, removeIndicator, deleteIndicator, selectInstrument, fillComposer }: MiddleStageProps) {
  // 名册响应式：registry 版本号驱动 tab 条重渲染；当前视图是普通 state
  // （readStageView 净化 localStorage 脏值）。
  useSyncExternalStore(stageViews.subscribe, stageViews.getVersion)
  const [view, setView] = useState<string>(readStageView)
  /** 交易台展开态（P1-2）：与 QuoteStage 共用 trade-desk-store 单例——任何 tab 都能看到
   *  并开关交易台，解决「下单入口仅在行情页」。 */
  const tradeDeskOpen = useSyncExternalStore(tradeDeskStore().subscribe, tradeDeskStore().getSnapshot)

  const switchView = (next: string): void => {
    setView(next)
    writeStageView(next)
  }

  /**
   * 全局「交易台」入口（P1-2，2026-09-12）：任何 tab 常驻。
   * 已在行情视图 → 取反开关；在其它 tab → 先写一次性**现货**透镜请求，再切行情视图，
   * 并保证交易台展开。交易台渲染在行情视图的现货分支，而 QuoteStage 是切视图时新挂载的
   * ——请求必须先于 switchView 写入（顺序颠倒会因挂载时机落错透镜，与 onPickRow 同款纪律）。
   */
  const onTradeDeskEntry = (): void => {
    if (view === 'quote') {
      toggleTradeDesk()
      return
    }
    requestQuoteLens('spot')
    writeTradeDeskOpen(true)
    switchView('quote')
  }

  // 把 quote 视图专有动作桥接给插件面（期权总览薄壳）：挂载即写入，切走保留最新值。
  // exactOptionalPropertyTypes 下可选属性不接受显式 undefined → 条件展开。
  useEffect(() => {
    setStageActions({
      ...(selectInstrument !== undefined ? { selectInstrument } : {}),
      ...(fillComposer !== undefined ? { fillComposer } : {}),
      switchToQuote: () => { switchView('quote') },
      switchToOverview: () => { switchView('options-overview') },
    })
  }, [selectInstrument, fillComposer, switchView])

  return (
    <div className={css.root} data-dshtrading-middle-stage="">
      <div className={css.tabs}>
        <div className={css.tabList} role="tablist" aria-label="stage">
          {stageViews.list().map(definition => (
            <button
              key={definition.id}
              type="button"
              role="tab"
              aria-selected={definition.id === view}
              className={css.tab}
              data-active={definition.id === view ? 'true' : undefined}
              onClick={() => { switchView(definition.id) }}
            >
              {t(definition.titleKey)}
            </button>
          ))}
        </div>
        {/* 下单入口增强（P1-2，2026-09-12）：全 tab 常驻交易台入口。过去交易台开关只在
            行情工具栏里，期权总览/预测/策略/知识库等 tab 都拿不到下单入口。此为动作按钮
            而非 tab，故放在 tablist 之外，避免污染 tab 语义。 */}
        <button
          type="button"
          className={css.tradeEntry}
          data-active={tradeDeskOpen ? 'true' : undefined}
          aria-pressed={tradeDeskOpen}
          title={t('stage.tradeDesk')}
          onClick={onTradeDeskEntry}
        >
          {t('stage.tradeDesk')}
        </button>
      </div>
      {/* 视图互斥挂载：切走即卸载（图表重建成本 < 双图常驻的内存/重绘成本）。
          prop 面沿用 QuotePane→QuoteStage 的 inject 传递约定（cast 收敛在边界）。
          quote 视图 = shell 内建（QuoteStage 直引——需要中栏全部指标动作面）；
          插件视图走 definition.render(props)。 */}
      {view === 'quote' ? (
        <QuoteStage {...({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, setIndicatorVisible, removeIndicator, deleteIndicator, selectInstrument, fillComposer } as never)} />
      ) : (
        (() => {
          const definition = stageViews.get(view)
          if (definition === undefined) return null
          const View = definition.render
          // 标的面（P1-4，2026-09-12）：插件视图此前只拿 t/view，无从知道用户选了哪个标的
          // ——策略视图因此恒显示硬编码的 600519。这里按 StageViewProps 下传（该字段可选，
          // 视图不声明即忽略；老壳不下传时视图走自身缺省，见 stage-views.ts 的说明）。
          return <View t={t} view={view} useSelection={useSelection} />
        })()
      )}
    </div>
  )
}