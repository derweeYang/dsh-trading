# Windows 本机启动 trading-web

2026-09-08 在本机从 `etf-options` 源码搭起 `trading-web` 时踩过的坑与现行做法。决策与放弃项见 [process note](../.agents/notes/implemented/process/2026-09-08-windows-local-trading-web-bootstrap.md)。

本文不构成投资建议。不发布 npm（未授权）。

## 一次启动

1. 仓库已 `pnpm install` 且 `pnpm build`。
2. 宿主在仓库 `.local`（`@deepseek-ai/dsh@0.1.2-rc.1`），不要依赖全局 `dsh`。
3. 双击仓库根目录 `start-trading-web.bat`（或 `start-trading-web.bat 3082` 换端口）。
4. 等黑窗口出现 `dsh web: http://127.0.0.1:3081/?token=...`，脚本会打开这条地址。窗口不要关。

默认端口 **3081**（本机 3080 常被另一套 `deepseek-harness` 占用）。

## 遇到过的问题

### 1. `EADDRINUSE` 3080 / 3081

- **现象**：`listen EADDRINUSE: address already in use 127.0.0.1:3080`（或 3081）。
- **原因**：端口上已有宿主。3080 往往是别的实例；3081 往往是上次没停干净。
- **处理**：用 bat 启动（会先结束该端口的 LISTENING 进程）。不要开着旧窗口再双击一次却指望并存。

### 2. 页面空白，像没加载插件

- **现象**：浏览器打开后几乎是空的，没有自选 / 行情 / Agent。
- **原因**：打开了不带 `?token=` 的 `http://127.0.0.1:3081/`。宿主认证门会拦下页面。profile 里的 `@dshtrading/*` 其实已经装上。
- **处理**：必须用当次日志里的完整 token URL。token 每次重启都换。脚本已改为解析日志再打开浏览器。

### 3. 工具一调用就「reading 'prepare'」

- **现象**：例如 `holdings_list · {}` → `Cannot read properties of undefined (reading 'prepare')`。纯文本聊天正常。
- **原因**：`trading-web` profile 里的 `@deepseek-ai/dsh-tools` 等与宿主 `.local` 不是同一份模块，`TOOL_RUNTIME_SCHEDULER` 对不上。详见 [shadow-copy note](../.agents/notes/implemented/bug-fix/2026-09-01-profile-shadow-copy-prepare-crash.md)。
- **处理**：先停实例，再跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-trading-web-profile.ps1
```

然后重新 `start-trading-web.bat`。不要在实例运行中执行 `dsh plugin install`。

### 4. 全局装不上 `dsh`

- **现象**：`npm install -g @deepseek-ai/dsh@0.1.2-rc.1` 失败或被策略拦截。
- **处理**：宿主装在仓库 `.local`。bat / 刷新脚本都走这条路径。

### 5. Cursor 报 `insufficient tool messages following tool_calls`

- **现象**：对话整轮失败，与交易代码无关。
- **原因**：本机 `episodic-memory` MCP 的 `better-sqlite3` 按 Node 24 编译，Cursor 用自带 Node 22 加载。
- **处理**：这是 Cursor 用户目录插件，不在本仓。本机修复脚本：`C:\Users\ydw\.cursor\repair-episodic-memory.ps1`。不要点失败轮次的「重试」。

## 日常命令

```powershell
# 启动（默认 3081，会释放旧进程并打开 token URL）
.\start-trading-web.bat

# 只重挂宿主核心包（工具 prepare 崩溃后）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-trading-web-profile.ps1
```

看谁占着端口：

```powershell
Get-NetTCPConnection -LocalPort 3081 -State Listen | Select-Object OwningProcess
```
