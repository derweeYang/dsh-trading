# Agent Note: 工程目录清理与未提交改动归并提交

Status: implemented

（盘点明细的原始清单见本次会话产出的 `INVENTORY.md`，已在其内容并入本 Note 后删除。）

## Problem

两条线索交叉：

1. **孤儿 worktree**：`worktrees/feat-options-arb-scan`（217M）在 `.gitignore` 内但
   `git worktree list` 未登记——`/worktrees/feat-options-arb-scan/.git` 不存在，
   `.git/worktrees/` 无对应元数据，系手工复制遗留。删除与否无人敢定。
2. **未提交的工作堆积**：3 个 `M` + 6 个 `??`，其中含一个完整的前端 bug-fix 变更包
   （会话入口静默失败 + 覆盖面板遮挡），但从未提交。
3. 同时仓库根目录堆着 8 个 `tmp-*` 运行产物、217M 缓存与日志。

## Decision

**先判定「哪些是真有用的功能」，再提交，最后清理**——顺序不可颠倒，否则可能把唯一
副本的旧账本删掉却不知道自己删了什么。

### 「有用功能」的判定：worktree 无源码可合并

排除 `node_modules` / `lib` / `dist` / `__pycache__` / `.venv` 后逐面对比：

| 对比面 | 差异数 | 方向 |
|---|---|---|
| `packages/` | 82 | **主仓库领先**（主仓独有 `OptionPaperBooks.tsx`、`OptionsArbitrageTable.tsx`、`session-nav.ts` 等） |
| `python/` | 2 | 主仓库领先（`live.py` 多 `last_session_close_ms()`；`test_live_history.py` 多 120+ 行） |
| `spikes/` | 2 | 仅运行时残留 |

`diff -rq … | grep "^Only in worktrees"` 全仓结果只有三项，且均为**本地运行数据**：

```
worktrees/feat-options-arb-scan/packages/client-ui-trading/data/options/paper/account.json
worktrees/feat-options-arb-scan/…/data/options/paper/positions.json
worktrees/feat-options-arb-scan/…/data/options/paper/fills/
```

内容核验：`cash:100000 / realizedPnl:0 / positions:[] / fills 0 字节`——**09-08 初始种子，
零业务信息**。结论：worktree 是主仓库的过时快照，**没有值得合并的功能**，删前留在
tar 包里即可。被缺的是 viel 这样一个岔路口：先诊断，再删。

### 提交拆分（Conventional Commits，分支 `etf-options`）

| commit | 内容 |
|---|---|
| `39dfac7` | `fix(client-ui-trading)` 会话入口失败可见 + 面板遮挡（源码 + 2 测试 + Agent Note） |
| `54cabfe` | `docs(handoff)` 关闭 no-exec 验证为「不通过」，归档 root cause 与 pending 待办 + 复盘 HTML |
| `17497e9` | `chore(gitignore)` `overview.json` / `sessions/` 归入运行台账忽略组 |

「产品能否入库」按既有惯例取证而非猜：`git ls-files "docs/*.html"` 命中
`docs/option-opportunities-overview.html`（有先例 → 报告 HTML 入库）；
而 `data/options/` 已跟踪的只有 `README.md` / `opportunities-summary.json` /
`seed-cards.json` 三个种子配置项，`cycles/ reviews/ packets/` 等运行台账一律被 ignore
→ `overview.json`、`sessions/` 与之同性质，入 ignore。

### 清理边界：临时目录先查「活的」

根目录 8 个 `tmp-*`（最新 mtime 09-15）判定可删。但 **`tmp/` 目录在整个过程中被写**：
打包时发现盘中不存在的文件（`replay_20260916.py`、`em_fetch_all.py`、`em_key.json`、
`em_etf_today.json`、`em_replay_detail.csv`），mtime 落在 **23:22–23:33**——并行会话正在
用它跑东方财富回放。→ **`tmp/` 整体保留**，只删根级 8 个。

### Windows 特殊约束落地

- `.local/`（850M）：属受保护树，**只删根级 9 个 `*.log`**，`chrome-*` profile 目录一动不动。
- B 档删除前做**链接越界分析**：
  `find . -type l -exec readlink {} \; | sort -u | grep -vc "feat-options-arb-scan"` = **0**，
  442 个链接全部自包含 → `rm -rf` 对 symlink 只 unlink 不跟随，安全。
  删除前后对比主仓 `packages` 非依赖文件数：**1057 → 1057**，实测无穿透。
- 本机 PowerShell 通道返回**空输出**（本机已知问题），reparse 检测改用 Bash `find -type l`。
- 三个 commit 后均核验 `.git/refs/heads/etf-options` 文件内容 == `git rev-parse`，
  未见本机 sandbox 的 ref 回滚现象。

## Alternatives considered

- **worktree 整体保留**：代价是 217M 长期占位、且它带 `-198M node_modules` 的误导性体积。
  已确认主仓领先 + 独有数据为零信息 → 备份后删除，收益明确。
- **`rm -rf worktrees/` 一步到位**：被否。pnpm workspace 依赖是 symlink，Windows 下
  `Remove-Item -Recurse`（PS 5.1）会跟随 junction 删到目标——本仓 2026-09-08 已因此误删
  `.local`。改用「先证明链接自包含 + 删后文件数基线对比」两道证据，再动 GNU `rm`。
- **不清 `.local` 任何东西**：过度保守。根级 log 是明确的过期运维产物（09-10~09-12），
  与 profile 目录性质不同，无需同等对待。
- **删 `tmp/`**：被否（见 Decision，它是活的）。在 didaking 并行会话活跃的本工作区，
  「看起来像临时」不等于「没人正在用」。

## Consequences

- 释放约 **219M**（worktree 217M + 临时日志/缓存 ~2M）；`.local/` 850M 与 `python/.venv`
  427M 按设计保留（前者受保护、后者是可重建依赖）。
- 备份落在工作区之外（`D:\workspace\myquant\projects\_dsh-trading-cleanup-backup-2026-09-16\`，
  两个 tar.gz 合计 4.3M），不污染本仓索引；本机回收站禁用，此为唯一恢复路径。
- 工作树回归干净，`git status --porcelain` 仅余 `tmp/`（并行会话在用）与本次产出。
- 前端 bug-fix 已持 with 三道门禁证据入库：build 绿、**65 文件 / 571 用例全绿**、
  i18n `OK: 5 namespaces, 1339 zh keys, 27 exemption(s)`。

## 门禁账（提交 `39dfac7` 前取证，串行 build → 全量测试 → i18n）

| 门禁 | 结果 |
|---|---|
| `pnpm --filter @dshtrading/client-ui-trading build` | 绿（node 半 19 文件 362.83 kB + client bundle 1.45 MB） |
| 包内 `npx vitest run` | 绿，65 文件 / **571** 用例 |
| `node scripts/i18n-audit.mjs --check` | `OK: 5 namespaces, 1339 zh keys, 27 exemption(s)` |

**用例数归因（本次要点）**：Agent Note 原文写 567，实测 571，差 4 必须查清再说而不是改写数字。
归因手段：

```
git show 41ea298 -- packages/client-ui-trading/test/option-bar-agent.test.ts \
  | grep -cE "^\+.*\bit\("   # => 4
```

并行会话（Cursor/Claude）在 **23:32:16** 提交 `41ea298 fix(options): pin option-bar
execution workspace instead of roster order`，该文件净增 4 个用例。
**567 + 4 = 571**，与本变更的 +9 完全一致，无虚报。原 Note 的 Consequences 已同步更新
为带归因的版本。再重申 skill §3 的纪律：本仓有并行会话时，报任何「+N」前先归因。
