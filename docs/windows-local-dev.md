# Windows 本机启动 trading-web

2026-09-08 在本机从 `etf-options` 源码搭起 `trading-web` 时踩过的坑与现行做法。决策与放弃项见 [process note](../.agents/notes/implemented/process/2026-09-08-windows-local-trading-web-bootstrap.md)。

本文不构成投资建议。不发布 npm（未授权）。

## 一次启动

1. 仓库已 `pnpm install` 且 `pnpm build`。
2. 宿主在仓库 `.local`（`@deepseek-ai/dsh@0.1.2-rc.1`），不要依赖全局 `dsh`。
3. 双击仓库根目录 `start-trading-web.bat`（或 `start-trading-web.bat 3082` 换端口）。窗口先打一段校对：宿主路径、`:3081` / `:5810` / `:8090` 是否在听、iQuant DLL 是否存在。缺 DLL 或宿主会标 `MISSING`。然后另开窗口起依赖：iQuant 行情（`:5810`）与期权分析网关（`:8090`）；已在听则跳过。
4. 等黑窗口出现 `dsh web: http://127.0.0.1:3081/?token=...`，脚本会打开这条地址。宿主窗口、行情窗口、期权网关窗口都不要关。

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

### 4b. `.local` 被掏空

- **现象**：校对里宿主 `MISSING`，或 `.local` 目录在但没有 `node_modules\.bin\dsh.cmd`。
- **原因**：对 `worktrees/**` 或含 junction 的树执行 `Remove-Item -Recurse`（PowerShell 5.1 跟随链接删目标）。2026-09-08 清 `refactor-cn-focus` worktree 时发生过。
- **处理**：不要再递归删。重装宿主后刷新 profile：

```powershell
npm install --prefix .local --no-fund --no-audit
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-trading-web-profile.ps1
.\start-trading-web.bat
```

卸 worktree 只用 `git worktree remove` + `git worktree prune`。见 [protected-trees note](../.agents/notes/implemented/bug-fix/2026-09-08-windows-worktree-recurse-wipe-local.md)。

### 5. 期权网关窗口出现 `cmake` / `Failed building wheel for pyarrow`

- **现象**：`start-options-gateway.bat` 刷一大段 CMake generator，最后 `error: failed-wheel-build-for-install` / `pyarrow`，同时又打印 `dsh-options gateway http://127.0.0.1:8090`。
- **原因**：本机无 `uv` 时旧脚本会 `pip install -e .`；`pyproject` 曾钉 `pyarrow<21`，在 Python 3.14 上没有匹配 wheel 就走源码编译。与「页面有没有行情」不是同一层——行情现货走 iQuant `:5810`，T 板走 options `:8090` 的 `chain`。
- **处理**：先确认 `http://127.0.0.1:5810/health` 与 `http://127.0.0.1:8090/health` 都是 200；页面必须用带 `?token=` 的 URL（裸 `3081/` 是 401，看起来像没行情）。启动脚本已改为 imports 通就跳过 pip。

### 6. Cursor 报 `insufficient tool messages following tool_calls`

- **现象**：对话整轮失败，与交易代码无关。
- **原因**：本机 `episodic-memory` MCP 的 `better-sqlite3` 按 Node 24 编译，Cursor 用自带 Node 22 加载。
- **处理**：这是 Cursor 用户目录插件，不在本仓。本机修复脚本：`C:\Users\ydw\.cursor\repair-episodic-memory.ps1`。不要点失败轮次的「重试」。

## 日常命令

```powershell
# 启动（默认 3081；另开 iQuant :5810 + options :8090；释放旧宿主并打开 token URL）
.\start-trading-web.bat

# 只重依赖 / 只重宿主
.\start-iquant-quote.bat
.\start-options-gateway.bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-trading-web.ps1 -SkipIquant -SkipOptions

# 只重挂宿主核心包（工具 prepare 崩溃后）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-trading-web-profile.ps1
```

`trading-web` 若仍挂 npm 上的 `@dshtrading/cn@^0.1.4`，本地 `connector-options`
不会进 profile。只 junction `api` / `cn` 也不够：profile 里会留下 0.1.4 连接器
实拷，和仓库 0.1.5 各 apply 一次，boot 报
`service "tradingCnMarketData" has been registered at <Include>`（各市场同症，
与 issue #81 同族）。另一条同文案：六家 CN dataplane 在 `tradingMarketDataRegistry`
尚未 provide 时走无注册表回退，抢占 Include 根键；dataplane 现已 `inject` 注册表，
根键占用则跳过。`.dsh-module-fallback` 若仍指向 `packages/*/node_modules/@dshtrading`
嵌套拷，启动脚本会先 relink。把本仓全部 `@dshtrading/*` junction 进 profile（会先停
3081，**不**跑 `dsh plugin install`），再把 `cordis` 等宿主核心包挂到 `.local`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\link-trading-web-workspace.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refresh-trading-web-profile.ps1
.\start-trading-web.bat
```

不要跑无 `--dsh` 的 `sync-profile-overrides.mjs`：缺本地宿主时它曾回落 macOS
`/opt/homebrew`。现在会优先仓库 `.local`。

看谁占着端口：

```powershell
Get-NetTCPConnection -LocalPort 3081 -State Listen | Select-Object OwningProcess
```
