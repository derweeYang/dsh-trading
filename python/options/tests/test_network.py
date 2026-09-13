# 真网冒烟:上交所链路端到端。默认 skip,DSH_OPTIONS_NETWORK_TESTS=1 时启用。
#
# 断言只锚定结构性与行数下限,不锚定行情数值(价格/量随时间变化)。


import time
from datetime import date

import pytest

from dsh_options import bsm, chain, contracts, daily, pricing, synth, underlying_daily


def _near_month_50etf(tmp_path):
    """50ETF 最近到期月(contracts 快照动态解析,不硬编码)。"""
    snap = contracts.handle_contracts(
        {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)}, tmp_path
    )
    return min(c["expiryMonth"] for c in snap["contracts"])


@pytest.mark.network
def test_network_underlyings_akshare():
    result = contracts.handle_underlyings({"source": "akshare"})
    assert result["rows"] >= 7
    assert {u["underlying"] for u in result["underlyings"]} >= {"510050", "159915"}


@pytest.mark.network
def test_network_contracts_and_chain_50etf(tmp_path):
    """近月动态解析(不硬编码月份):contracts 快照 → 最近月 → chain T 型报价。"""
    snap = contracts.handle_contracts(
        {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)}, tmp_path
    )
    assert snap["rows"] >= 8  # 单季月至少 8 档 × C/P × 至少 1 个月
    month = min(c["expiryMonth"] for c in snap["contracts"])
    board = chain.handle_chain({"source": "akshare", "underlying": "510050", "expiryMonth": month})
    assert board["expiryMonth"] == month
    assert board["snapshotAt"].endswith("+08:00")
    assert len(board["calls"]) >= 8 and len(board["puts"]) >= 8
    strikes = [q["strike"] for q in board["calls"]]
    assert strikes == sorted(strikes)
    assert all(q["last"] > 0 for q in board["calls"] + board["puts"])


@pytest.mark.network
def test_network_fetch_daily_real_contract(tmp_path):
    """全历史日线:真实合约(从 contracts 快照取)→ 新浪映射 → OHLCV,缓存二次命中。"""
    snap = contracts.handle_contracts(
        {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)}, tmp_path
    )
    contract = snap["contracts"][0]["code"]
    request = {"contract": contract, "source": "akshare", "cacheDir": str(tmp_path)}
    result = daily.handle_fetch_daily(request, tmp_path)
    assert result["cached"] is False
    assert result["rows"] >= 20  # 上市至少数月的活跃合约
    assert result["firstDate"] < result["lastDate"]
    assert result["preview"]
    # 二次调用命中本地 parquet(不再触网)
    again = daily.handle_fetch_daily(request, tmp_path)
    assert again["cached"] is True and again["rows"] == result["rows"]


@pytest.mark.network
def test_network_underlying_daily_sse_and_szse(tmp_path):
    """标的现货日线沪深都通:510050 与 159922,二次命中缓存。"""
    request = {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)}
    result = underlying_daily.handle_fetch_underlying_daily(request, tmp_path)
    item = result["underlyings"][0]
    assert item["cached"] is False and item["rows"] >= 20
    assert item["firstDate"] < item["lastDate"]
    again = underlying_daily.handle_fetch_underlying_daily(request, tmp_path)
    assert again["underlyings"][0]["cached"] is True
    szse = underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "159922", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    assert szse["underlyings"][0]["exchange"] == "SZSE"
    assert szse["underlyings"][0]["rows"] >= 20


@pytest.mark.network
def test_network_spot_helper_50etf():
    """ETF 现价 helper(board 不含标的价,O2 的 IV/parity 依赖它)。"""
    spot = pricing.fetch_spot_akshare("510050")
    assert 0.5 < spot < 20.0  # 宽松合理性:近十年 50ETF 价格带


@pytest.mark.network
def test_network_akshare_implied_vol_and_parity(tmp_path):
    """真实 50ETF 近月:IV 反解与 parity 报告全链路(结构断言,数值宽松)。"""
    month = _near_month_50etf(tmp_path)
    request = {"source": "akshare", "underlying": "510050", "expiryMonth": month, "rate": 0.02}
    iv = pricing.handle_implied_vol(dict(request))
    assert iv["summary"]["n"] >= 16  # 单季月 ≥8 档 × C/P
    assert iv["summary"]["converged"] >= 8  # 主力行权价带应收敛;深度档无解显式列行
    assert all(0.0 < r["iv"] < 3.0 for r in iv["results"] if r["converged"])
    assert iv["priceBasis"] == "last" and iv["spot"] > 0
    parity = pricing.handle_parity_check(dict(request))
    assert parity["summary"]["n"] >= 8
    assert 0 <= parity["summary"]["violations"] <= parity["summary"]["n"]
    assert parity["summary"]["threshold"] > 0


@pytest.mark.network
def test_network_cross_validate_sina_greeks(tmp_path):
    """DO3 交叉验证:自算 delta/IV vs 新浪 greeks。

    断言分层(2026-09-05 首跑诊断后定):
    - **IV 硬断言**(近值档 |Δ|<0.06):验证反解算法与市场供应商一致;
    - **delta 同侧断言**((self−0.5) 与 (sina−0.5) 同号):验证 moneyness
      判断一致;数值差只报告——东财 spot 与新浪快照错配 ±0.5%,在 delta 上
      传导即 ±0.1(新浪隐含 spot ≈3.02 vs 东财 3.037),数值对齐无意义;
    - **深度实值 below-intrinsic 报告**(delta≈1 对 spot 错配最敏感)——
      真实数据上「无解显式列出」形态的直接证据。
    依据 spec:「差异超限输出 diff 报告而非失败」——新浪口径黑盒
    (价格基准/利率/spot 时点不明),超限是证据不是缺陷。
    """
    import akshare as ak

    month = _near_month_50etf(tmp_path)
    spot = pricing.fetch_spot_akshare("510050")
    # 豁免挂在 date.today() 所在行:自然日口径,时点近似见 docstring
    days_to_expiry = max((synth.expiry_date_of(month) - date.today()).days, 1)  # noqa: DTZ011
    years = days_to_expiry / 365.0

    codes = ak.option_sse_codes_sina(symbol="看涨期权", trade_date=month, underlying="510050")
    sina_rows = {}
    for i, sina_code in enumerate(codes["期权代码"]):
        if i:
            time.sleep(1.5)  # 新浪节流(O1 实测安全间隔)
        greeks = ak.option_sse_greeks_sina(symbol=str(sina_code))
        rec = {r["字段"]: r["值"] for _, r in greeks.iterrows()}
        sina_rows[rec["交易代码"]] = rec
    assert len(sina_rows) >= 10

    print(f"\ncross-validate 50ETF calls, month={month}, spot={spot:.4f}, years={years:.4f}")
    print(
        f"{'code':<20} {'self iv':>8} {'sina iv':>8} {'dIV':>8} {'self dlt':>9} {'sina dlt':>8} {'dDlt':>7} band"
    )
    checked = 0
    same_side = 0
    for code, rec in sorted(sina_rows.items()):
        parsed = synth.parse_long_code(code)
        price = float(rec["最新价"])
        iv, status = bsm.implied_vol(price, spot, parsed["strike"], years, 0.02, 0.0, True)
        if status != "ok":
            print(f"{code:<20} no-solution ({status}): sina price={price:.4f}")
            continue
        delta = bsm.bs_greeks(spot, parsed["strike"], years, 0.02, 0.0, iv, True)["delta"]
        sina_iv, sina_delta = float(rec["隐含波动率"]), float(rec["Delta"])
        d_iv, d_delta = iv - sina_iv, delta - sina_delta
        band = "NEAR" if 0.15 < delta < 0.85 else "DEEP"
        print(
            f"{code:<20} {iv:8.4f} {sina_iv:8.4f} {d_iv:+8.4f} "
            f"{delta:9.4f} {sina_delta:8.4f} {d_delta:+7.4f} {band}"
        )
        if band == "NEAR":
            checked += 1
            assert abs(d_iv) < 0.06, f"{code}: IV diff {d_iv:+.4f} exceeds tolerance vs sina"
        if (delta - 0.5) * (sina_delta - 0.5) > 0:
            same_side += 1
        elif abs(delta - 0.5) < 0.05:
            same_side += 1  # 中心档自身贴近 0.5,同侧判断无意义,不计异侧
    # 0.05 间隔的月度链上 NEAR 档(0.15<delta<0.85)天然只 2-3 档
    assert checked >= 2, f"only {checked} near-the-money contracts cross-validated"
    assert same_side >= len(sina_rows) - 6, (
        "delta moneyness disagrees with sina on >6 contracts; implementation suspect"
    )
