# T 型报价:synth 截面结构、akshare board 解析(mock)、深交所缺口显式 NO_DATA。

import pandas as pd
import pytest

from dsh_options import chain
from dsh_options.protocol import OptionsError


def test_chain_synth_structure():
    result = chain.handle_chain({"source": "synth", "underlying": "910050", "expiryMonth": "2609"})
    assert result["expiryMonth"] == "2609"
    assert result["expiryDate"] == "2026-09-23"
    assert result["snapshotAt"].endswith("T15:00:00+08:00")
    assert len(result["calls"]) == 9 and len(result["puts"]) == 9
    strikes = [q["strike"] for q in result["calls"]]
    assert strikes == sorted(strikes)
    assert strikes[0] == 2.80 and strikes[-1] == 3.20
    assert all(
        {"code", "strike", "last", "prevSettle", "volume"} <= set(q) for q in result["calls"]
    )


def test_chain_synth_missing_month_and_wrong_underlying():
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "synth", "underlying": "910050", "expiryMonth": "2610"})
    assert err.value.code == "NO_DATA"
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "synth", "underlying": "510050", "expiryMonth": "2609"})
    assert err.value.code == "BAD_REQUEST"


def test_chain_akshare_parses_board(monkeypatch, sse_board_df):
    import akshare as ak

    monkeypatch.setattr(ak, "option_finance_board", lambda symbol, end_month: sse_board_df)
    result = chain.handle_chain(
        {"source": "akshare", "underlying": "510050", "expiryMonth": "2609"}
    )
    assert result["snapshotAt"] == "2026-09-04T16:29:01+08:00"
    assert [q["strike"] for q in result["calls"]] == [2.85, 2.90]
    assert result["calls"][0]["code"] == "510050C2609M02850"
    assert result["calls"][0]["prevSettle"] == 0.181
    assert [q["strike"] for q in result["puts"]] == [2.85, 2.90]


def test_chain_akshare_empty_board_is_no_data(monkeypatch):
    import akshare as ak

    monkeypatch.setattr(
        ak,
        "option_finance_board",
        lambda symbol, end_month: pd.DataFrame(),
    )
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "akshare", "underlying": "510050", "expiryMonth": "2712"})
    assert err.value.code == "NO_DATA"


def test_chain_szse_gap_is_explicit_no_data():
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "akshare", "underlying": "159915", "expiryMonth": "2609"})
    assert err.value.code == "NO_DATA"
    assert "szse_static_only" in err.value.message


def test_chain_rejects_unknowns():
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "bogus", "underlying": "510050", "expiryMonth": "2609"})
    assert err.value.code == "BAD_REQUEST"
    with pytest.raises(OptionsError) as err:
        chain.handle_chain({"source": "akshare", "underlying": "000000", "expiryMonth": "2609"})
    assert err.value.code == "BAD_REQUEST"
