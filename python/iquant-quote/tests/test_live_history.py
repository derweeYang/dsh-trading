"""QuoteClient.request_history 形参是 (market, code, start, end, period_ms, type, limit, cb)。

形参名 symbol/period 误导；多传 period 字符串会 TypeError（10 vs 8–9）。
回调是 (status, tag, bars)，不是单根 bar。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from dsh_iquant_quote.live import LiveBackend


class _FakeRequest:
    def __init__(self, callback, bars):
        self._callback = callback
        self._bars = bars
        self.closed = False

    def wait(self, timeout_ms=-1):
        if self._callback is not None:
            self._callback(0, 0, self._bars)
        return 0

    def close(self):
        self.closed = True


class _FakeClient:
    """与 iquant.quote.QuoteClient.request_history 同 arity。"""

    def __init__(self, bars):
        self.bars = bars
        self.calls = []
        self.last_request = None

    def request_history(
        self,
        symbol,
        period,
        start_ms,
        end_ms,
        period_ms,
        kline_type,
        limit,
        callback=None,
    ):
        self.calls.append(
            {
                "symbol": symbol,
                "period": period,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "period_ms": period_ms,
                "kline_type": kline_type,
                "limit": limit,
            }
        )
        req = _FakeRequest(callback, self.bars)
        self.last_request = req
        return req


def test_history_bars_matches_sdk_arity_and_callback():
    backend = LiveBackend()
    client = _FakeClient(
        [
            {
                "timestamp_ms": 1_700_000_000_000,
                "open": 3.0,
                "high": 3.1,
                "low": 2.9,
                "close": 3.05,
                "volume": 100,
            }
        ]
    )
    backend._client = client

    bars = backend.history_bars("SH", "510050", 1, 2, 20)

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["symbol"] == "SH"
    assert call["period"] == "510050"
    assert call["period_ms"] == 86_400_000
    assert call["kline_type"] == 3001
    assert call["limit"] == 20
    assert bars[0]["close"] == 3.05
    assert client.last_request is not None
    assert client.last_request.closed is True


def test_klines_1m_uses_minute_period_ms():
    # 1m klines 有停更闸门：注入盘中时钟，最新 bar 钉在同一分钟避免 STALE 误报。
    now = datetime(2026, 9, 11, 10, 30, tzinfo=timezone(timedelta(hours=8)))
    backend = LiveBackend()
    backend._now = lambda: now
    client = _FakeClient(
        [
            {
                "timestamp_ms": int(now.timestamp() * 1000),
                "open": 1,
                "high": 1,
                "low": 1,
                "close": 1,
                "volume": 1,
            }
        ]
    )
    backend._client = client
    backend.klines("SZ", "000001", "1m", 10)
    assert client.calls[0]["period_ms"] == 60_000
    assert client.calls[0]["period"] == "000001"


CST = timezone(timedelta(hours=8))


def _minute_bars(start: datetime, count: int) -> list[dict]:
    return [
        {
            "timestamp_ms": int((start + timedelta(minutes=i)).timestamp() * 1000),
            "open": 1,
            "high": 1,
            "low": 1,
            "close": 1,
            "volume": 1,
        }
        for i in range(count)
    ]


def _session_bars(day: datetime, count: int) -> list[dict]:
    """模拟 SDK 整仓交付：从 15:00 收盘往回数 count 根（跳过午休），按时间升序返回。"""
    out: list[dict] = []
    t = day.replace(hour=15, minute=0, second=0, microsecond=0)
    while len(out) < count:
        out.append(
            {
                "timestamp_ms": int(t.timestamp() * 1000),
                "open": 1,
                "high": 1,
                "low": 1,
                "close": 1,
                "volume": 1,
            }
        )
        t -= timedelta(minutes=1)
        if t.hour == 12 or (t.hour == 13 and t.minute == 0):
            t = t.replace(hour=11, minute=30)
    out.reverse()
    return out


def test_klines_1m_weekend_window_anchors_last_session_close():
    # 2026-09-13 是周日；最近已完成交易时段 = 周五 2026-09-11 15:00 收盘。
    # SDK 1m 窗口天粒度：start 锚周五 00:00、limit=250 全量交付当天 239 根，裁尾取最新 60。
    now = datetime(2026, 9, 13, 14, 9, tzinfo=CST)
    backend = LiveBackend()
    backend._now = lambda: now
    friday_close = datetime(2026, 9, 11, 15, 0, tzinfo=CST)
    # SDK 整仓交付周五全天（09:31–11:30 + 13:00–15:00 共 239 根）。
    client = _FakeClient(_session_bars(datetime(2026, 9, 11, tzinfo=CST), 239))
    backend._client = client

    bars = backend.klines("SH", "510050", "1m", 60)

    call = client.calls[0]
    assert call["start_ms"] == int(
        datetime(2026, 9, 11, 0, 0, tzinfo=CST).timestamp() * 1000
    )
    assert call["limit"] == 250  # 单日全量容量
    assert len(bars) == 60  # 裁尾保留最新 60 根
    assert bars[-1]["openTime"] == int(friday_close.timestamp() * 1000)
    # 非交易窗口当日缓存复用：第二次调用不再打 SDK（停更日挤兑的周末形态随之消失）。
    again = backend.klines("SH", "510050", "1m", 60)
    assert len(client.calls) == 1
    assert again is bars


def test_klines_1m_weekend_large_limit_spans_trading_days():
    # limit=480 → 3 个交易日容量：窗口头多开 2 天、limit=750，裁尾后仍以 anchor 收盘为最新。
    now = datetime(2026, 9, 13, 14, 9, tzinfo=CST)
    backend = LiveBackend()
    backend._now = lambda: now
    three_days = (
        _session_bars(datetime(2026, 9, 9, tzinfo=CST), 239)
        + _session_bars(datetime(2026, 9, 10, tzinfo=CST), 239)
        + _session_bars(datetime(2026, 9, 11, tzinfo=CST), 239)
    )
    client = _FakeClient(three_days)
    backend._client = client

    bars = backend.klines("SH", "510050", "1m", 480)

    call = client.calls[0]
    assert call["start_ms"] == int(
        datetime(2026, 9, 9, 0, 0, tzinfo=CST).timestamp() * 1000
    )
    assert call["limit"] == 750
    assert len(bars) == 480
    assert bars[-1]["openTime"] == int(
        datetime(2026, 9, 11, 15, 0, tzinfo=CST).timestamp() * 1000
    )


def test_klines_1d_weekend_keeps_wallclock_window():
    now = datetime(2026, 9, 13, 14, 9, tzinfo=CST)
    backend = LiveBackend()
    backend._now = lambda: now
    client = _FakeClient(_minute_bars(now, 3))
    backend._client = client

    backend.klines("SH", "510050", "1d", 750)

    call = client.calls[0]
    assert call["start_ms"] == int(now.timestamp() * 1000) - 750 * 86_400_000 * 2
    assert call["limit"] == 750  # 日 K 不加余量


def test_klines_1m_after_hours_anchor_includes_close_bar():
    # 盘后（周五 16:00）anchor 回指当天 15:00：窗口锚当天 00:00，15:00 收盘 bar 必然入窗。
    now = datetime(2026, 9, 11, 16, 0, tzinfo=CST)
    backend = LiveBackend()
    backend._now = lambda: now
    client = _FakeClient(_session_bars(datetime(2026, 9, 11, tzinfo=CST), 239))
    backend._client = client

    bars = backend.klines("SH", "510050", "1m", 60)

    call = client.calls[0]
    assert call["start_ms"] == int(
        (datetime(2026, 9, 11, 0, 0, tzinfo=CST)).timestamp() * 1000
    )
    assert call["limit"] == 250
    assert bars[-1]["openTime"] == int(
        datetime(2026, 9, 11, 15, 0, tzinfo=CST).timestamp() * 1000
    )
