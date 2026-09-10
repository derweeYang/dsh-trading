"""LiveBackend 用 SHO/SZO 名单 + tick（盘后回落日 K）组 T 板，不再空抛 NO_DATA。"""

from __future__ import annotations

from datetime import date

import pytest

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.live import LiveBackend


@pytest.fixture(autouse=True)
def _market_window_open(monkeypatch):
    """默认按盘中跑；窗口短路行为另有专门测试。"""
    monkeypatch.setattr(
        "dsh_iquant_quote.live.trading_window_open", lambda moment=None: True
    )


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


class _FakeQuoteClient:
    def __init__(self, names, ticks=None, bars_by_code=None):
        self.names = names
        self.ticks = ticks or {}
        self.bars_by_code = bars_by_code or {}
        self.subscribed = None
        self.unsubscribed = []
        self.history_calls = []

    def get_instrument_names(self, market):
        return [row for row in self.names if row["market"] == market]

    def subscribe_symbols(self, market, codes):
        self.subscribed = (market, list(codes))
        return 7

    def unsubscribe(self, sub_id):
        self.unsubscribed.append(sub_id)

    def drain(self, on_tick, max_count=64, timeout_ms=200):
        if self.subscribed is None:
            return 0
        market, _codes = self.subscribed
        emitted = 0
        for code, snap in self.ticks.items():
            on_tick(code, snap)
            emitted += 1
        return emitted

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
        self.history_calls.append((symbol, period))
        bars = self.bars_by_code.get(period, [])
        return _FakeRequest(callback, bars)


def _backend(client, as_of=date(2026, 9, 8)):
    backend = LiveBackend()
    backend._client = client
    backend._as_of = as_of
    return backend


def test_option_instruments_parses_names_into_long_codes():
    client = _FakeQuoteClient(
        [
            {"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"},
            {"market": "SHO", "code": "10011256", "name": "50ETF沽9月2650"},
            {"market": "SHO", "code": "10019999", "name": "300ETF购9月4000"},
        ]
    )
    rows = _backend(client).option_instruments("SHO", "510050")
    assert {row["code"] for row in rows} == {"510050C2609M02650", "510050P2609M02650"}
    assert rows[0]["shortCode"] == "10011255" or rows[1]["shortCode"] == "10011255"
    assert all(row["expiryMonth"] == "2609" for row in rows)
    assert all(row["multiplier"] == 10000 for row in rows)


def test_option_chain_uses_ticks_when_drain_has_prints():
    client = _FakeQuoteClient(
        [
            {"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"},
            {"market": "SHO", "code": "10011256", "name": "50ETF沽9月2650"},
        ],
        ticks={
            "10011255": {
                "last": 0.3658,
                "pre_close": 0.35,
                "volume": 1200,
                "timestamp_ms": 1_757_000_000_000,
            },
            "10011256": {
                "last": 0.012,
                "pre_close": 0.014,
                "volume": 800,
                "timestamp_ms": 1_757_000_000_000,
            },
        },
    )
    chain = _backend(client).option_chain("SHO", "510050", "2609")
    assert chain["expiryDate"] == "2026-09-23"
    assert chain["calls"][0]["code"] == "510050C2609M02650"
    assert chain["calls"][0]["last"] == pytest.approx(0.3658)
    assert chain["calls"][0]["preClose"] == pytest.approx(0.35)
    assert chain["calls"][0]["volume"] == 1200
    assert chain["puts"][0]["code"] == "510050P2609M02650"
    assert chain["puts"][0]["last"] == pytest.approx(0.012)
    assert client.subscribed == ("SHO", ["10011255", "10011256"])
    assert client.unsubscribed == [7]


def test_option_chain_falls_back_to_daily_when_drain_empty():
    client = _FakeQuoteClient(
        [
            {"market": "SZO", "code": "90007061", "name": "创业板ETF购9月3000"},
        ],
        ticks={},
        bars_by_code={
            "90007061": [
                {
                    "timestamp_ms": 1_756_800_000_000,
                    "open": 0.18,
                    "high": 0.19,
                    "low": 0.17,
                    "close": 0.185,
                    "volume": 100,
                },
                {
                    "timestamp_ms": 1_756_886_400_000,
                    "open": 0.185,
                    "high": 0.20,
                    "low": 0.18,
                    "close": 0.19,
                    "volume": 110,
                },
            ]
        },
    )
    chain = _backend(client).option_chain("SZO", "159915", "2609")
    assert chain["calls"][0]["code"] == "159915C2609M03000"
    assert chain["calls"][0]["last"] == pytest.approx(0.19)
    assert chain["calls"][0]["preClose"] == pytest.approx(0.185)
    assert chain["calls"][0]["volume"] == 110
    assert client.history_calls == [("SZO", "90007061")]


def test_option_chain_no_matching_names_is_no_data():
    client = _FakeQuoteClient(
        [{"market": "SHO", "code": "10019999", "name": "300ETF购9月4000"}]
    )
    with pytest.raises(QuoteGatewayError) as err:
        _backend(client).option_chain("SHO", "510050", "2609")
    assert err.value.code == "NO_DATA"


def test_option_chain_closed_window_skips_tick_subscription(monkeypatch):
    monkeypatch.setattr(
        "dsh_iquant_quote.live.trading_window_open", lambda moment=None: False
    )
    client = _FakeQuoteClient(
        [{"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"}],
        ticks={
            "10011255": {
                "last": 0.3658,
                "pre_close": 0.35,
                "volume": 1200,
                "timestamp_ms": 1,
            }
        },
        bars_by_code={
            "10011255": [
                {
                    "timestamp_ms": 1_756_886_400_000,
                    "open": 0.2,
                    "high": 0.21,
                    "low": 0.19,
                    "close": 0.205,
                    "volume": 50,
                }
            ]
        },
    )
    chain = _backend(client).option_chain("SHO", "510050", "2609")
    assert client.subscribed is None  # 窗口外不订阅
    assert chain["calls"][0]["last"] == pytest.approx(0.205)  # 走日 K 回落
