# Agent Note: i18n 门禁修复政策（CJK 豁免语法与合法 CJK 边界）

Status: implemented

## Problem

2026-09-12 复盘时 `pnpm i18n:check`（`scripts/i18n-audit.mjs`）为红（27 errors），并暴露一个易踩的语法陷阱：

- **豁免标记必须带冒号**：脚本常量 `ALLOW_MARKER = 'i18n-allow:'`。`MarketSidebar.tsx` 两处行尾写的是 `// i18n-allow`（**漏冒号**）→ `text.includes('i18n-allow:')` 为 false → 豁免静默失效，两行正则里的 `(A股)|(港股)` 一直报错，看着「已豁免」实则没生效。
- **未提交的 options 系列前端工作树带出 25 个 CJK / 词典错误**：`watch-groups.ts` 中文标的显示名（14）、`OptionsPredictionEditor.tsx` 内联文案（5）、`OptionsPredictionTrack.tsx` 全角冒号（1）、`MarketSidebar.tsx` 正则（2）、`options.prediction.track.na/partial` zh 缺键（2）。

## Decision

按 CJK 的**性质**分流，而非一律豁免或一律进词典：

1. **用户可见文案 → 必须进词典**：`OptionsPredictionEditor.tsx` 的校验消息 / placeholder / fieldHint 共 6 处，抽成 `options.prediction.create.invalid` / `settle.invalidNumber` / `underlyingName.optional` / `evaluationMethod.placeholder` / `volChange.hint` / `knowledgeNotes.placeholder` 六个键（zh + en 各一份，`contract.ts` 的 `MarketLocaleKey` union 同步）。
2. **数据 / DOM 选择器 / 正则 → 行级或文件级 `i18n-allow:`（带冒号 + 理由）**：
   - `watch-groups.ts` 的中文标的名是**数据**（随名册落库），文件头块注释加 `i18n-allow:` 整文件豁免；
   - `MarketSidebar.tsx` 两行 `(A股)|(港股)` 正则匹配交易所后缀，行级豁免（顺手修回漏掉的冒号）；
   - `src/client/index.ts`（shell 入口）的宿主设置按钮选择器（须匹配中文标题 `设置`）与设置入口缺失的兜底 toast，行级豁免。
3. **纯排版 CJK 标点 → 源码改用转义**：`OptionsPredictionTrack.tsx` 的全角冒号 `：` 写成 `{'\uFF1A'}`——渲染结果不变（仍是全角冒号），但源码不含字面 CJK 字形，审计自然通过。
4. **zh 缺键补齐**：`options.prediction.track.na` = 无法判定、`options.prediction.track.partial` = 部分（en 侧本已有，zh 漏补）。

## Alternatives considered

- **把所有报错行一律 `i18n-allow:` 豁免**：最省事，但会把 6 处用户可见文案（校验失败提示、输入占位）也一并藏进豁免，违背门禁「用户可见文案必须可翻译」的初衷。
- **所有 CJK 一律进词典（含数据 / 正则）**：`watch-groups.ts` 的 14 个标的名是随名册落库的数据，进词典会让「数据」与「文案」混层；正则里的 `A股/港股` 是匹配目标字符串，不可能走翻译。
- **给相关文件加 eslint-disable 类注释**：门禁是独立的 `i18n-audit.mjs`，不看 eslint，无效。

## Consequences

- `pnpm i18n:check` 恢复绿：`OK: 5 namespaces, 1168 zh keys, 26 exemption(s), 41 host-half warning(s)`。
- 豁免语法踩坑入档：**`i18n-allow:` 必须带冒号**；行级豁免的注释须与目标 CJK 同行（脚本按「注释 span 与行的重叠」判定，不匹配裸行子串）。
- 新增 CJK 时的决策顺序固定为：**用户可见吗？** → 是则进词典；否则是**数据 / 选择器 / 正则 / 排版标点**吗？→ 对应 `i18n-allow:` 或转义。
- `dsh-i18n` 中央词典静态 import 各包 `locales.ts`，故新增键自动同步，无需手工维护中央表（门禁会校验两侧键集一致）。
