# Agent Note: CN 多家 dataplane 抢 tradingCnMarketData 导致 trading-web 起不来

Status: implemented

## Problem

`start-trading-web.bat` 在打出 `dsh web:` 之前以 code 1 退出。同一轮 `AggregateError` 里有两条：

1. `@dshtrading/client-ui-trading` 的 `lib/bridge.js` 仍 `import '@dshtrading/kit-hk'`（包已删）。
2. `@dshtrading/connector-hithink/dataplane`：`service "tradingCnMarketData" has been registered at <Include>`。

第二条不是「0.1.4 实拷 + 0.1.5 junction 各 apply 一次」那条（见 [windows bootstrap note](../process/2026-09-08-windows-local-trading-web-bootstrap.md)）。profile 顶层 `@dshtrading/*` 已经 junction 到本仓库；栈落在 `packages/connector-hithink/lib/dataplane.js` 的**无注册表回退**一行——`ctx.get('tradingMarketDataRegistry')` 当时是 `undefined`，于是 `new HiThinkMarketDataService(ctx)` 直接 provide 根键。iQuant / 腾讯 / 东财 / Tushare / AkShare / 同花顺六家 host 面 dataplane 都是这个回退；loader 对 include 里的行 `Promise.allSettled`，router 还没 provide 注册表时谁先落地谁占键，后到的炸 Include。

## Decision

- CN dataplane（iquant / tencent / eastmoney / tushare / akshare / hithink，模板同步）`inject = ['tradingMarketDataRegistry']`，等 `@dshtrading/router` 先挂上注册表再 apply，走 isolate + `register(cn, slug)`，不占 Include 根键。
- 无注册表回退仍保留（单测与老部署直接 `apply()`），但若根键已被占用则跳过，不二次 provide。
- `start-trading-web.ps1` 发现 `.dsh-module-fallback` 里的 `@dshtrading/*` 不指向 `packages/<name>`（本机曾指向 `packages/base/node_modules/@dshtrading/...` 嵌套拷）就先跑 `link-trading-web-workspace.ps1`。删除 kit 后的过期 `bridge.js` 仍由同脚本的 rebuild 门检查。

## Alternatives considered

- **只 relink / refresh cordis，不改 dataplane**：双份 cordis 会让 isolate 失效，是 [bootstrap note](../process/2026-09-08-windows-local-trading-web-bootstrap.md) 已覆盖的另一条；本机这次栈是注册表 `undefined` 的回退碰撞，只刷 junction 挡不住并行 apply 竞态。败。
- **patch 里关掉 hithink/tushare/akshare**：少几家降低碰撞概率，设置里切换这些源时没有注册项。败。
- **无注册表时除 iQuant 外全部 no-op**：老部署只挂腾讯、没有 router 时腾讯也静默。回退仍要能 provide，只是禁止第二家覆盖。败（作为唯一方案）。

## Consequences

- trading-web 的 CN 行情面依赖 base 行里的 router（本来就有）。无 router 的裸 dataplane 行会一直 pending，等注册表出现。
- 无注册表且根键空时，第一家仍 provide；已占用则跳过。
- 启动脚本会纠正 fallback 嵌套拷。不要对含 junction 的树 `Remove-Item -Recurse`。
