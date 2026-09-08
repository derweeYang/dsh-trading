# 合约静态表:注册表读面、synth 快照、akshare SSE/SZSE 两条路径(mock 网络)。

from pathlib import Path

import pytest

from dsh_options import contracts
from dsh_options.protocol import OptionsError


def test_underlyings_registry():
    for source in ("synth", "akshare"):
        result = contracts.handle_underlyings({"source": source})
        assert result["source"] == source
        assert result["rows"] == len(result["underlyings"]) >= 1
    with pytest.raises(OptionsError) as err:
        contracts.handle_underlyings({"source": "bogus"})
    assert err.value.code == "BAD_REQUEST"
    # akshare 注册表必须区分行情可用性(SSE 行情 / SZSE 仅静态)
    quotes = {
        u["underlying"]: u["quotesSource"]
        for u in contracts.handle_underlyings({"source": "akshare"})["underlyings"]
    }
    assert quotes["510050"] == "sse_board"
    assert quotes["159915"] == "szse_static_only"
    assert quotes["159922"] == "szse_static_only"


def test_contracts_synth_snapshot_and_cache(tmp_path):
    request = {"source": "synth", "cacheDir": str(tmp_path)}
    result = contracts.handle_contracts(request, tmp_path)
    assert result["source"] == "synth"
    assert result["rows"] == 3 * 9 * 2  # 2 活跃月 + 1 摘牌月 × 9 档 × C/P
    assert any(c["expiryMonth"] == "2606" for c in result["contracts"])
    assert all(c["multiplier"] == 10000 for c in result["contracts"])
    snapshot = Path(result["cachePath"])
    assert snapshot.exists()
    # 二次调用命中快照(不重算)
    again = contracts.handle_contracts(request, tmp_path)
    assert again["cachePath"] == result["cachePath"]
    assert again["rows"] == result["rows"]


def test_contracts_sse_via_board_mock(tmp_path, monkeypatch):
    from dsh_options import chain as chain_mod

    board_calls: list[tuple[str, str]] = []

    def fake_fetch_board(board_name: str, month: str) -> list[dict]:
        board_calls.append((board_name, month))
        return [
            {
                "code": f"510050C{month}M02850",
                "optionType": "C",
                "strike": 2.85,
                "last": 0.1861,
                "changePct": 2.82,
                "prevSettle": 0.181,
                "snapshotAt": "2026-09-04T16:29:01+08:00",
            },
            {
                "code": f"510050P{month}M02850",
                "optionType": "P",
                "strike": 2.85,
                "last": 0.0103,
                "changePct": -1.9,
                "prevSettle": 0.0105,
                "snapshotAt": "2026-09-04T16:29:01+08:00",
            },
        ]

    monkeypatch.setattr(chain_mod, "fetch_board", fake_fetch_board)
    request = {
        "source": "akshare",
        "underlying": "510050",
        "expiryMonths": ["2609", "2612"],
        "cacheDir": str(tmp_path),
    }
    result = contracts.handle_contracts(request, tmp_path)
    assert result["rows"] == 4
    assert {c["expiryMonth"] for c in result["contracts"]} == {"2609", "2612"}
    assert all(
        c["expiryDate"] == "2026-09-23" for c in result["contracts"] if c["expiryMonth"] == "2609"
    )
    assert Path(result["cachePath"]).exists()
    # 二次调用读快照,不再调 board
    board_calls.clear()
    again = contracts.handle_contracts(request, tmp_path)
    assert again["rows"] == 4
    assert board_calls == []


def test_contracts_szse_static_table(tmp_path, monkeypatch, szse_static_df):
    import akshare as ak

    monkeypatch.setattr(ak, "option_finance_board", lambda symbol, end_month: szse_static_df)
    result = contracts.handle_contracts(
        {
            "source": "akshare",
            "underlying": "159901",
            "expiryMonths": ["2609"],
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    assert result["rows"] == 2
    types = sorted(c["optionType"] for c in result["contracts"])
    assert types == ["C", "P"]
    assert all(
        c["expiryDate"] == "2026-09-23" and c["multiplier"] == 10000 for c in result["contracts"]
    )


def test_contracts_rejects_unknown_underlying_and_source(tmp_path):
    for bad in (
        {"source": "akshare", "underlying": "000000", "cacheDir": str(tmp_path)},
        {"source": "bogus", "underlying": "510050", "cacheDir": str(tmp_path)},
    ):
        with pytest.raises(OptionsError) as err:
            contracts.handle_contracts(bad, tmp_path)
        assert err.value.code == "BAD_REQUEST"
