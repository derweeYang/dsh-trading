# price / implied_vol / parity_check 子命令 wire 层测试(synth offline + akshare mock)。
#
# 锚点纪律:数值断言用已知解析值(独立手算)或 synth 生成参数(vol=0.20 精确靶),
# 不用「实现输出 vs 实现输出」自证。

import json
import subprocess
import sys

import pytest

from dsh_options import pricing, synth
from dsh_options.protocol import OptionsError

SYNTH_REQ = {"source": "synth", "underlying": "910050", "expiryMonth": "2609", "asOf": "2026-09-01"}


class TestPriceCommand:
    def test_atm_call_known_value(self):
        """ATM call 手算锚:S=K=3, T=0.25, r=2%, σ=20% → d1=0.1, price=0.126965。"""
        result = pricing.handle_price(
            {"spot": 3.0, "strike": 3.0, "optionType": "C", "vol": 0.2, "years": 0.25, "rate": 0.02}
        )
        assert result["price"] == pytest.approx(0.12696479, abs=1e-7)
        assert result["delta"] == pytest.approx(0.539828, abs=1e-5)
        meta = result["meta"]
        assert meta["model"] == "bsm-european"
        assert meta["dividendYield"] == 0.0  # DO8:显式入 meta,缺省 0 也声明
        assert meta["priceBasis"] == "as-specified"

    def test_expiry_asof_equivalent_to_years(self):
        by_years = pricing.handle_price(
            {"spot": 3.0, "strike": 2.9, "optionType": "P", "vol": 0.25, "years": 0.5, "rate": 0.03}
        )
        by_dates = pricing.handle_price(
            {
                "spot": 3.0,
                "strike": 2.9,
                "optionType": "P",
                "vol": 0.25,
                "rate": 0.03,
                "expiryDate": "2027-03-04",
                "asOf": "2026-09-01",  # 184 天 = 0.50411 年
            }
        )
        assert by_dates["price"] == pytest.approx(by_years["price"], rel=5e-3)

    def test_expired_contract_rejected(self):
        with pytest.raises(OptionsError) as err:
            pricing.handle_price(
                {
                    "spot": 3.0,
                    "strike": 3.0,
                    "optionType": "C",
                    "vol": 0.2,
                    "expiryDate": "2026-09-01",
                    "asOf": "2026-09-23",
                }
            )
        assert err.value.code == "BAD_REQUEST"
        assert "already expired" in err.value.message

    def test_missing_or_invalid_fields(self):
        base = {"spot": 3.0, "strike": 3.0, "optionType": "C", "vol": 0.2}
        for bad, patch in [
            ("no time to expiry", {}),
            ("negative vol", {"vol": -0.1}),
            ("bad optionType", {"optionType": "X"}),
            ("zero spot", {"spot": 0}),
        ]:
            with pytest.raises(OptionsError, match=bad) if False else pytest.raises(OptionsError):
                pricing.handle_price({**base, **patch})
        with pytest.raises(OptionsError):
            pricing.handle_price({**base})  # 缺时间参数

    def test_dividend_yield_flows_through(self):
        result = pricing.handle_price(
            {
                "spot": 3.0,
                "strike": 3.0,
                "optionType": "C",
                "vol": 0.2,
                "years": 0.5,
                "rate": 0.02,
                "dividendYield": 0.03,
            }
        )
        assert result["meta"]["dividendYield"] == 0.03
        # q>0 压低 call 价(Merton 折现)
        no_div = pricing.handle_price(
            {"spot": 3.0, "strike": 3.0, "optionType": "C", "vol": 0.2, "years": 0.5, "rate": 0.02}
        )
        assert result["price"] < no_div["price"]

    def test_cli_subprocess_round_trip(self):
        request = json.dumps(
            {"spot": 3.0, "strike": 3.0, "optionType": "C", "vol": 0.2, "years": 0.25, "rate": 0.02}
        )
        proc = subprocess.run(
            [sys.executable, "-m", "dsh_options.cli", "price"],
            input=request,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,  # 退出码本身是断言对象
        )
        assert proc.returncode == 0
        doc = json.loads(proc.stdout)
        assert doc["ok"] and doc["result"]["price"] == pytest.approx(0.12696479, abs=1e-6)


class TestImpliedVolCommand:
    def test_live_month_recovers_generation_vol(self):
        """2612 在窗口末日存活:18/18 反解精确回 0.2000(synth 生成参数靶)。"""
        result = pricing.handle_implied_vol(
            {"source": "synth", "underlying": "910050", "expiryMonth": "2612"}
        )
        assert result["summary"] == {"n": 18, "converged": 18, "failed": 0}
        for row in result["results"]:
            assert row["iv"] == pytest.approx(0.20, abs=1e-4)
            assert row["method"] == "brent"
        meta = result["meta"]
        assert meta["rate"] == pricing.SYNTH_RATE
        assert "rateNote" in meta  # 声明这是生成参数而非市场事实
        assert meta["dividendYield"] == 0.0
        assert meta["priceField"] == "last"

    def test_historical_asof_near_month(self):
        """2609 历史截面:正常腿 0.2000,平价违约腿(call ×1.05)IV 显著偏高。"""
        result = pricing.handle_implied_vol(dict(SYNTH_REQ))
        by_code = {r["code"]: r for r in result["results"]}
        normal = [r for r in result["results"] if r["code"] != "910050C2609M03000"]
        assert all(r["iv"] == pytest.approx(0.20, abs=1e-4) for r in normal)
        assert by_code["910050C2609M03000"]["iv"] > 0.205  # 价偏移传导到 IV

    def test_expired_month_default_asof_rejected(self):
        """默认 asOf(窗口末)晚于近月到期:显式 BAD_REQUEST,提示 already expired。"""
        with pytest.raises(OptionsError) as err:
            pricing.handle_implied_vol(
                {"source": "synth", "underlying": "910050", "expiryMonth": "2609"}
            )
        assert err.value.code == "BAD_REQUEST"
        assert "already expired" in err.value.message

    def test_no_solution_explicitly_listed_not_dropped(self):
        """volBounds 抬到 [0.5, 5]:全部合约市价 < P(0.5) → below-intrinsic 逐行列出。"""
        result = pricing.handle_implied_vol(
            {
                "source": "synth",
                "underlying": "910050",
                "expiryMonth": "2612",
                "volBounds": [0.5, 5.0],
            }
        )
        assert result["summary"]["n"] == 18
        assert result["summary"]["converged"] == 0
        assert result["summary"]["failed"] == 18
        assert all(r["method"] == "below-intrinsic" and r["iv"] is None for r in result["results"])
        assert all("reason" in r for r in result["results"])  # 失败原因显式

    def test_asof_non_trading_day(self):
        with pytest.raises(OptionsError) as err:
            pricing.handle_implied_vol({**SYNTH_REQ, "asOf": "2026-09-05"})  # 周六
        assert err.value.code == "NO_DATA"

    def test_akshare_requires_explicit_rate(self):
        with pytest.raises(OptionsError) as err:
            pricing.handle_implied_vol(
                {"source": "akshare", "underlying": "510050", "expiryMonth": "2609"}
            )
        assert err.value.code == "BAD_REQUEST"
        assert "rate" in err.value.message

    def test_akshare_asof_rejected(self):
        with pytest.raises(OptionsError):
            pricing.handle_implied_vol(
                {
                    "source": "akshare",
                    "underlying": "510050",
                    "expiryMonth": "2609",
                    "rate": 0.02,
                    "asOf": "2026-09-01",
                }
            )

    def test_szse_static_only_no_data(self):
        with pytest.raises(OptionsError) as err:
            pricing.handle_implied_vol(
                {"source": "akshare", "underlying": "159915", "expiryMonth": "2609", "rate": 0.02}
            )
        assert err.value.code == "NO_DATA"

    def test_akshare_path_with_mocks(self, monkeypatch):
        """akshare 路径(board+spot 打桩):IV 反解与 synth 同一内核,输出形状一致。"""
        quotes = [
            {
                "code": "510050C2609M02900",
                "optionType": "C",
                "strike": 2.90,
                "last": 0.1391,
                "changePct": 5.3,
                "prevSettle": 0.1321,
                "snapshotAt": "2026-09-04T16:29:01+08:00",
            },
            {
                "code": "510050P2609M02900",
                "optionType": "P",
                "strike": 2.90,
                "last": 0.0132,
                "changePct": -2.1,
                "prevSettle": 0.0135,
                "snapshotAt": "2026-09-04T16:29:01+08:00",
            },
        ]
        monkeypatch.setattr(pricing.chain, "fetch_board", lambda board, month: quotes)
        monkeypatch.setattr(pricing, "fetch_spot_akshare", lambda u: 3.02)
        result = pricing.handle_implied_vol(
            {"source": "akshare", "underlying": "510050", "expiryMonth": "2609", "rate": 0.02}
        )
        assert result["summary"]["n"] == 2 and result["summary"]["failed"] == 0
        assert result["spot"] == 3.02
        assert result["meta"]["rate"] == 0.02 and "rateNote" not in result["meta"]
        assert all(0.0 < r["iv"] < 3.0 for r in result["results"])
        # prevSettle 口径切换:priceBasis 回显 + note 声明结算价语义
        result2 = pricing.handle_implied_vol(
            {
                "source": "akshare",
                "underlying": "510050",
                "expiryMonth": "2609",
                "rate": 0.02,
                "priceField": "prevSettle",
            }
        )
        assert result2["priceBasis"] == "prevSettle"
        assert "settlement price" in result2["priceBasisNote"]

    def test_synth_prev_settle_basis_note(self):
        result = pricing.handle_implied_vol({**SYNTH_REQ, "priceField": "prevSettle"})
        assert result["priceBasis"] == "prevSettle"
        assert "NOT an exchange settlement" in result["priceBasisNote"]  # 合成口径如实标注


class TestParityCommand:
    def test_default_chain_exactly_one_violation(self):
        """O1 预置靶:近月 K=3.00 call ×1.05 → 恰好 1 档 violation,其余 ≈0。"""
        result = pricing.handle_parity_check(dict(SYNTH_REQ))
        assert result["summary"]["n"] == 9
        assert result["summary"]["violations"] == 1
        flagged = [p for p in result["pairs"] if p["flag"] == "violation"]
        assert len(flagged) == 1 and flagged[0]["strike"] == pytest.approx(3.00)
        assert flagged[0]["deviation"] > 0.004  # +5% 价偏移的量级(约 44 ticks)
        clean = [p for p in result["pairs"] if p["flag"] == "ok"]
        assert all(abs(p["deviation"]) < result["summary"]["threshold"] for p in clean)

    def test_clean_chain_zero_violations(self, monkeypatch):
        """关闭违反的链(替换只读缓存入口):9 档全过——证明靶子是那一个合约。"""
        original = synth.make_chain
        monkeypatch.setattr(synth, "make_chain_cached", lambda: original(parity_violation=False))
        result = pricing.handle_parity_check(dict(SYNTH_REQ))
        assert result["summary"]["violations"] == 0
        assert result["summary"]["maxAbsDeviation"] < result["summary"]["threshold"]

    def test_custom_threshold_widens(self):
        result = pricing.handle_parity_check({**SYNTH_REQ, "threshold": 1.0})
        assert result["summary"]["violations"] == 0  # 阈值 1 元全放过(参数生效)
        assert result["summary"]["threshold"] == 1.0

    def test_threshold_default_declared(self):
        result = pricing.handle_parity_check(dict(SYNTH_REQ))
        assert result["summary"]["threshold"] == pytest.approx(0.0005)  # max(2×0.0001, 0.0005)

    def test_meta_carries_pricing_basis(self):
        result = pricing.handle_parity_check(dict(SYNTH_REQ))
        for key in ("years", "rate", "dividendYield", "priceField", "volBounds"):
            assert key in result["meta"]  # DO8:口径全量入 meta

    def test_akshare_path_with_mocks(self, monkeypatch):
        quotes = [
            {
                "code": "510050C2609M02900",
                "optionType": "C",
                "strike": 2.90,
                "last": 0.1391,
                "changePct": 5.3,
                "prevSettle": 0.1321,
                "snapshotAt": "2026-09-04T16:29:01+08:00",
            },
            {
                "code": "510050P2609M02900",
                "optionType": "P",
                "strike": 2.90,
                "last": 0.0132,
                "changePct": -2.1,
                "prevSettle": 0.0135,
                "snapshotAt": "2026-09-04T16:29:01+08:00",
            },
        ]
        monkeypatch.setattr(pricing.chain, "fetch_board", lambda board, month: quotes)
        monkeypatch.setattr(pricing, "fetch_spot_akshare", lambda u: 3.02)
        result = pricing.handle_parity_check(
            {"source": "akshare", "underlying": "510050", "expiryMonth": "2609", "rate": 0.02}
        )
        pair = result["pairs"][0]
        assert set(pair) >= {
            "strike",
            "call",
            "put",
            "callPutDiff",
            "forwardValue",
            "deviation",
            "deviationTicks",
            "flag",
        }
        assert pair["flag"] in ("ok", "violation")
