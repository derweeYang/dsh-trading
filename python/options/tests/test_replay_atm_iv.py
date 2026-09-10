# replay_atm_iv:synth 离线回放近月 ATM;iquant 经注入 runner。

from datetime import date, datetime, timezone

import pytest

from dsh_options import iquant, replay_atm_iv, synth
from dsh_options.protocol import OptionsError


def test_replay_synth_writes_near_month_atm_rows(tmp_path):
    result = replay_atm_iv.handle_replay_atm_iv(
        {
            "source": "synth",
            "underlying": "910050",
            "start": "2026-07-01",
            "end": "2026-09-05",
            "lookbackDays": 60,
            "maxTermDays": 45,
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    assert result["source"] == "synth"
    assert result["okDays"] > 0
    first = result["rows"][0]
    assert first["underlying"] == synth.SYNTH_UNDERLYING
    assert first["source"] == "replay"
    assert 0.01 < first["atmIv"] < 2.0
    assert first["expiryMonth"]
    dates = [row["date"] for row in result["rows"]]
    assert dates == sorted(dates)
    assert all(date.fromisoformat(row["expiryDate"]) > date.fromisoformat(row["date"]) for row in result["rows"])


def test_replay_akshare_rejected(tmp_path):
    with pytest.raises(OptionsError) as err:
        replay_atm_iv.handle_replay_atm_iv(
            {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"


def test_replay_iquant_needs_rate(tmp_path):
    with pytest.raises(OptionsError) as err:
        replay_atm_iv.handle_replay_atm_iv(
            {"source": "iquant", "underlying": "510050", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"
    assert "rate" in err.value.message


def test_replay_iquant_uses_short_code_for_option_bars(tmp_path, monkeypatch):
    calls: list = []

    def run(subcommand: str, body: dict, _request=None):
        calls.append((subcommand, dict(body)))
        if subcommand == "option_instruments":
            return {
                "instruments": [
                    {
                        "code": "510050C2609M02850",
                        "shortCode": "10011255",
                        "optionType": "C",
                        "strike": 2.85,
                        "expiryMonth": "2609",
                        "expiryDate": "2026-09-23",
                        "multiplier": 10000,
                    },
                    {
                        "code": "510050P2609M02850",
                        "shortCode": "10011256",
                        "optionType": "P",
                        "strike": 2.85,
                        "expiryMonth": "2609",
                        "expiryDate": "2026-09-23",
                        "multiplier": 10000,
                    },
                ]
            }
        if subcommand == "history_bars":
            market = body["market"]
            origin = int(datetime(2026, 8, 10, tzinfo=timezone.utc).timestamp() * 1000)
            bars = []
            for i in range(25):
                close = 2.85 if market in {"SH", "SZ"} else 0.12
                bars.append(
                    {
                        "timestampMs": origin + i * 86_400_000,
                        "open": close,
                        "high": close,
                        "low": close,
                        "close": close,
                        "volume": 100,
                        "amount": close * 100,
                    }
                )
            return {"bars": bars}
        raise AssertionError(subcommand)

    monkeypatch.setattr(iquant, "run_quote", run)
    result = replay_atm_iv.handle_replay_atm_iv(
        {
            "source": "iquant",
            "underlying": "510050",
            "rate": 0.02,
            "start": "2026-08-10",
            "end": "2026-09-05",
            "lookbackDays": 20,
            "maxTermDays": 45,
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    option_hist = [body for cmd, body in calls if cmd == "history_bars" and body["market"] == "SHO"]
    assert option_hist
    assert {body["symbol"] for body in option_hist} <= {"10011255", "10011256"}
    assert result["okDays"] > 0
    assert result["rows"][0]["underlying"] == "510050"
    assert result["okDays"] < 21 or any(row.get("hv20") is not None for row in result["rows"])
