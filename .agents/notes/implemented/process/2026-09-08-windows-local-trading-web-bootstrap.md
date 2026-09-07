# Agent Note: Windows 本机 trading-web 启动与工具调度坑

Status: implemented

## Problem

2026-09-08 在 Windows 上从 `etf-options` 源码第一次把 `trading-web` 跑起来时，连续踩到一组互不相关、但都会表现为「服务没起来 / 页面是空的 / 一调工具就崩」的坑。没有一份本机操作说明，排障只能从 macOS 脚本与既有 bug-fix note 反推。

具体现象：

1. **端口冲突**：宿主默认听 `127.0.0.1:3080`，本机已被另一个 `deepseek-harness` 实例占用；再听 3080 即 `EADDRINUSE`。改到 3081 后，未先停旧进程再启动，同样报 `EADDRINUSE`。
2. **宿主安装面**：全局 `npm install -g @deepseek-ai/dsh@0.1.2-rc.1` 在本机被拦住。宿主改装到仓库 `.local`（gitignore），用 `.local/node_modules/.bin/dsh.cmd` 启动。
3. **空白页被误判为插件没装**：profile 的 `@dshtrading/*` 与 client-ui 包都在。打开 `http://127.0.0.1:3081/`（无 `?token=`）走宿主认证门，页面空壳，看起来像「没加载其他插件」。token 每次进程启动轮换。
4. **工具调用必崩 `reading 'prepare'`**：`holdings_list` 等任意工具报 `Cannot read properties of undefined (reading 'prepare')`。与 [2026-09-01 shadow-copy note](../bug-fix/2026-09-01-profile-shadow-copy-prepare-crash.md) 同构——profile 物化了一份与宿主同版本的 `@deepseek-ai/dsh-tools` 等拷贝，模块级 Symbol 互不相认。macOS 刷新脚本写死 `/opt/homebrew/...`，Windows 无对应入口。
5. **Cursor 会话协议中断**（环境，非本仓代码）：`episodic-memory` MCP 的 `better-sqlite3` 按本机 Node 24（ABI 137）编译，Cursor 用自带 `helpers/node.exe`（Node 22 / ABI 127）跑 MCP；`search` 加载原生模块失败或超时后，助手 `tool_calls` 缺回包，整轮报 `insufficient tool messages following tool_calls`。与 trading-web 无关，但会打断同一会话的排障。

## Decision

1. **启动口固定 3081**，启动前释放该端口上的 LISTENING 进程。仓库根提供 `start-trading-web.bat`（双击），实现在 `scripts/start-trading-web.ps1`：`--no-open` 拉起宿主，从日志取出带 token 的 `dsh web:` URL 再打开浏览器。
2. **宿主继续用仓库 `.local` 的 `0.1.2-rc.1`**，不改本机全局 npm。bat/ps1 都解析该路径。
3. **Windows 影子拷贝归一**走 `scripts/refresh-trading-web-profile.ps1`：把 profile 内与宿主重叠的核心包改成指向 `.local/node_modules/@deepseek-ai/<pkg>` 的 junction（含嵌套拷贝）。语义对齐 `scripts/refresh-trading-web-profile.sh`，路径对齐本机 `.local` 而非 Homebrew。操作纪律不变：先停实例再改 `node_modules`。
4. **操作说明**落在 [docs/windows-local-dev.md](../../../docs/windows-local-dev.md)；README 快速开始只加一条入口，不把本机端口/token/junction 细节写进通用 quick start。
5. **Cursor / episodic-memory ABI** 不进本仓脚本。本机已把 `better-sqlite3` 换成 Node 22 预编译，并用 `C:\Users\ydw\.cursor\repair-episodic-memory.ps1` 可重复修复；插件升级可能盖回 ABI 137 二进制。

## Alternatives considered

- **继续用默认 3080**：本机长期被另一套 harness 占用，quick start 在这台机器上必然 `EADDRINUSE`。放弃。
- **把 dsh 装进全局 npm**：本机安装被策略拦截；即便装上，也与「仓库 `.local` 钉死 0.1.2-rc.1」的可复现性冲突。放弃。
- **让 dsh 自己 `--open` 打开浏览器**：实测/推断容易落到无 token 的 origin，用户看到空页。改为脚本解析 token URL 再打开。
- **在 Windows 上直接跑 `refresh-trading-web-profile.sh`**：依赖 bash、`pgrep`、`ln -s` 和 `/opt/homebrew` 宿主路径，本机都不成立。改为并列的 `.ps1` + junction。
- **用 package.json `link:` 消影子拷贝**：既有 note 已否决（重复 loader entry / pnpm overrides 崩溃）。仍只在刷新脚本里重挂。
- **把 episodic-memory 修复提交进本仓**：那是 Cursor 用户目录插件，不属于 dsh-trading。只在文档里记现象与本机修复手段。

## Consequences

- Windows 从源码启动的权威步骤是 `docs/windows-local-dev.md` + 根目录 `start-trading-web.bat`。
- 工具调用崩 `prepare` 时先跑 `scripts/refresh-trading-web-profile.ps1`，再重启实例；只 `dsh plugin install` 会重新物化影子拷贝。
- 换端口：`start-trading-web.bat 3082`。token 以当次黑窗口打印值为准。
- 本机 Cursor 若再出现 `tool_calls` 协议失败，先怀疑 episodic-memory ABI，不要当成 trading-web 回归。
