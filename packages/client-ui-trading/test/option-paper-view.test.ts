/**
 * 期权纸账户视图层纯函数单测（2026-09-13 WB-15）。
 *
 * 这一层是「后端结构化数据 → UI 语义」的唯一翻译点，错了不会崩、只会**悄悄说错话**：
 * 模板名翻不出来会露出英文枚举；到期天数算错会把「还有 8 天」标成临期；
 * 收益率符号写反会把亏说成赚。所以逐条锁死。
 */
import { describe, expect, it } from 'vitest'
import type { PaperLegFill, PaperPosition } from '@dshtrading/api'
import {
  OPTION_PAPER_EXPIRING_DAYS, arbDirectionKey, bookReturnRatio, expiryDaysLeft, fillRowKey,
  isExpiringSoon, isSpotLeg, legUnitKey, paperReasonKey, paperReasonKind, paperTemplateKey,
  positionRowKey, shanghaiDayIndex, strikeLabel,
} from '../src/client/option-paper-view.ts'

describe('期权纸账户视图层 —— 词汇映射', () => {
  it('模板名：已知推荐模板与套利结构各有词典键，未知返回 undefined（不硬造标签）', () => {
    expect(paperTemplateKey('parity')).toBe('trade.optPaper.template.parity')
    expect(paperTemplateKey('box')).toBe('trade.optPaper.template.box')
    expect(paperTemplateKey('vertical')).toBe('options.template.vertical')
    expect(paperTemplateKey('butterfly')).toBe('options.template.butterfly')
    // 开集：未知模板交给调用方出等宽原文
    expect(paperTemplateKey('iron_condor_2030')).toBeUndefined()
    expect(paperTemplateKey(undefined)).toBeUndefined()
    expect(paperTemplateKey('')).toBeUndefined()
  })

  it('套利方向：四个闭集值全有键，旧持仓无该维度 → undefined', () => {
    expect(arbDirectionKey('buy_synthetic_sell_spot')).toBe('trade.optPaper.direction.buy_synthetic_sell_spot')
    expect(arbDirectionKey('sell_synthetic_buy_spot')).toBe('trade.optPaper.direction.sell_synthetic_buy_spot')
    expect(arbDirectionKey('long_box')).toBe('trade.optPaper.direction.long_box')
    expect(arbDirectionKey('short_box')).toBe('trade.optPaper.direction.short_box')
    expect(arbDirectionKey(undefined)).toBeUndefined()
  })

  it('成交原因：9 个闭集值全有键（含 strategy 的 skipped 桩）', () => {
    for (const reason of ['signal', 'invalidIf', 'close5', 'session', 'skipped'] as const) {
      expect(paperReasonKey(reason)).toBe(`trade.optPaper.reason.${reason}`)
    }
    for (const reason of ['arb_open', 'arb_converge', 'arb_reverse', 'arb_expiry'] as const) {
      expect(paperReasonKey(reason)).toBe(`trade.optPaper.reason.${reason}`)
    }
    expect(paperReasonKey('unknown_reason')).toBeUndefined()
  })

  it('原因分档：建仓/收敛/反转/强平/策略平/桩 六档不混（到期强平 ≠ 破位平仓）', () => {
    expect(paperReasonKind('arb_open')).toBe('open')
    expect(paperReasonKind('signal')).toBe('open')
    expect(paperReasonKind('arb_converge')).toBe('converge')
    expect(paperReasonKind('arb_reverse')).toBe('reverse')
    expect(paperReasonKind('arb_expiry')).toBe('expiry')
    expect(paperReasonKind('invalidIf')).toBe('close')
    expect(paperReasonKind('close5')).toBe('close')
    expect(paperReasonKind('session')).toBe('close')
    expect(paperReasonKind('skipped')).toBe('skip')
    expect(paperReasonKind('nope')).toBeUndefined()
  })
})

describe('期权纸账户视图层 —— 腿口径', () => {
  const optionLeg: PaperLegFill = { code: '510050C2609M02850', side: 'buy', qty: 2, fillPrice: 0.05, priceSource: 'ask' }
  const spotLeg: PaperLegFill = {
    code: '510050', side: 'sell', qty: 20_000, fillPrice: 2.9, priceSource: 'spot',
    asset: 'spot', spotSymbol: '510050.SH',
  }

  it('腿资产缺省 = 期权（旧行），显式 spot 才是现货腿', () => {
    expect(isSpotLeg(optionLeg)).toBe(false)
    expect(isSpotLeg(spotLeg)).toBe(true)
  })

  it('单位键分开：期权腿「张」、现货腿「份」（前端不做乘数换算）', () => {
    expect(legUnitKey(optionLeg)).toBe('trade.optPaper.unit.contract')
    expect(legUnitKey(spotLeg)).toBe('trade.optPaper.unit.share')
  })
})

describe('期权纸账户视图层 —— 收益率与到期', () => {
  it('收益率 = (equity − initialCash) / initialCash；initialCash 非正 → undefined', () => {
    expect(bookReturnRatio(100_000, 100_154.8)).toBeCloseTo(0.001548, 6)
    expect(bookReturnRatio(100_000, 99_000)).toBeCloseTo(-0.01, 6)
    expect(bookReturnRatio(0, 100)).toBeUndefined()
    expect(bookReturnRatio(-1, 100)).toBeUndefined()
    expect(bookReturnRatio(Number.NaN, 100)).toBeUndefined()
    expect(bookReturnRatio(100_000, Number.NaN)).toBeUndefined()
  })

  it('上海日历日序号按 UTC+8 整日切分（不依赖运行环境时区）', () => {
    // 2026-09-13 21:29 CST = 13:29 UTC，仍在同一上海日
    expect(shanghaiDayIndex(Date.UTC(2026, 8, 13, 13, 29))).toBe(shanghaiDayIndex(Date.UTC(2026, 8, 13, 15, 59)))
    // 跨过 UTC 16:00 即上海次日 00:00
    expect(shanghaiDayIndex(Date.UTC(2026, 8, 13, 16, 0)) - shanghaiDayIndex(Date.UTC(2026, 8, 13, 15, 59))).toBe(1)
  })

  it('距到期天数：当日为 0、已过期为负、非法日期串 → undefined', () => {
    const now = Date.UTC(2026, 8, 13, 5, 0) // 2026-09-13 13:00 CST
    expect(expiryDaysLeft('2026-09-23', now)).toBe(10)
    expect(expiryDaysLeft('2026-09-13', now)).toBe(0)
    expect(expiryDaysLeft('2026-09-10', now)).toBe(-3)
    expect(expiryDaysLeft('2609', now)).toBeUndefined()
    expect(expiryDaysLeft(undefined, now)).toBeUndefined()
  })

  it('临期高亮：≤3 天且未过期；已过期不贴「临期」（那是另一回事）', () => {
    const now = Date.UTC(2026, 8, 13, 5, 0)
    expect(OPTION_PAPER_EXPIRING_DAYS).toBe(3)
    expect(isExpiringSoon('2026-09-16', now)).toBe(true)
    expect(isExpiringSoon('2026-09-13', now)).toBe(true)
    expect(isExpiringSoon('2026-09-17', now)).toBe(false)
    expect(isExpiringSoon('2026-09-01', now)).toBe(false)
    expect(isExpiringSoon(undefined, now)).toBe(false)
  })

  it('行权价展示：parity 单值 / box 升序两端；缺 strikes → undefined', () => {
    const base: PaperPosition = {
      id: 'arb:parity:510050:2609:2850', underlying: '510050', template: 'parity',
      openedBucketStart: '2026-09-08T03:00:00.000Z', invalidIf: '', qty: 2, marginCny: 30_000, legs: [],
    }
    expect(strikeLabel({ ...base, strikes: [2.85] })).toBe('2.85')
    expect(strikeLabel({ ...base, template: 'box', strikes: [2.8, 3.0] })).toBe('2.8–3')
    expect(strikeLabel({ ...base, strikes: [] })).toBeUndefined()
    expect(strikeLabel(base)).toBeUndefined()
  })

  it('行键稳定：持仓回落 underlying+template+桶；成交拼账本前缀避免跨账本撞键', () => {
    const base: PaperPosition = {
      id: 'pos-1', underlying: '510050', template: 'parity',
      openedBucketStart: '2026-09-08T03:00:00.000Z', invalidIf: '', qty: 1, marginCny: 0, legs: [],
    }
    expect(positionRowKey(base)).toBe('pos-1')
    expect(positionRowKey({ ...base, id: '' })).toBe('510050:parity:2026-09-08T03:00:00.000Z')
    expect(fillRowKey('arbitrage', 'f-1', 0)).not.toBe(fillRowKey('strategy', 'f-1', 0))
  })
})
