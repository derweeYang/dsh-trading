# Agent Note: 自选搜索添加不再整表替换默认种子

Status: implemented

## Problem

用户在左栏自选搜索并点选/回车添加后，原先可见的默认列表（茅台/平安银行/中国平安/50ETF）整表消失，只剩刚搜的那一只，也无法回退。搜索框是「点选即加」而不是过滤（见 [watchlist-add-entry](../architecture/2026-08-31-watchlist-add-entry.md)），第一次 `add` 用 `map[market] ?? []` 从空数组起步写盘，把「未定制 → 展示种子」的缺键状态物化成「已定制且只有新行」。`remove` 已在 [2026-09-06](2026-09-06-watchlist-remove-seed-and-empty-state.md) 改为以种子为基底；`add` 未对齐。

## Decision

未定制（`map[market] === undefined`）时，host 内存/文件 store 与客户端 `store.ts` 的 `add` 都以 `effectiveWatchlistRows` / `DEFAULT_WATCHLISTS` 为基底：

- 新标的：持久化 `[...seeds, new]`，返回 `true`。
- 已是种子行：返回 `false`，不落盘、不把缺键物化成定制。
- 已定制（含空数组）：只在该定制列表上追加/去重，不复活种子。

已落盘的误物化列表（`~/.dsh/watchlists.json` 里 `cn` 只剩搜索结果）不会自动还原——键在即为定制。用户需再加回，或删掉该市场键 / 空文件以回到未定制种子展示。

## Alternatives considered

- **只改搜索框为过滤、回车不添加**：能避免误触，但点选即加仍会踩空数组起步；且搜索框是 workbuddy 界面，本变更只修数据契约。
- **保持 2026-09-02「add 不拉种子」**：当时种子表更大、面向 agent 工具噪音。当前 CN 种子就是用户已经看见的 4 行；第一次 add 从 `[]` 起步等于把可见列表抹掉且无法回退。
- **启动时静默覆盖已定制的单行列表**：会把用户真删过种子后的定制也还原，和「空数组保持已定制」冲突。

## Consequences

- 第一次搜索添加后左栏仍保留默认 4 行 + 新标的；加已在种子里的代码是空操作。
- `watchlist_list` 在第一次加非种子行后 `sources.cn` 变为 `custom`，行数 = 种子 + 1。
- 本机若已经写成 `{ cn: [刚搜的那只] }`，刷新不会自动恢复默认 4 行。
