# O2 定价子命令:price(纯参数定价+Greeks)、implied_vol(链快照 IV 反解)、parity_check(平价检验)。
#
# 价格基准纪律(DO8):priceField 显式选择 last(最新价/收盘价)或 prevSettle(前结价),
# synth 的 prevSettle 是前一日 close(合成口径,meta 如实标注),akshare 的前结价才是
# 交易所结算价口径——两类来源在 meta.priceBasisNote 中区分,不冒充。
#
# 无解纪律(P3):IV 反解逐合约列行,失败分类显式(below-intrinsic/above-upper-bound/
# unconverged/no-data-on-asof),永不丢行。

import math
from datetime import date
from typing import Any

from dsh_options import bsm, chain, synth
from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying

# synth 生成参数(与 synth.make_chain 默认值一致);作为 synth 源的 rate 缺省,
# meta 注明这是生成参数而非市场事实。
SYNTH_RATE = 0.02


# ---------------------------------------------------------------------------
# price:BSM 欧式定价 + 全 Greeks(纯参数计算,不查数据源)
# ---------------------------------------------------------------------------


def handle_price(request: dict[str, Any]) -> dict[str, Any]:
    """`price` 子命令:单腿欧式 BSM 定价与全 Greeks。

    请求 ``{spot, strike, optionType: "C"|"P", vol,
    expiryDate+asOf 或 years(二选一), rate?, dividendYield?}``。

    Returns
    -------
    dict[str, Any]
        ``{price, delta, gamma, vega, vegaPerVolPoint, theta, thetaPerDay,
        rho, rhoPerBp, inputs, meta}``;meta 含 model/years/dividendYield/rate。
    """
    spot = _positive(request, "spot")
    strike = _positive(request, "strike")
    vol = _positive(request, "vol")
    option_type = _option_type(request)
    rate = _number(request, "rate", default=0.0)
    div_yield = _number(request, "dividendYield", default=0.0)
    years = _resolve_years(request)
    greeks = _pricing_call(spot, strike, years, rate, div_yield, vol, option_type)
    return {
        **greeks,
        "inputs": {
            "spot": spot,
            "strike": strike,
            "optionType": option_type,
            "vol": vol,
            "years": years,
            "rate": rate,
            "dividendYield": div_yield,
        },
        "meta": {
            "model": "bsm-european",
            "years": years,
            "rate": rate,
            "dividendYield": div_yield,
            "priceBasis": "as-specified",
        },
    }


def _pricing_call(spot, strike, years, rate, div_yield, vol, option_type):
    """bsm.bs_greeks 的 ValueError→BAD_REQUEST 收口。"""
    try:
        return bsm.bs_greeks(spot, strike, years, rate, div_yield, vol, option_type == "C")
    except ValueError as err:
        raise OptionsError("BAD_REQUEST", str(err)) from err


# ---------------------------------------------------------------------------
# implied_vol:链快照逐合约 Brent IV 反解
# ---------------------------------------------------------------------------


def handle_implied_vol(request: dict[str, Any]) -> dict[str, Any]:
    """`implied_vol` 子命令:同一链同一到期月的逐合约隐含波动率。

    请求 ``{source, underlying, expiryMonth, priceField?, rate?, dividendYield?,
    spot?, asOf?, volBounds?, maxIter?, tol?}``。

    Returns
    -------
    dict[str, Any]
        ``{snapshotAt, spot, expiryDate, priceBasis, priceBasisNote, results, summary, meta}``;
        results 逐合约含 ``{code, optionType, strike, price, iv, converged, method, reason}``。
    """
    snap = _resolve_snapshot(request)
    results = []
    for leg in (*snap["calls"], *snap["puts"]):
        price = leg["price"]
        entry: dict[str, Any] = {
            "code": leg["code"],
            "optionType": leg["optionType"],
            "strike": leg["strike"],
            "price": price,
            "iv": None,
            "converged": False,
            "method": None,
        }
        if price is None:
            entry["method"] = "no-data-on-asof"
            entry["reason"] = "no quote row on the requested asOf for this contract"
            results.append(entry)
            continue
        iv, status = bsm.implied_vol(
            price,
            snap["spot"],
            leg["strike"],
            snap["years"],
            snap["rate"],
            snap["dividendYield"],
            leg["optionType"] == "C",
            vol_lo=snap["volBounds"][0],
            vol_hi=snap["volBounds"][1],
            max_iter=snap["maxIter"],
            tol=snap["tol"],
        )
        entry["iv"] = iv
        entry["converged"] = status == "ok"
        entry["method"] = "brent" if status == "ok" else status
        if status != "ok":
            entry["reason"] = _failure_reason(status)
        results.append(entry)
    converged = sum(1 for r in results if r["converged"])
    return {
        "snapshotAt": snap["snapshotAt"],
        "spot": snap["spot"],
        "expiryDate": snap["expiryDate"],
        "priceBasis": snap["priceField"],
        "priceBasisNote": snap["priceBasisNote"],
        "results": results,
        "summary": {
            "n": len(results),
            "converged": converged,
            "failed": len(results) - converged,
        },
        "meta": snap["meta"],
    }


# ---------------------------------------------------------------------------
# parity_check:Call−Put 与远期价值偏离
# ---------------------------------------------------------------------------


def handle_parity_check(request: dict[str, Any]) -> dict[str, Any]:
    """`parity_check` 子命令:同链同期同行权价配对检验平价关系。

    ``deviation = (C − P) − (S·e^{−qT} − K·e^{−rT})``;阈值显式(P9),
    默认 ``max(2×tickSize, 0.0005)``,tickSize 从注册表读(DO4)。

    Returns
    -------
    dict[str, Any]
        ``{snapshotAt, spot, expiryDate, priceBasis, priceBasisNote, pairs, summary, meta}``。
    """
    snap = _resolve_snapshot(request)
    threshold = _threshold(request, snap["tickSize"])
    calls = {leg["strike"]: leg for leg in snap["calls"]}
    puts = {leg["strike"]: leg for leg in snap["puts"]}
    pairs = []
    for strike in sorted(set(calls) & set(puts)):
        c_leg, p_leg = calls[strike], puts[strike]
        if c_leg["price"] is None or p_leg["price"] is None:
            pairs.append(
                {
                    "strike": strike,
                    "call": c_leg["price"],
                    "put": p_leg["price"],
                    "callPutDiff": None,
                    "forwardValue": None,
                    "deviation": None,
                    "deviationTicks": None,
                    "flag": "no-data",
                }
            )
            continue
        t, r, q, s = snap["years"], snap["rate"], snap["dividendYield"], snap["spot"]
        forward = s * math.exp(-q * t) - strike * math.exp(-r * t)
        diff = c_leg["price"] - p_leg["price"]
        deviation = diff - forward
        pairs.append(
            {
                "strike": strike,
                "call": c_leg["price"],
                "put": p_leg["price"],
                "callPutDiff": diff,
                "forwardValue": forward,
                "deviation": deviation,
                "deviationTicks": deviation / snap["tickSize"],
                "flag": "violation" if abs(deviation) > threshold else "ok",
            }
        )
    violations = sum(1 for p in pairs if p["flag"] == "violation")
    max_abs = max((abs(p["deviation"]) for p in pairs if p["deviation"] is not None), default=0.0)
    return {
        "snapshotAt": snap["snapshotAt"],
        "spot": snap["spot"],
        "expiryDate": snap["expiryDate"],
        "priceBasis": snap["priceField"],
        "priceBasisNote": snap["priceBasisNote"],
        "pairs": pairs,
        "summary": {
            "n": len(pairs),
            "violations": violations,
            "maxAbsDeviation": max_abs,
            "threshold": threshold,
        },
        "meta": snap["meta"],
    }


# ---------------------------------------------------------------------------
# 链快照解析:implied_vol / parity_check 共用的取价与参数归集
# ---------------------------------------------------------------------------


def _resolve_snapshot(request: dict[str, Any]) -> dict[str, Any]:
    """按 source 解析链快照与定价参数,两子命令共用。

    Returns
    -------
    dict[str, Any]
        ``{calls, puts(含 price 列), spot, snapshotAt, expiryDate, years,
        rate, dividendYield, priceField, priceBasisNote, tickSize,
        volBounds, maxIter, tol, meta}``。
    """
    source = _require(request, "source")
    underlying = _require(request, "underlying")
    month = _require(request, "expiryMonth")
    price_field = request.get("priceField", "last")
    if price_field not in ("last", "prevSettle"):
        raise OptionsError(
            "BAD_REQUEST", f"priceField must be 'last' or 'prevSettle', got {price_field!r}"
        )
    as_of = request.get("asOf")
    if source == "synth":
        snap = _snapshot_synth(underlying, month, price_field, as_of)
        rate = _number(request, "rate", default=SYNTH_RATE)
        spot_default = snap["spot"]
        basis_note = (
            "synth prevSettle = prior synthetic close (NOT an exchange settlement price)"
            if price_field == "prevSettle"
            else "synth last = synthetic close on asOf"
        )
    elif source == "akshare":
        if as_of is not None:
            raise OptionsError(
                "BAD_REQUEST",
                "asOf is only supported for source=synth; akshare board is a live snapshot",
            )
        snap = _snapshot_akshare(underlying, month, price_field)
        rate = request.get("rate")
        if not isinstance(rate, (int, float)) or isinstance(rate, bool):
            raise OptionsError(
                "BAD_REQUEST",
                "rate is required for source=akshare (pick an explicit funding rate, e.g. 0.02)",
            )
        rate = float(rate)
        spot_default = snap["spot"]
        basis_note = (
            "akshare prevSettle = exchange settlement price of the prior session"
            if price_field == "prevSettle"
            else "akshare last = board latest quote"
        )
    elif source == "iquant":
        if as_of is not None:
            raise OptionsError(
                "BAD_REQUEST",
                "asOf is only supported for source=synth; iquant board is a live snapshot",
            )
        snap = _snapshot_iquant(underlying, month, price_field, request)
        rate = request.get("rate")
        if not isinstance(rate, (int, float)) or isinstance(rate, bool):
            raise OptionsError(
                "BAD_REQUEST",
                "rate is required for source=iquant (pick an explicit funding rate, e.g. 0.02)",
            )
        rate = float(rate)
        spot_default = snap["spot"]
        basis_note = (
            "iquant prevSettle = L1 preClose (NOT an exchange settlement price)"
            if price_field == "prevSettle"
            else "iquant last = L1 last"
        )
    else:
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")

    spot = float(request.get("spot", spot_default))
    if not math.isfinite(spot) or spot <= 0:
        raise OptionsError("BAD_REQUEST", f"spot must be a positive number, got {spot!r}")
    div_yield = _number(request, "dividendYield", default=0.0)
    vol_bounds = request.get("volBounds", [bsm.DEFAULT_VOL_LO, bsm.DEFAULT_VOL_HI])
    if (
        not isinstance(vol_bounds, list)
        or len(vol_bounds) != 2
        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vol_bounds)
        or vol_bounds[0] <= 0
        or vol_bounds[1] <= vol_bounds[0]
    ):
        raise OptionsError(
            "BAD_REQUEST", f"volBounds must be [lo, hi] with 0 < lo < hi, got {vol_bounds!r}"
        )
    vol_bounds = [float(vol_bounds[0]), float(vol_bounds[1])]
    max_iter = int(request.get("maxIter", bsm.DEFAULT_MAX_ITER))
    tol = float(request.get("tol", bsm.DEFAULT_TOL))
    years = _years_between(snap["asOfDate"], snap["expiryDate"])
    return {
        "calls": snap["calls"],
        "puts": snap["puts"],
        "spot": spot,
        "snapshotAt": snap["snapshotAt"],
        "expiryDate": snap["expiryDate"],
        "asOfDate": snap["asOfDate"],
        "years": years,
        "rate": rate,
        "dividendYield": div_yield,
        "priceField": price_field,
        "priceBasisNote": basis_note,
        "tickSize": snap["tickSize"],
        "volBounds": vol_bounds,
        "maxIter": max_iter,
        "tol": tol,
        "meta": {
            "model": "bsm-european",
            "years": years,
            "rate": rate,
            "dividendYield": div_yield,
            "priceField": price_field,
            "volBounds": vol_bounds,
            "maxIter": max_iter,
            "tol": tol,
            **(
                {"rateNote": "synth generation rate (synthetic, not a market fact)"}
                if source == "synth"
                else {}
            ),
        },
    }


def _snapshot_synth(
    underlying: str, month: str, price_field: str, as_of: str | None
) -> dict[str, Any]:
    """synth 链截面:asOf 缺省取窗口末日;asOf 须命中合成交易日(否则 NO_DATA)。"""
    if underlying != synth.SYNTH_UNDERLYING:
        raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
    chain_data = synth.make_chain_cached()  # 只读共享缓存;本函数不改链对象
    matched = [c for c in chain_data["contracts"] if c["expiryMonth"] == month]
    if not matched:
        raise OptionsError("NO_DATA", f"synth chain has no month {month!r}")
    dates = chain_data["spot"]["date"]
    if as_of is None:
        idx = len(dates) - 1
    else:
        target = _parse_date(as_of, "asOf")
        hit = dates[dates.dt.date == target]
        if hit.empty:
            raise OptionsError("NO_DATA", f"asOf {as_of!r} is not a synthetic trading day")
        idx = dates.index.get_loc(hit.index[-1])
    as_of_date = dates.iloc[idx].date()
    calls, puts = [], []
    for c in matched:
        daily = c["daily"]
        row = daily[daily["date"].dt.date == as_of_date]
        # 摘牌合约在 asOf 晚于其末行时无价:列行标记 no-data-on-asof,不丢行
        price = None
        if not row.empty:
            close = float(row["close"].iloc[0])
            price = close if price_field == "last" else _synth_prev_close(c, as_of_date)
        leg = {
            "code": c["code"],
            "optionType": c["optionType"],
            "strike": c["strike"],
            "price": price,
        }
        (calls if c["optionType"] == "C" else puts).append(leg)
    spot = float(chain_data["spot"]["close"].iloc[idx])
    snapshot_at = f"{as_of_date.isoformat()}T15:00:00+08:00"
    return {
        "calls": calls,
        "puts": puts,
        "spot": spot,
        "snapshotAt": snapshot_at,
        "expiryDate": matched[0]["expiryDate"],
        "asOfDate": as_of_date.isoformat(),
        "tickSize": 0.0001,
    }


def _synth_prev_close(contract: dict[str, Any], as_of_date: date) -> float | None:
    """synth prevSettle 口径:asOf 前一交易日的 close;无前行(首日)则 None。"""
    daily = contract["daily"]
    prior = daily[daily["date"].dt.date < as_of_date]
    if prior.empty:
        return None
    return float(prior["close"].iloc[-1])


def _snapshot_akshare(underlying: str, month: str, price_field: str) -> dict[str, Any]:
    """akshare 链截面:board 行情 + ETF 现价;深交所品种显式 NO_DATA(O1 缺口)。"""
    row = find_underlying("akshare", underlying)
    if row is None:
        raise OptionsError("BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings")
    if row["quotesSource"] != "sse_board":
        raise OptionsError(
            "NO_DATA",
            f"{underlying} is {row['quotesSource']}: quotes not available in akshare, parity/IV cannot run",
        )
    records = chain.fetch_board(row["boardName"], month)
    key = "last" if price_field == "last" else "prevSettle"
    calls, puts = [], []
    for r in records:
        leg = {
            "code": r["code"],
            "optionType": r["optionType"],
            "strike": r["strike"],
            "price": r[key],
        }
        (calls if r["optionType"] == "C" else puts).append(leg)
    return {
        "calls": calls,
        "puts": puts,
        "spot": fetch_spot_akshare(underlying),
        "snapshotAt": records[0]["snapshotAt"],
        "expiryDate": synth.expiry_date_of(month).isoformat(),
        "asOfDate": records[0]["snapshotAt"][:10],
        "tickSize": row["tickSize"],
    }


def _snapshot_iquant(
    underlying: str, month: str, price_field: str, request: dict[str, Any]
) -> dict[str, Any]:
    """iquant 链截面:option_chain + 标的 snapshot;prevSettle 来自 L1 昨收。

    默认带 ``atmFocus`` 收窄到 ATM 附近 3 档(2026-09-11 overview 首屏慢诊断:
    整链逐合约日 K 回落是 8s+ 的来源);请求显式 ``"atmFocus": false`` 可回全链。
    """
    from dsh_options import iquant
    from dsh_options.registry import find_underlying

    row = find_underlying("iquant", underlying)
    if row is None:
        raise OptionsError("BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings")
    spot = iquant.fetch_spot(underlying, request)
    chain_request: dict[str, Any] = {
        **{key: request[key] for key in ("iquantArgvPrefix",) if key in request},
        "source": "iquant",
        "underlying": underlying,
        "expiryMonth": month,
    }
    if request.get("atmFocus") is not False:
        chain_request["atmFocus"] = {"spot": spot, "strikes": 3}
    board = chain.handle_chain(chain_request)
    key = "last" if price_field == "last" else "prevSettle"
    calls, puts = [], []
    for side, bucket in (("C", board["calls"]), ("P", board["puts"])):
        dest = calls if side == "C" else puts
        for item in bucket:
            dest.append(
                {
                    "code": item["code"],
                    "optionType": side,
                    "strike": item["strike"],
                    "price": item[key],
                }
            )
    return {
        "calls": calls,
        "puts": puts,
        "spot": spot,
        "snapshotAt": board["snapshotAt"],
        "expiryDate": board["expiryDate"],
        "asOfDate": board["snapshotAt"][:10],
        "tickSize": row["tickSize"],
    }


def fetch_spot_akshare(underlying: str) -> float:
    """ETF 实时现价(东财 fund_etf_spot_em 按代码过滤);失败收口 NETWORK。

    board 接口不含标的价(O1 实测),IV/parity 需要它;调用方可用请求显式
    ``spot`` 覆盖本函数(离线复算/交叉验证场景)。
    """
    import akshare as ak

    try:
        raw = ak.fund_etf_spot_em()
    except Exception as err:
        raise OptionsError("NETWORK", f"ETF spot fetch failed: {err}") from err
    if raw is None or raw.empty:
        raise OptionsError("NETWORK", "ETF spot table came back empty")
    hit = raw[raw["代码"] == underlying]
    if hit.empty:
        raise OptionsError("NO_DATA", f"underlying {underlying!r} not found in the ETF spot table")
    return float(hit["最新价"].iloc[0])


# ---------------------------------------------------------------------------
# 请求字段工具
# ---------------------------------------------------------------------------


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value


def _positive(request: dict[str, Any], key: str) -> float:
    value = request.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise OptionsError("BAD_REQUEST", f"field {key} must be a positive number, got {value!r}")
    return float(value)


def _number(request: dict[str, Any], key: str, default: float) -> float:
    value = request.get(key, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise OptionsError("BAD_REQUEST", f"field {key} must be a number, got {value!r}")
    return float(value)


def _option_type(request: dict[str, Any]) -> str:
    value = request.get("optionType")
    if value not in ("C", "P"):
        raise OptionsError("BAD_REQUEST", f"optionType must be 'C' or 'P', got {value!r}")
    return value


def _parse_date(raw: str, field: str) -> date:
    try:
        return date.fromisoformat(raw)
    except (TypeError, ValueError) as err:
        raise OptionsError("BAD_REQUEST", f"field {field} must be YYYY-MM-DD, got {raw!r}") from err


def _resolve_years(request: dict[str, Any]) -> float:
    """时间参数归集:years 或 expiryDate+asOf 二选一;已到期按 BAD_REQUEST。"""
    years = request.get("years")
    expiry = request.get("expiryDate")
    as_of = request.get("asOf")
    if isinstance(years, (int, float)) and not isinstance(years, bool):
        if years <= 0:
            raise OptionsError("BAD_REQUEST", f"years must be positive, got {years!r}")
        return float(years)
    if isinstance(expiry, str) and isinstance(as_of, str):
        return _years_between(_parse_date(as_of, "asOf"), _parse_date(expiry, "expiryDate"))
    raise OptionsError(
        "BAD_REQUEST",
        "provide either years, or expiryDate+asOf (both YYYY-MM-DD), to define time to expiry",
    )


def _years_between(as_of, expiry) -> float:
    """两个日期(ISO 字符串或 date)的自然年差;到期早于 asOf 按 BAD_REQUEST。"""
    if isinstance(as_of, str):
        as_of = _parse_date(as_of, "asOf")
    if isinstance(expiry, str):
        expiry = _parse_date(expiry, "expiryDate")
    days = (expiry - as_of).days
    if days < 0:
        raise OptionsError(
            "BAD_REQUEST", f"expiry {expiry} is before asOf {as_of}: contract already expired"
        )
    return days / 365.0


def _threshold(request: dict[str, Any], tick_size: float) -> float:
    """parity 阈值(P9):显式可配;缺省 max(2×tick, 0.0005),口径声明在 summary。"""
    value = request.get("threshold")
    if value is None:
        return max(2.0 * tick_size, 0.0005)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise OptionsError("BAD_REQUEST", f"threshold must be a positive number, got {value!r}")
    return float(value)


def _failure_reason(status: str) -> str:
    return {
        "below-intrinsic": "price is below the discounted intrinsic value (P(vol_lo)); "
        "typical for deep ITM/OTM legs or stale/wrong quotes",
        "above-upper-bound": "price exceeds the theoretical price at vol_hi; raise volBounds if genuinely this high",
        "unconverged": "Brent iteration budget exhausted before tol; inspect inputs",
        "no-data-on-asof": "no quote row on the requested asOf for this contract",
    }.get(status, status)
