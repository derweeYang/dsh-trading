import { describe, expect, it } from 'vitest'
import { MARKET_INDICES, getMarketSessionStatus } from '../src/client/market-status.ts'

describe('MARKET_INDICES', () => {
  it('defines core indices for the cn market (converged vocabulary)', () => {
    expect(Object.keys(MARKET_INDICES)).toEqual(['cn'])
    expect(MARKET_INDICES.cn.map(d => d.symbol)).toEqual(['sh000001', 'sz399001', 'sz399006'])
  })
})

describe('getMarketSessionStatus', () => {
  it('cn market session status calculation', () => {
    // 2026-08-31 is Monday
    // 09:20 Shanghai (01:20 UTC) -> auction
    const auctionTime = new Date('2026-08-31T01:20:00.000Z')
    expect(getMarketSessionStatus('cn', auctionTime)).toMatchObject({
      statusKey: 'status.auction',
      isOpen: false,
      color: '#e37318',
    })

    // 10:00 Shanghai (02:00 UTC) -> trading
    const morningTrading = new Date('2026-08-31T02:00:00.000Z')
    expect(getMarketSessionStatus('cn', morningTrading)).toMatchObject({
      statusKey: 'status.trading',
      isOpen: true,
      color: '#2ba471',
    })

    // 12:00 Shanghai (04:00 UTC) -> midday break
    const midday = new Date('2026-08-31T04:00:00.000Z')
    expect(getMarketSessionStatus('cn', midday)).toMatchObject({
      statusKey: 'status.midday',
      isOpen: false,
      color: '#e37318',
    })

    // 14:00 Shanghai (06:00 UTC) -> trading
    const afternoonTrading = new Date('2026-08-31T06:00:00.000Z')
    expect(getMarketSessionStatus('cn', afternoonTrading)).toMatchObject({
      statusKey: 'status.trading',
      isOpen: true,
      color: '#2ba471',
    })

    // 16:00 Shanghai (08:00 UTC) -> closed
    const closedTime = new Date('2026-08-31T08:00:00.000Z')
    expect(getMarketSessionStatus('cn', closedTime)).toMatchObject({
      statusKey: 'status.closed',
      isOpen: false,
      color: '#8e95a3',
    })

    // 2026-08-30 is Sunday -> closed
    const weekendTime = new Date('2026-08-30T04:00:00.000Z')
    expect(getMarketSessionStatus('cn', weekendTime)).toMatchObject({
      statusKey: 'status.closed',
      isOpen: false,
      color: '#8e95a3',
    })
  })
})
