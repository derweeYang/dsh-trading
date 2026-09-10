# source=iquant:经注入 runner 调 iquant-quote,结果 source 为 iquant;默认 synth,可转发 live。

from pathlib import Path

import pytest

from dsh_options import chain, contracts, daily, iquant, underlying_daily
from dsh_options.protocol import OptionsError


def _quote(code: str, strike: float, last: float = 0.18, pre_close: float = 0.17, volume: int = 1000):
    return {
        "code": code,
        "strike": strike,
        "last": last,
        "preClose": pre_close,
        "volume": volume,
        "changePct": round((last - pre_close) / pre_close * 100.0, 4),
    }


def _install_runner(monkeypatch, calls: list):
    def run(subcommand: str, body: dict, _request: dict | None = None):
        calls.append((subcommand, dict(body)))
        assert body["source"] == "synth"
        if subcommand == "option_instruments":
            underlying = body["underlying"]
            strike = 2.85 if underlying == "510050" else 2.45
            scaled = f"{round(strike * 1000):05d}"
            return {
                "instruments": [
                    {
                        "code": f"{underlying}C2609M{scaled}",
                        "optionType": "C",
                        "strike": strike,
                        "expiryMonth": "2609",
                        "expiryDate": "2026-09-23",
                        "multiplier": 10000,
                        "underlying": underlying,
                    },
                    {
                        "code": f"{underlying}P2609M{scaled}",
                        "optionType": "P",
                        "strike": strike,
                        "expiryMonth": "2609",
                        "expiryDate": "2026-09-23",
                        "multiplier": 10000,
                        "underlying": underlying,
                    },
                ]
            }
        if subcommand == "option_chain":
            underlying = body["underlying"]
            month = body["expiryMonth"]
            strike = 2.85 if underlying == "510050" else 2.45
            scaled = f"{round(strike * 1000):05d}"
            return {
                "expiryDate": "2026-09-23",
                "snapshotAt": "2026-09-01T15:00:00+08:00",
                "calls": [_quote(f"{underlying}C{month}M{scaled}", strike)],
                "puts": [_quote(f"{underlying}P{month}M{scaled}", strike, last=0.01, pre_close=0.012)],
            }
        if subcommand == "history_bars":
            start = body["startMs"]
            return {
                "bars": [
                    {
                        "timestampMs": start,
                        "open": 0.18,
                        "high": 0.19,
                        "low": 0.17,
                        "close": 0.185,
                        "volume": 100,
                        "amount": 18.5,
                    },
                    {
                        "timestampMs": start + 86_400_000,
                        "open": 0.185,
                        "high": 0.20,
                        "low": 0.18,
                        "close": 0.19,
                        "volume": 110,
                        "amount": 20.9,
                    },
                ]
            }
        raise AssertionError(f"unexpected subcommand {subcommand}")

    monkeypatch.setattr(iquant, "call_quote", run)


def test_iquant_registry_lists_sse_and_szse_boards():
    result = contracts.handle_underlyings({"source": "iquant"})
    quotes = {row["underlying"]: row["quotesSource"] for row in result["underlyings"]}
    assert quotes["510050"] == "iquant_board"
    assert quotes["510300"] == "iquant_board"
    assert quotes["159915"] == "iquant_board"
    assert quotes["159901"] == "iquant_board"
    assert result["rows"] == 9
    assert result["source"] == "iquant"


def test_chain_iquant_serves_sse_and_szse(monkeypatch):
    calls: list = []
    _install_runner(monkeypatch, calls)
    sse = chain.handle_chain({"source": "iquant", "underlying": "510050", "expiryMonth": "2609"})
    assert sse["source"] == "iquant"
    assert sse["calls"][0]["code"] == "510050C2609M02850"
    assert sse["calls"][0]["prevSettle"] == 0.17
    assert sse["calls"][0]["volume"] == 1000
    assert sse["calls"][0]["changePct"] == pytest.approx(5.8824)
    szse = chain.handle_chain({"source": "iquant", "underlying": "159915", "expiryMonth": "2609"})
    assert szse["source"] == "iquant"
    assert szse["puts"][0]["code"] == "159915P2609M02450"
    assert all(body["source"] == "synth" for _, body in calls)
    assert {body["market"] for _, body in calls} == {"SHO", "SZO"}


def test_contracts_iquant_writes_cache(tmp_path, monkeypatch):
    calls: list = []
    _install_runner(monkeypatch, calls)
    result = contracts.handle_contracts(
        {"source": "iquant", "underlying": "510050", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    assert result["source"] == "iquant"
    assert result["rows"] == 2
    assert Path(result["cachePath"]).as_posix().endswith("contracts/iquant/510050.parquet")
    assert calls[0][0] == "option_instruments"


def test_fetch_daily_iquant_maps_history_bars(tmp_path, monkeypatch):
    calls: list = []
    _install_runner(monkeypatch, calls)
    result = daily.handle_fetch_daily(
        {"source": "iquant", "contract": "510050C2609M02850", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    assert result["rows"] == 2
    assert result["cached"] is False
    assert Path(result["cachePath"]).as_posix().endswith("daily/iquant/510050C2609M02850.parquet")
    subcommand, body = calls[0]
    assert subcommand == "history_bars"
    assert body["source"] == "synth"
    assert body["symbol"] == "510050C2609M02850"
    assert body["period"] == "1d"
    assert body["market"] == "SHO"


def test_underlying_daily_iquant_uses_the_iquant_namespace(tmp_path, monkeypatch):
    calls: list = []
    _install_runner(monkeypatch, calls)
    result = underlying_daily.handle_fetch_underlying_daily(
        {"source": "iquant", "underlying": "159915", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    assert result["source"] == "iquant"
    assert result["rows"] == 1
    assert result["underlyings"][0]["exchange"] == "SZSE"
    assert "iquant" in Path(result["underlyings"][0]["cachePath"]).as_posix()
    assert calls[0][1]["symbol"] == "159915"
    assert calls[0][1]["market"] == "SZ"


def test_iquant_unsupported_is_honest_no_data(monkeypatch):
    def boom(_subcommand, _body, _request=None):
        raise iquant.QuoteReplyError("UNSUPPORTED", "live market data requires Windows")

    monkeypatch.setattr(iquant, "call_quote", boom)
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "iquant", "underlying": "510050", "expiryMonth": "2609"})
    assert err.value.code == "NO_DATA"
    assert "iquant-quote cannot serve this" in err.value.message
    assert "Windows" in err.value.message


def test_chain_iquant_rejects_unknown_underlying():
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "iquant", "underlying": "600519", "expiryMonth": "2609"})
    assert err.value.code == "BAD_REQUEST"


def test_run_quote_forwards_live_host_facts(monkeypatch):
    seen = {}

    def fake_call(subcommand, body, request):
        seen["subcommand"] = subcommand
        seen["body"] = body
        return {"ok": True}

    monkeypatch.setattr(iquant, "call_quote", fake_call)
    iquant.run_quote(
        "option_chain",
        {"market": "SZ", "underlying": "159915", "expiryMonth": "2609"},
        {
            "iquantArgvPrefix": ["uv", "run", "dsh-iquant-quote"],
            "iquantSource": "live",
            "allowNetworkLogin": True,
            "sdkPath": r"D:\sdk\python",
            "apiDllPath": r"D:\a.dll",
            "vendorQmtquotePath": r"D:\qmtquote.dll",
            "quoteConfigPath": r"D:\xtquoterconfig.xml",
            "snapshotWaitMs": 3000,
        },
    )
    assert seen["body"]["source"] == "live"
    assert seen["body"]["allowNetworkLogin"] is True
    assert seen["body"]["sdkPath"] == r"D:\sdk\python"
    assert seen["body"]["maxWaitMs"] == 3000


def test_fetch_spot_uses_snapshot_last_when_live(monkeypatch):
    calls: list = []

    def run(subcommand, body, _request=None):
        calls.append(subcommand)
        if subcommand == "snapshot":
            return {"snapshots": [{"last": 3.037}]}
        raise AssertionError(f"unexpected {subcommand}")

    monkeypatch.setattr(iquant, "run_quote", run)
    assert iquant.fetch_spot("510050", {}) == pytest.approx(3.037)
    assert calls == ["snapshot"]


def test_fetch_spot_falls_back_to_daily_close_when_snapshot_empty(monkeypatch):
    calls: list = []

    def run(subcommand, body, _request=None):
        calls.append((subcommand, body["market"] if "market" in body else None, body.get("symbol")))
        if subcommand == "snapshot":
            raise OptionsError("NO_DATA", "no snapshot for ['510050'] on SH")
        if subcommand == "history_bars":
            assert body["market"] == "SH"
            assert body["symbol"] == "510050"
            assert body["limit"] == 8
            return {"bars": [{"close": 3.01}, {"close": 3.037}]}
        raise AssertionError(f"unexpected {subcommand}")

    monkeypatch.setattr(iquant, "run_quote", run)
    assert iquant.fetch_spot("510050", {}) == pytest.approx(3.037)
    assert [item[0] for item in calls] == ["snapshot", "history_bars"]


def test_fetch_spot_treats_zero_snapshot_as_missing(monkeypatch):
    def run(subcommand, body, _request=None):
        if subcommand == "snapshot":
            return {"snapshots": [{"last": 0}]}
        if subcommand == "history_bars":
            return {"bars": [{"close": 4.616}]}
        raise AssertionError(f"unexpected {subcommand}")

    monkeypatch.setattr(iquant, "run_quote", run)
    assert iquant.fetch_spot("510300", {}) == pytest.approx(4.616)


def test_fetch_spot_propagates_snapshot_network(monkeypatch):
    def run(subcommand, _body, _request=None):
        if subcommand == "snapshot":
            raise OptionsError("NETWORK", "iquant-quote gateway unreachable")
        raise AssertionError("must not fall back after NETWORK")

    monkeypatch.setattr(iquant, "run_quote", run)
    with pytest.raises(OptionsError) as err:
        iquant.fetch_spot("510050", {})
    assert err.value.code == "NETWORK"


def test_fetch_spot_no_data_when_both_paths_empty(monkeypatch):
    def run(subcommand, _body, _request=None):
        raise OptionsError("NO_DATA", f"empty {subcommand}")

    monkeypatch.setattr(iquant, "run_quote", run)
    with pytest.raises(OptionsError) as err:
        iquant.fetch_spot("510050", {})
    assert err.value.code == "NO_DATA"
    assert "510050" in err.value.message


def test_run_quote_stays_synth_without_live_flag(monkeypatch):
    seen = {}

    def fake_call(subcommand, body, request):
        seen["body"] = body
        return {"instruments": []}

    monkeypatch.setattr(iquant, "call_quote", fake_call)
    iquant.run_quote(
        "option_instruments",
        {"market": "SH", "underlying": "510050"},
        {"iquantArgvPrefix": ["uv", "run", "dsh-iquant-quote"]},
    )
    assert seen["body"]["source"] == "synth"
    assert "sdkPath" not in seen["body"]


def test_run_quote_live_missing_host_path_raises(monkeypatch):
    called = False

    def fake_call(*_args, **_kwargs):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(iquant, "call_quote", fake_call)
    with pytest.raises(OptionsError) as err:
        iquant.run_quote(
            "option_chain",
            {"market": "SZ", "underlying": "159915"},
            {
                "iquantSource": "live",
                "allowNetworkLogin": True,
                "apiDllPath": r"D:\a.dll",
                "vendorQmtquotePath": r"D:\qmtquote.dll",
                "quoteConfigPath": r"D:\xtquoterconfig.xml",
            },
        )
    assert err.value.code == "BAD_REQUEST"
    assert called is False
