# Agent Note: 清掉 locales 重复键（`options.prediction.track.hit`）

Status: implemented

## Problem

`node scripts/typecheck-gate.mjs`（tsc 棘轮门禁）报 `TS1117: An object literal cannot have
multiple properties with the same name` × 2：

```
src/client/locales.ts(353,7)   error TS1117   # zh 词典
src/client/locales.ts(1281,7)  error TS1117   # en 词典
```

定位：`'options.prediction.track.hit'` 在同一对象字面量里定义了**两次**——
zh 在 337 / 353 行，en 在 1267 / 1281 行。两处值相同（`'命中'` / `'Hit'`），分属两块
后来拼接的编辑（统计/矩阵块 与 回填复盘块）。

危害虽轻但真实：对象字面量重复键由**后者胜**、静默覆盖，读者会以为两块各自生效；
且类型门禁因此常年多 2 条错误，压缩棘轮余额。

## Decision

删除**复盘块**内的那一条冗余定义（zh 353 / en 1281），保留统计块内的（先出现、语义为
「命中」统计列）。两处字面量完全相同，故删除后行为零变化——纯粹去掉重复。

## Alternatives considered

- **删先出现的那条、留复盘块**：行为等价，但统计块是 `track.stats/total/scored/hit/…`
  成组的统计列，删它会破坏该组的完整性。不取。
- **保留两条、改其中一条的 key（如 `track.hitLabel`）**：无消费方需要第二个 label，
  凭空造键是伪修复。不取。
- **不动，只在门禁加豁免**：门禁明确「不做错误码豁免」（存量旧债随 PR 逐步清零），
  且这确实是可零成本修掉的错误。不取。

## Consequences

- `tsconfig.client.json` 类型错误数 **46 → 44**（总量 259 → 257），棘轮债减 2。
- zh/en 词典键集不变（重复键在对象里本就只占一个键），i18n 审计 zh 键数不受影响。
- 未改任何文案取值，运行时行为零变化。
