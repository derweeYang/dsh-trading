# Agent Note: Windows worktree 递归删除掏空 `.local` 宿主

Status: implemented

## Problem

2026-09-08 合并 `feat/refactor-cn-focus` 后清理 worktree 时，对
`worktrees/refactor-cn-focus` 执行 `Remove-Item -LiteralPath -Recurse -Force`。
PowerShell 5.1 对 junction **跟随目标删除**，仓库根 `.local`（本机钉死的
`@deepseek-ai/dsh@0.1.2-rc.1`）被掏空。随后 `start-trading-web.bat` 找不到
`.local\node_modules\.bin\dsh.cmd`，校对/刷新脚本 `Resolve-Path` 直接失败。

这与「删 junction 用 `Directory.Delete`、不用 `Remove-Item -Recurse`」已有纪律
同族，但此前只写在 profile 链接脚本注释里，清理 worktree 时没有当成铁律。

## Decision

- `.local/`、`packages/**` 源树、`%USERPROFILE%\.dsh\profiles\trading-web` 是
  受保护树，禁止递归擦除。
- 卸 worktree 只走 `git worktree remove` + `git worktree prune`；残留目录若仍
  在，先确认没有指向上述保护树的 reparse point，再删 **链接本身**
  （`[System.IO.Directory]::Delete`）。
- 宿主消失时只允许 `npm install --prefix .local`（`.local/package.json` 钉
  `0.1.2-rc.1`），不装全局 npm。
- 同一纪律写入 always-apply Cursor rule
  [windows-protected-trees](../../../../.cursor/rules/windows-protected-trees.mdc)
  与 [AGENTS.md](../../../../AGENTS.md) 工作流一条。

## Alternatives considered

- **继续用 `Remove-Item -Recurse` 清 worktree，事后再装宿主**：已实证会误删
  `.local`，恢复要重新拉整个 DSH 闭包。败。
- **把 `.local` 从 worktree 可及路径里隔离（不 junction）**：worktree 若自行
  `npm install --prefix .local` 仍可能与主树同路径；隔离不能替代「禁止递归删
  junction」。不替代本纪律。
- **gitignore 的 `.local` 不写进仓库记忆**：下次会话看不见这次事故。败。

## Consequences

- 删 `feat/refactor-cn-focus` worktree 后若 `.local` 为空，按
  `docs/windows-local-dev.md` 用 `--prefix .local` 重装宿主，再
  `refresh-trading-web-profile.ps1`。
- profile / workspace 链接脚本继续只用 `Directory.Delete` 摘 junction。
