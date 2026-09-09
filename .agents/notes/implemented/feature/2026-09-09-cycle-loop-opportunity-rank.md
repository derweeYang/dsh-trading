# Agent Note: 闭环卡片机会排序（最强/最弱/中位排前）与中视图布局修复

Status: implemented

## Problem

WB-6 的 5 分钟闭环（`OptionsCycleLoop`）九张卡片按桥给的原始顺序平铺，领航员在盘中反馈两点：

1. **遮挡 / 堆叠**：期权总览中视图（`OptionsOverviewMiddleView`）是
   `flex column + overflow hidden`，闭环组件没有收缩能力（`min-height` 默认 auto），
   空间不足时卡片直接被父容器裁掉一半；`.cards` 固定 `max-height: 260px` 的 grid
   里展开历史（24 条）的卡片会把同 grid 行的邻居挤扁，内容互相压叠。
2. **排序无重心**：九个标的不分强弱全部等权平铺，最强、最弱、中间这三类最有
   交易含义的标的淹没在列表里。

## Decision

- **机会排序**（`src/client/cycle-rank.ts`，纯函数）：
  - 强弱口径与 WB-9 叠图 `OverlayTrendChart.emphasisOf` 完全同源——按近 5 日
    累计涨跌幅排名：第 1 名 `strong`、末位 `weak`、正中位 `median`，其余 `rest`。
  - 累计值由 `OptionsOverviewMiddleView` 用既有 `option-insight.cumulativeReturn(row.days)`
    算好后以 `cum5d` prop 传入，**不在组件里另算一遍**（WB-9 定过「图上终点与
    名次同源」纪律，两处各算必打架）。
  - 输出顺序 `strong → weak → median → rest`；`rest` 内「本桶有机会（有箱 +
    有候选）」优先，其次保持桥原始顺序——30s 轮询不抖动。
  - 数据缺席（`cum5d` 缺键 / NaN）不抢档：不进排名、不出徽章、落 `rest` 沉底。
  - 排序只动顺序，不改卡片内容；档位徽章（最强红 / 最弱绿 / 中位中性，
    data-kind 语义色）加 `title` 说明「不代表推荐强度」。卡片补
    `data-dshtrading-cycle-card` / `data-tier` 钩子供测试与真机冒烟。
- **布局修复**：
  - 闭环 `.root` 改 `flex: 0 1 auto; min-height: 0; overflow: hidden`，`.cards`
    改 `flex: 1 1 auto; min-height: 0; overflow: auto`——高度不够时卡片区自己滚，
    不再被父容器裁切。
  - `.cards` 下限 280px → 260px + `grid-auto-rows: min-content; align-content: start`；
    展开卡 `grid-column: 1 / -1` 独占整行（历史撑高不压邻居）。
  - 卡片 `min-width: 0; overflow: hidden`，`cardName` ellipsis——长名截断，不溢出。
  - 中视图 `.root` 加 `gap: 8px`，并显式分配：总览（`:first-child`）吃剩余高度
    内部滚动，闭环（`:last-child`）按内容取高、空间不足自滚。

## Alternatives considered

- 用 `strengthScore` 排序：含量能因子，会与叠图曲线终点错位（WB-9 已否），弃。
- 前端现场用 `row.return5d` 排序：与 `days` 累乘口径存在漂移风险，且违背同源纪律，弃。
- 把 `OverlayTrendChart.emphasisOf` 抽公共后复用：语义同源但 WB-9 已验收，为最小
  改动不动已验收组件，改为注释互相锚定。
- 布局改为单列列表：牺牲信息密度，先用「展开独占整行 + 内部滚动」解决挤压，够用。

## Consequences

- 新增 i18n 键 4 个（`options.cycle.tier.{strong,weak,median,hint}`，zh/en +
  contract union 同步）；`dsh-i18n` 中央包引用编译产物，**改 locales.ts 后必须
  `pnpm build` 重建，否则 i18n-audit 报 central dict drifted**（本次踩过并修复）。
- 宿主 profile 挂的是包产物 file: 副本：真机验证前需停宿主 →
  `scripts/refresh-trading-web-profile.ps1` → 重启（实例运行中禁止 plugin install）。
- 相关：[WB-6 闭环 UI](2026-09-09-options-overview-cycle-loop-ui.md)、
  [WB-9 总览重构](2026-09-09-options-overview-wb9-rework.md)。

## Verification & Gates

- `test/options-cycle-rank.test.ts` 10 例（档位定位 / 缺席不抢档 / NaN / 确定性 /
  rest 内机会优先）+ `options-overview.smoke.test.tsx` 新增 2 例（DOM 顺序 + 徽章、
  缺席不出徽章）；包内全量 390 测试通过。
- `node scripts/typecheck-gate.mjs` 234 = 基线（棘轮通过）；
  `node scripts/i18n-audit.mjs` OK（1099 zh keys）。
