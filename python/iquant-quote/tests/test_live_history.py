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
