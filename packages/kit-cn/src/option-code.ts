/**
 * 期权长代码解析（2026-09-14）。
 *
 * 规范主键形如 `510050C2609M02850`：标的 6 位 + C/P + 到期月 YYMM 4 位 +
 * 月份标志（M 月 / A 周）+ 行权价 5 位（×1000）。
 *
 * 为什么需要它：纸账户开仓的保证金查询 `getMargin`（index.ts）此前把腿原样
 * 透传给 `getStrategy`，腿上只有 `code` / `side` / `qty` / `premium`，**没有
 * `optionType` / `strike` / `expiryMonth`**；而 python 内核对 vertical 模板
 * 强校验 `expiryMonth/optionType/longStrike/shortStrike`（strategy.py:110），
 * 缺参即 BAD_REQUEST → 保证金恒为 undefined → `decidePaperOpen` 判 no_quote
 * → 纸账户永远开不了仓（09-11 起至今零成交的直接原因）。
 */
import type { OptionRight } from '@dshtrading/api'

export interface ParsedOptionCode {
  /** 标的 ETF 代码 6 位，如 510050。 */
  readonly underlying: string
  readonly optionType: OptionRight
  /** 到期月 YYMM，如 2609。 */
  readonly expiryMonth: string
  /** 行权价（元），如 2.85。 */
  readonly strike: number
}

/** 长代码正则：6 位标的 + C/P + 4 位 YYMM + 月份标志 + 5 位行权价（×1000）。 */
const OPTION_CODE_RE = /^(\d{6})([CP])(\d{4})[A-Z](\d{5})$/

/**
 * 解析期权长代码；非合约代码（现货腿 `asset:'spot'` 或格式不符）返回 undefined。
 *
 * 刻意不抛错：解析失败只是「这条腿无法补全内核参数」，调用方按缺参处理即可，
 * 抛错会让整次开仓决策中断。
 */
export function parseOptionCode(code: string | undefined): ParsedOptionCode | undefined {
  if (typeof code !== 'string') return undefined
  const match = OPTION_CODE_RE.exec(code)
  if (match === null) return undefined
  const strike = Number(match[4]) / 1000
  if (!Number.isFinite(strike)) return undefined
  return {
    underlying: match[1]!,
    optionType: match[2] as OptionRight,
    expiryMonth: match[3]!,
    strike,
  }
}
