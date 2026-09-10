"""盘后 drain 空时 ticker 回落日 K，模拟下单才有有效成交价。"""

from __future__ import annotations

import pytest

from dsh_iquant_quote.errors import QuoteGatewayError

from test_option_chain import _FakeQuoteClient, _backend


@pytest.fixture(autouse=True)
def _market_window_open(monkeypatch):
    """默认按盘中跑；窗口短路行为另有专门测试。"""
    monkeypatch.setattr(
        "dsh_iquant_quote.live.trading_window_open", lambda moment=None: True
    )


def test_ticker_uses_live_tick_when_drain_has_print():
    client = _FakeQuoteClient(
        [],
        ticks={
            "510050": {"last": 3.02, "pre_close": 3.01, "volume": 10, "timestamp_ms": 9}
        },
    )
    row = _backend(client).ticker("SH", "510050")
    assert row["last"] == pytest.approx(3.02)
    assert row["preClose"] == pytest.approx(3.01)
    assert client.history_calls == []


def test_ticker_falls_back_to_daily_when_drain_empty():
    client = _FakeQuoteClient(
        [],
        ticks={},
        bars_by_code={
            "510050": [
                {
                    "timestamp_ms": 1_756_800_000_000,
                    "open": 3.0,
                    "high": 3.1,
                    "low": 2.9,
                    "close": 3.01,
                    "volume": 100,
                },
                {
                    "timestamp_ms": 1_756_886_400_000,
                    "open": 3.01,
                    "high": 3.05,
                    "low": 3.0,
                    "close": 3.017,
                    "volume": 110,
                },
            ]
        },
    )
    row = _backend(client).ticker("SH", "510050")
    assert row["symbol"] == "510050.SH"
    assert row["last"] == pytest.approx(3.017)
    assert row["preClose"] == pytest.approx(3.01)
    assert row["volume"] == 110
    assert client.history_calls == [("SH", "510050")]


def test_ticker_falls_back_when_tick_last_is_zero():
    client = _FakeQuoteClient(
        [],
        ticks={"510050": {"last": 0, "pre_close": 0, "volume": 0, "timestamp_ms": 1}},
        bars_by_code={
            "510050": [
                {
                    "timestamp_ms": 1,
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 2.91,
                    "volume": 1,
                }
            ]
        },
    )
    row = _backend(client).ticker("SH", "510050")
    assert row["last"] == pytest.approx(2.91)


def test_ticker_no_tick_and_no_daily_is_no_data():
    client = _FakeQuoteClient([], ticks={}, bars_by_code={})
    with pytest.raises(QuoteGatewayError) as err:
        _backend(client).ticker("SH", "510050")
    assert err.value.code == "NO_DATA"


def test_ticker_closed_window_skips_drain_and_uses_daily(monkeypatch):
    monkeypatch.setattr(
        "dsh_iquant_quote.live.trading_window_open", lambda moment=None: False
    )
    client = _FakeQuoteClient(
        [],
        ticks={
            "510050": {
                "last": 3.02,
                "pre_close": 3.01,
                "volume": 10,
                "timestamp_ms": 9,
            }
        },
        bars_by_code={
            "510050": [
                {
                    "timestamp_ms": 1,
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 2.91,
                    "volume": 1,
                }
            ]
        },
    )
    row = _backend(client).ticker("SH", "510050")
    assert row["last"] == pytest.approx(2.91)  # 窗口外不订阅不 drain，直接日 K
    assert client.subscribed is None
    assert client.history_calls == [("SH", "510050")]
