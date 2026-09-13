# 期权纸账户执行台（Options Paper Desk）

- 日期：2026-09-13
- class：feature
- 分支：feat/option-paper-desk（自 etf-options 7afc601）
- 关联：docs/backend-handoff-2026-09-13.md 任务 #12

## Problem

期权纸账户上线五日零成交，审计发现三个执行链路缺口（09-10 七条候选无任何 fills 记录、
09-11 四条候选全 skip:no_quote、09-10/09-11 复盘 md 午夜抢写空版），但页面上完全看不到：
纸账户三个 REST 端点前端零消费，recommendations 无独立端点，`foldDailyReview` 只产出 md
字符串。用户无法在日常界面里发现「信号→执行」链路断了。

## Decision

新增 `GET /options/paper/desk` 聚合端点 + 期权总览页新 section「纸账户执行台」：

1. **口径与复盘同源**：把 `foldDailyReview` 的内部逻辑抽成结构化纯函数 `dailyLedgerCore`
   （cycles 按 id、recommendations 按 bucketStart 的 last-wins 去重 + verdict/skip 计数），
   md 渲染层与页面统计层共用——两侧数字永远不会漂移；md 输出逐字节不变（既有测试是回归锁）。
2. **三态划分暴露缺口**：每候选桶 → 成交（signal open）/ 纸账跳过（skip 桩）/ 记录缺口
   （无 open 行）。close fill 复用开仓桶 bucketStart，判定一律按 `offset==='open'` 过滤防双计。
3. **空数据不隐藏**：与 OptionsDetectedOpportunities 的「无数据即整节消失」语义相反——
   零成交、全 skipped、gap>0 正是本节要暴露的诊断载荷，照常渲染；只有加载/失败态出 notice。
4. **desk 不进 P2-8 sourceProbes**：页面级空态聚合保持「总览+闭环」双源语义；
   desk 自报失败（suppressNotice 只静默 notice 不静默内容）。
5. **equity 复用盯市**：bridge `optionPaperDesk()` 直接 `await this.optionPaperAccount()`
   （零持仓零链调用），mark 逻辑不下沉 kit-cn，保持 kit-cn 纯 fs。

## Alternatives considered

- **前端聚合**（拉 account+fills 再自己算）：recommendations 日文件 21–146KB 全量下发浪费，
  口径逻辑放前端会与 md 复盘漂移——否。
- **塞进 `GET /options/overview`**：overview 是 60s 慢轮询、面向标的行；且 task #11 的
  opportunities 聚合本身就 pending，别搅在一起——否。
- **独立 tab**：执行链路诊断与总览同页上下文更有用（机会卡就在上面）——否，作为
  MiddleView 第三 section。

## Consequences

- 正向：三个缺口（记录缺口/执行卡死/复盘失真）从「跑脚本审计」变成「打开页面即见」；
  2026-09-14 开盘首日即可肉眼验证链预热修复是否让首笔 fill 落地。
- 负向/成本：30s 轮询全量重读 ≤10 日账本（worst ~9MB / ~150ms JSON.parse）——可接受，
  mtime 缓存留作后续；`loadPaperDesk` 读目录+全量解析是 O(文件大小)，账本无限增长时
  需要再评估。
- 遗留：cycles verdict 全 skipped（打分闭环空转）是独立缺陷，本节只让它可见，根因排查
  另立任务；09-10/09-11 两张失真 md 保留原样作为事故现场（页面统计即重放口径，无需回填）。
