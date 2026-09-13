# Agent Note: 期权纸账户多账本（strategy/arbitrage 双 10 万虚拟账户）

Status: implemented

## Problem

用户要资产面板两个期权虚拟账户（各 10 万）：一个专做套利、一个跑 5 分钟桶策略，
机会即现即成交。现状是单账户纸账本（`data/options/paper/{account.json,positions.json,fills/}`），
只有 strategy 一种语义；套利账本无处落、无路由可查；且旧布局迁移没有兼容层。

## Decision

C1（本 commit，worktree `feat/option-paper-books`）——账本骨架与桥路由：

1. **契约**（`api`）：`OptionPaperBookId = 'strategy' | 'arbitrage'`；
   `PaperFillReason`/`OptionPaperPriceSource` 扩 `'arb_*'`/`'bid'|'ask'|'spot'`；
   `PaperLegFill.asset?: 'option'|'spot'`（spot 腿 qty 存**份数**，不乘 multiplier）；
   `PaperPosition` 套利维度（`book/expiryMonth/expiryDate/direction/strikes/openEdgePerShare`）；
   新 wire `OptionPaperBookWire`/`OptionPaperAccountsWire`。全部可选追加，向后兼容。
2. **路径**（`option-bar-ledger.ts`）：`paperAccountPath/paperPositionsPath` 加
   `book='strategy'` 缺省；`paperFillsPath(root, book, date)` 强制显式 book——
   旧签名 `(root, date)` 的 date 会被当 book，宁可编译错不让运行期写错文件。
3. **惰性迁移**（`ensurePaperBooksLayout`）：load/reset 入口路过；进程内 `Set<root>` memo；
   rename 原子平移旧三项 → `paper/strategy/`，目标存在跳过（宁可弃旧不毁新）、
   源缺失容忍；**无锁**（loadPaperState 在 withPaperStateLock 内被调用，不可重入拿锁）；
   旧目录留空壳不删（Windows 受保护树纪律）。
4. **现金流口径**：`legCashCny` 按腿区分乘数（spot 不乘 10000），`premiumCny` = Σ 腿；
   `fillFeeCny` spot 腿按名义额 × `OPTION_PAPER_SPOT_FEE_RATE`(万1)；纯期权腿与旧实现逐位等价。
5. **桥路由**：GET `/options/paper/account?book=`（非法 400）、新增 `/options/paper/accounts`
   （两账本一次返回，arbitrage 在前）、`/options/paper/fills?book=`、POST reset 带 book。
6. **测试**：kit-cn 172（多账本隔离/迁移幂等/realizedPnl 保留/套利字段透传）+
   client-ui-trading 506（双 100k 路由）全绿。

## 已知坑

- **fixture 双布局**：三个测试文件硬编码旧 `paper/fills`/`paper/positions` 读写路径，
  savePaperState 已写新布局 → ENOENT。修法：断言读 `paper/strategy/...`；
  bridge 两个 tick 测试 fixture 保留旧布局写法（顺带覆盖迁移平移路径）。
- **applyOpen 解构陷阱**：`expiryDate/openEdgePerShare` 走 `...fillRow` 落账，若同时
  加入解构剔除列表，position 字面量引用局部变量会 ReferenceError——两者只能选一处。

## Next

C2 签名边助手 → C3 套利引擎（option-arb-paper.ts）→ C4 心跳接线 → C5 workbuddy handoff。
