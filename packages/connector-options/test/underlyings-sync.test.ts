/**
 * TS/Python 双份静态名册同步校验（spec 阶段 3.3）：rest.ts STATIC_ROWS 与
 * python/options src/dsh_options/data/underlyings.json 必须逐 source 对齐
 * （underlying/exchange/name/multiplier/tickSize/quotesSource 五字段全等）。
 * 名册漂移会让 T 板显隐（TS 静态）与链/合约解析（python）各说各话。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listStaticUnderlyings } from '../src/rest.js'

interface RegistryRow {
  underlying: string
  exchange: string
  name: string
  multiplier: number
  tickSize: number
  quotesSource: string
}

const here = dirname(fileURLToPath(import.meta.url))
// 仓根 = packages/connector-options/test → 上三级；python 名册在 python/options/src 下。
const PYTHON_REGISTRY = join(here, '..', '..', '..', 'python', 'options', 'src', 'dsh_options', 'data', 'underlyings.json')

const pythonRegistry = JSON.parse(readFileSync(PYTHON_REGISTRY, 'utf8')) as Record<string, RegistryRow[]>

describe('TS/Python 期权标的名册同步（spec 3.3）', () => {
  it('python 名册的每个 source 在 TS 侧都有同名集合（synth/akshare/iquant）', () => {
    expect(Object.keys(pythonRegistry).sort()).toEqual(['akshare', 'iquant', 'synth'])
  })

  it('逐 source 逐行五字段全等（underlying/exchange/name/multiplier/tickSize/quotesSource）', () => {
    for (const source of Object.keys(pythonRegistry) as Array<'synth' | 'akshare' | 'iquant'>) {
      const tsRows = listStaticUnderlyings(source).map(row => ({ ...row }))
      const pyRows = pythonRegistry[source]!.map(row => ({
        underlying: row.underlying,
        exchange: row.exchange,
        name: row.name,
        multiplier: row.multiplier,
        tickSize: row.tickSize,
        quotesSource: row.quotesSource,
      }))
      expect(tsRows, `source=${source}`).toEqual(pyRows)
    }
  })

  it('名册主键唯一（无重复 underlying）', () => {
    for (const source of Object.keys(pythonRegistry) as Array<'synth' | 'akshare' | 'iquant'>) {
      const keys = listStaticUnderlyings(source).map(row => row.underlying)
      expect(new Set(keys).size, `source=${source}`).toBe(keys.length)
    }
  })
})
