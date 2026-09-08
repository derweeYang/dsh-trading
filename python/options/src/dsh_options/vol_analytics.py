# 波动率分析:ATM 期限结构、25Δ skew、HV、离散蝶形、ATM IV 百分位、
# 当日微笑二次拟合、到期月 Raw SVI、可选 term/smile PNG。复用
# implied_vol 链快照;只读已收敛行。拟合残差与蝶形只打标,不平滑、
# 不丢 IV 行。ATM IV 百分位只走可回放路径(synth asOf);akshare 活牌
# 没有历史 IV,标 insufficient。图表要显式 vizDir;无目录则 charts=[]。

from __future__ import annotations

import math
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

from dsh_options import bsm, pricing, synth, underlying_daily
from dsh_options.bsm import bs_greeks
from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying
from dsh_options.svi import raw_svi_smile

DEFAULT_HV_WINDOWS = (20, 60, 120)
DEFAULT_IV_WINDOWS = (60, 252)
DELTA_TARGET_CALL = 0.25
DELTA_TARGET_PUT = -0.25
DELTA_MAX_DISTANCE = 0.15
BUTTERFLY_TICK_MULT = 2.0
AKSHARE_IV_PCT_REASON = "akshare has no historical IV path (live board only)"


def handle_vol_analytics(request: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """`vol_analytics` 子命令:多月 IV 截面汇总 + 标的已实现波动率。

    Parameters
    ----------
    request : dict
        ``{source, underlying, expiryMonths?, rate?, dividendYield?,
        priceField?, asOf?, spot?, hvWindows?, ivWindows?, vizDir?,
        chartKinds?, cacheDir}``。
    cache_dir : Path
        缓存根(akshare contracts / 现货;synth 也要求以免 CLI 分叉)。

    Returns
    -------
    dict[str, Any]
        ``{source, underlying, spot, snapshotAt, priceBasis, priceBasisNote,
        termStructure, skew, realizedVol, ivPercentile, smile, svi,
        butterflies, charts, failures, meta}``。
    """
    source = _require(request, "source")
    underlying = _require(request, "underlying")
    if source not in ("synth", "akshare", "iquant"):
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")
    if source == "synth" and underlying != synth.SYNTH_UNDERLYING:
        raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
    if source in ("akshare", "iquant") and find_underlying(source, underlying) is None:
        raise OptionsError("BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings")

    months = _resolve_months(request, source, underlying, cache_dir)
    hv_windows = _resolve_windows(request.get("hvWindows"))
    iv_windows = _resolve_windows(request.get("ivWindows"), DEFAULT_IV_WINDOWS)
    term: list[dict[str, Any]] = []
    skew_rows: list[dict[str, Any]] = []
    flies: list[dict[str, Any]] = []
    pct_rows: list[dict[str, Any]] = []
    smile_rows: list[dict[str, Any]] = []
    svi_rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    first_error: OptionsError | None = None
    header: dict[str, Any] | None = None

    for month in months:
        iv_req = _iv_request(request, month)
        try:
            iv = pricing.handle_implied_vol(iv_req)
        except OptionsError as err:
            if err.code == "BAD_REQUEST" and "already expired" in err.message:
                term.append(_expired_term(month, err.message))
                skew_rows.append({"expiryMonth": month, "status": "expired"})
                flies.append({"expiryMonth": month, "nChecked": 0, "violations": []})
                pct_rows.extend(_status_pct_rows(month, iv_windows, "expired"))
                smile_rows.append(_expired_smile(month))
                svi_rows.append(_expired_svi(month))
                continue
            if len(months) == 1:
                raise
            if first_error is None:
                first_error = err
            failures.append({"expiryMonth": month, "code": err.code, "message": err.message})
            continue
        if header is None:
            header = {
                "spot": iv["spot"],
                "snapshotAt": iv["snapshotAt"],
                "priceBasis": iv["priceBasis"],
                "priceBasisNote": iv["priceBasisNote"],
                "tickSize": iv["meta"].get("tickSize", 0.0001),
                "years": iv["meta"]["years"],
                "rate": iv["meta"]["rate"],
                "dividendYield": iv["meta"]["dividendYield"],
            }
        decorated = _with_deltas(iv)
        term.append(_term_row(month, iv, decorated))
        skew_rows.append({"expiryMonth": month, **skew_25d_from_rows(decorated)})
        calls = {
            row["strike"]: row["price"]
            for row in iv["results"]
            if row["optionType"] == "C" and row.get("price") is not None
        }
        tick = float(header["tickSize"])
        flies.append(
            {
                "expiryMonth": month,
                "nChecked": max(0, len(calls) - 2),
                "violations": butterfly_violations(calls, tick),
            }
        )
        pct_rows.extend(
            _iv_percentile_block(source, month, request, iv_windows, header)
        )
        smile_rows.append(_smile_row(month, iv, decorated, header))
        svi_rows.append(_svi_row(month, iv, decorated, header))

    if header is None:
        if first_error is not None and not term:
            raise first_error
        if not term:
            raise OptionsError("NO_DATA", f"no months available for {underlying}")
        header = {
            "spot": None,
            "snapshotAt": None,
            "priceBasis": request.get("priceField", "last"),
            "priceBasisNote": "",
            "tickSize": 0.0001,
            "years": None,
            "rate": request.get("rate"),
            "dividendYield": request.get("dividendYield", 0),
        }

    realized = _realized_block(source, underlying, cache_dir, request, hv_windows)
    charts = _charts_block(request, header, term, smile_rows)
    return {
        "source": source,
        "underlying": underlying,
        "spot": header["spot"],
        "snapshotAt": header["snapshotAt"],
        "priceBasis": header["priceBasis"],
        "priceBasisNote": header["priceBasisNote"],
        "termStructure": term,
        "skew": skew_rows,
        "realizedVol": realized,
        "ivPercentile": pct_rows,
        "smile": smile_rows,
        "svi": svi_rows,
        "butterflies": flies,
        "charts": charts,
        "failures": failures,
        "meta": {
            "model": "bsm-european",
            "hvWindows": list(hv_windows),
            "ivWindows": list(iv_windows),
            "deltaTarget": [DELTA_TARGET_PUT, DELTA_TARGET_CALL],
            "deltaMaxDistance": DELTA_MAX_DISTANCE,
            "butterflyTickMult": BUTTERFLY_TICK_MULT,
            "smileMethod": "quadratic",
            "sviMethod": "raw-svi",
            "rate": header["rate"],
            "dividendYield": header["dividendYield"],
        },
    }


def atm_from_rows(rows: list[dict[str, Any]], spot: float) -> dict[str, Any]:
    """已收敛行中距现货最近一档的 C/P IV 平均。"""
    live = [row for row in rows if row.get("converged") and row.get("iv") is not None]
    if not live:
        return {"status": "insufficient", "atmStrike": None, "atmIv": None}
    strike = min(live, key=lambda row: abs(row["strike"] - spot))["strike"]
    ivs = [float(row["iv"]) for row in live if math.isclose(row["strike"], strike, abs_tol=1e-9)]
    return {"status": "ok", "atmStrike": float(strike), "atmIv": float(sum(ivs) / len(ivs))}


def skew_25d_from_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """最近 25Δ call 与 −25Δ put 的 IV 差(put−call);过远记不足。"""
    calls = [row for row in rows if row.get("converged") and row.get("optionType") == "C"]
    puts = [row for row in rows if row.get("converged") and row.get("optionType") == "P"]
    empty = {
        "status": "insufficient",
        "call25Iv": None,
        "put25Iv": None,
        "skew": None,
        "call25Delta": None,
        "put25Delta": None,
        "call25Strike": None,
        "put25Strike": None,
    }
    if not calls or not puts:
        return empty
    call = min(calls, key=lambda row: abs(float(row["delta"]) - DELTA_TARGET_CALL))
    put = min(puts, key=lambda row: abs(float(row["delta"]) - DELTA_TARGET_PUT))
    if (
        abs(float(call["delta"]) - DELTA_TARGET_CALL) > DELTA_MAX_DISTANCE
        or abs(float(put["delta"]) - DELTA_TARGET_PUT) > DELTA_MAX_DISTANCE
    ):
        return empty
    return {
        "status": "ok",
        "call25Iv": float(call["iv"]),
        "put25Iv": float(put["iv"]),
        "skew": float(put["iv"]) - float(call["iv"]),
        "call25Delta": float(call["delta"]),
        "put25Delta": float(put["delta"]),
        "call25Strike": float(call["strike"]),
        "put25Strike": float(put["strike"]),
    }


def butterfly_violations(calls: dict[float, float], tick: float) -> list[dict[str, float]]:
    """不等间距加权蝶形:`w*C1 + (1-w)*C3 - C2`;残差低于 −2tick 记违规。"""
    strikes = sorted(calls)
    hits: list[dict[str, float]] = []
    floor = -BUTTERFLY_TICK_MULT * tick
    for idx in range(1, len(strikes) - 1):
        k1, k2, k3 = strikes[idx - 1], strikes[idx], strikes[idx + 1]
        span = k3 - k1
        if span <= 0:
            continue
        weight = (k3 - k2) / span
        residual = weight * calls[k1] + (1.0 - weight) * calls[k3] - calls[k2]
        if residual < floor:
            hits.append({"k1": k1, "k2": k2, "k3": k3, "residual": float(residual)})
    return hits


def mid_iv_by_strike(rows: list[dict[str, Any]]) -> dict[float, float]:
    """已收敛行按行权价把 C/P IV 平均成中点微笑。"""
    buckets: dict[float, list[float]] = {}
    for row in rows:
        if not row.get("converged") or row.get("iv") is None:
            continue
        buckets.setdefault(float(row["strike"]), []).append(float(row["iv"]))
    return {strike: float(sum(ivs) / len(ivs)) for strike, ivs in buckets.items()}


def quadratic_smile(mids: dict[float, float]) -> dict[str, Any]:
    """对 (K, mid-IV) 做二次最小二乘:`IV = a + bK + cK²`;少于 3 档不足。"""
    strikes = sorted(mids)
    empty = {
        "status": "insufficient",
        "method": "quadratic",
        "nKnots": len(strikes),
        "maxAbsResidual": None,
        "coeffs": None,
        "knots": [],
    }
    if len(strikes) < 3:
        return empty
    xs = np.asarray(strikes, dtype="float64")
    ys = np.asarray([mids[strike] for strike in strikes], dtype="float64")
    if not np.all(np.isfinite(ys)):
        return empty
    coef_hi_first = np.polyfit(xs, ys, 2)
    fitted = np.polyval(coef_hi_first, xs)
    resid = np.abs(fitted - ys)
    c2, c1, c0 = (float(coef_hi_first[0]), float(coef_hi_first[1]), float(coef_hi_first[2]))
    knots = [
        {"strike": float(strike), "iv": float(mids[strike]), "fittedIv": float(fit)}
        for strike, fit in zip(strikes, fitted, strict=True)
    ]
    return {
        "status": "ok",
        "method": "quadratic",
        "nKnots": len(strikes),
        "maxAbsResidual": float(resid.max()),
        "coeffs": [c0, c1, c2],
        "knots": knots,
    }


def iv_percentile(values: list[float], window: int) -> dict[str, Any]:
    """ATM IV 平均秩百分位:窗口末点相对窗口内样本的位置,单位 0–100。"""
    if window < 2 or len(values) < window:
        return {
            "window": window,
            "percentile": None,
            "currentIv": values[-1] if values else None,
            "sampleSize": 0,
            "status": "insufficient",
        }
    tail = values[-window:]
    current = float(tail[-1])
    below = sum(1 for item in tail if item < current)
    equal = sum(1 for item in tail if item == current)
    pct = 100.0 * (below + 0.5 * equal) / window
    return {
        "window": window,
        "percentile": float(pct),
        "currentIv": current,
        "sampleSize": window,
        "status": "ok",
    }


def realized_vol(closes: list[float], window: int) -> dict[str, Any]:
    """年化已实现波动率:窗口内对数收益样本标准差 × √252。"""
    if window < 2 or len(closes) < window + 1:
        return {"window": window, "hv": None, "sampleSize": 0, "status": "insufficient"}
    arr = np.asarray(closes, dtype="float64")
    if np.any(arr <= 0) or not np.all(np.isfinite(arr)):
        return {"window": window, "hv": None, "sampleSize": 0, "status": "insufficient"}
    logret = np.diff(np.log(arr))
    tail = logret[-window:]
    if len(tail) < window:
        return {"window": window, "hv": None, "sampleSize": int(len(tail)), "status": "insufficient"}
    hv = float(np.std(tail, ddof=1) * math.sqrt(252))
    return {"window": window, "hv": hv, "sampleSize": window, "status": "ok"}


def _with_deltas(iv: dict[str, Any]) -> list[dict[str, Any]]:
    spot = float(iv["spot"])
    years = float(iv["meta"]["years"])
    rate = float(iv["meta"]["rate"])
    div = float(iv["meta"]["dividendYield"])
    decorated = []
    for row in iv["results"]:
        item = dict(row)
        if row.get("converged") and row.get("iv"):
            greeks = bs_greeks(
                spot, row["strike"], years, rate, div, float(row["iv"]), row["optionType"] == "C"
            )
            item["delta"] = greeks["delta"]
        decorated.append(item)
    return decorated


def _term_row(month: str, iv: dict[str, Any], decorated: list[dict[str, Any]]) -> dict[str, Any]:
    atm = atm_from_rows(decorated, float(iv["spot"]))
    n_ok = iv["summary"]["converged"]
    status = atm["status"] if n_ok else "insufficient"
    return {
        "expiryMonth": month,
        "expiryDate": iv["expiryDate"],
        "years": iv["meta"]["years"],
        "atmStrike": atm["atmStrike"],
        "atmIv": atm["atmIv"],
        "nConverged": n_ok,
        "nFailed": iv["summary"]["failed"],
        "status": status,
    }


def _smile_row(
    month: str, iv: dict[str, Any], decorated: list[dict[str, Any]], header: dict[str, Any]
) -> dict[str, Any]:
    fit = quadratic_smile(mid_iv_by_strike(decorated))
    if fit["status"] != "ok":
        return {"expiryMonth": month, **fit, "atmIvFitted": None, "butterflyViolations": []}
    spot = float(iv["spot"])
    years = float(iv["meta"]["years"])
    rate = float(header["rate"] if header["rate"] is not None else 0.0)
    div = float(header["dividendYield"] if header["dividendYield"] is not None else 0.0)
    tick = float(header["tickSize"])
    c0, c1, c2 = fit["coeffs"]
    atm = float(c0 + c1 * spot + c2 * spot * spot)
    calls: dict[float, float] = {}
    for knot in fit["knots"]:
        price = bsm.bs_price(
            spot, knot["strike"], years, rate, div, float(knot["fittedIv"]), True
        )
        calls[knot["strike"]] = float(np.asarray(price).reshape(-1)[0])
    return {
        "expiryMonth": month,
        **fit,
        "atmIvFitted": atm,
        "butterflyViolations": butterfly_violations(calls, tick),
    }


def _expired_smile(month: str) -> dict[str, Any]:
    return {
        "expiryMonth": month,
        "status": "expired",
        "method": "quadratic",
        "nKnots": 0,
        "maxAbsResidual": None,
        "atmIvFitted": None,
        "coeffs": None,
        "knots": [],
        "butterflyViolations": [],
    }


def _svi_row(
    month: str, iv: dict[str, Any], decorated: list[dict[str, Any]], header: dict[str, Any]
) -> dict[str, Any]:
    years = float(iv["meta"]["years"])
    spot = float(iv["spot"])
    rate = float(header["rate"] if header["rate"] is not None else 0.0)
    div = float(header["dividendYield"] if header["dividendYield"] is not None else 0.0)
    tick = float(header["tickSize"])
    fit = raw_svi_smile(
        mid_iv_by_strike(decorated),
        spot=spot,
        years=years,
        rate=rate,
        dividend_yield=div,
    )
    if fit["status"] != "ok":
        return {"expiryMonth": month, **fit, "butterflyViolations": []}
    calls: dict[float, float] = {}
    for knot in fit["knots"]:
        price = bsm.bs_price(
            spot, knot["strike"], years, rate, div, float(knot["fittedIv"]), True
        )
        calls[knot["strike"]] = float(np.asarray(price).reshape(-1)[0])
    return {
        "expiryMonth": month,
        **fit,
        "butterflyViolations": butterfly_violations(calls, tick),
    }


def _expired_svi(month: str) -> dict[str, Any]:
    return {
        "expiryMonth": month,
        "status": "expired",
        "method": "raw-svi",
        "nKnots": 0,
        "maxAbsResidual": None,
        "rmse": None,
        "atmIvFitted": None,
        "forward": None,
        "params": None,
        "knots": [],
        "butterflyViolations": [],
        "arbViolations": [],
    }


def _expired_term(month: str, message: str) -> dict[str, Any]:
    return {
        "expiryMonth": month,
        "expiryDate": None,
        "years": None,
        "atmStrike": None,
        "atmIv": None,
        "nConverged": 0,
        "nFailed": 0,
        "status": "expired",
        "reason": message,
    }


def _iv_percentile_block(
    source: str,
    month: str,
    request: dict[str, Any],
    windows: tuple[int, ...],
    header: dict[str, Any],
) -> list[dict[str, Any]]:
    if source != "synth":
        reason = (
            AKSHARE_IV_PCT_REASON
            if source == "akshare"
            else "iquant has no historical IV path (fixed-seed / live board only)"
        )
        return _status_pct_rows(month, windows, "insufficient", reason)
    rate = float(header["rate"] if header["rate"] is not None else pricing.SYNTH_RATE)
    div = float(header["dividendYield"] if header["dividendYield"] is not None else 0.0)
    series, first, last = _atm_iv_history_synth(month, request.get("asOf"), rate, div)
    out = []
    for window in windows:
        row = iv_percentile(series, window)
        row["expiryMonth"] = month
        row["firstDate"] = first
        row["lastDate"] = last
        if row["status"] == "insufficient" and not series:
            row["reason"] = "no replayable ATM IV observations"
        out.append(row)
    return out


def _status_pct_rows(
    month: str, windows: tuple[int, ...], status: str, reason: str | None = None
) -> list[dict[str, Any]]:
    rows = []
    for window in windows:
        row: dict[str, Any] = {
            "expiryMonth": month,
            "window": window,
            "percentile": None,
            "currentIv": None,
            "sampleSize": 0,
            "firstDate": None,
            "lastDate": None,
            "status": status,
        }
        if reason is not None:
            row["reason"] = reason
        rows.append(row)
    return rows


def _atm_iv_history_synth(
    month: str, as_of: str | None, rate: float, div: float
) -> tuple[list[float], str | None, str | None]:
    chain = synth.make_chain_cached()
    spot = chain["spot"]
    if as_of:
        spot = spot[spot["date"] <= np.datetime64(as_of)]
    contracts = [item for item in chain["contracts"] if item["expiryMonth"] == month]
    if contracts == [] or spot.empty:
        return [], None, None
    expiry = date.fromisoformat(contracts[0]["expiryDate"])
    closes: dict[tuple[str, float], dict[str, float]] = {}
    strikes: list[float] = []
    for item in contracts:
        strike = float(item["strike"])
        if strike not in strikes:
            strikes.append(strike)
        by_day = closes.setdefault((item["optionType"], strike), {})
        for _, row in item["daily"].iterrows():
            by_day[_iso(row["date"])] = float(row["close"])
    ivs: list[float] = []
    days: list[str] = []
    for _, srow in spot.iterrows():
        day = _iso(srow["date"])
        as_of_day = date.fromisoformat(day)
        years = (expiry - as_of_day).days / 365.0
        if years <= 0.0:
            continue
        spot_px = float(srow["close"])
        strike = min(strikes, key=lambda level: abs(level - spot_px))
        day_ivs: list[float] = []
        for option_type, is_call in (("C", True), ("P", False)):
            price = closes.get((option_type, strike), {}).get(day)
            if price is None:
                continue
            iv, status = bsm.implied_vol(
                price, spot_px, strike, years, rate, div, is_call
            )
            if status == "ok" and iv is not None:
                day_ivs.append(iv)
        if day_ivs:
            ivs.append(float(sum(day_ivs) / len(day_ivs)))
            days.append(day)
    if not ivs:
        return [], None, None
    return ivs, days[0], days[-1]


def _realized_block(
    source: str,
    underlying: str,
    cache_dir: Path,
    request: dict[str, Any],
    windows: tuple[int, ...],
) -> list[dict[str, Any]]:
    closes, first, last = _spot_closes(source, underlying, cache_dir, request)
    out = []
    for window in windows:
        row = realized_vol(closes, window)
        row["firstDate"] = first
        row["lastDate"] = last
        out.append(row)
    return out


def _spot_closes(
    source: str, underlying: str, cache_dir: Path, request: dict[str, Any]
) -> tuple[list[float], str | None, str | None]:
    if source == "synth":
        spot = synth.make_chain_cached()["spot"]
        end = request.get("asOf")
        if end:
            spot = spot[spot["date"] <= np.datetime64(end)]
        closes = [float(v) for v in spot["close"].tolist()]
        if not closes:
            return [], None, None
        return closes, _iso(spot["date"].iloc[0]), _iso(spot["date"].iloc[-1])
    fetched = underlying_daily.handle_fetch_underlying_daily(
        {
            "source": source,
            "underlying": underlying,
            **({} if request.get("forceRefresh") is None else {"forceRefresh": request["forceRefresh"]}),
            **({} if request.get("iquantArgvPrefix") is None else {"iquantArgvPrefix": request["iquantArgvPrefix"]}),
        },
        cache_dir,
    )
    item = fetched["underlyings"][0]
    path = Path(item["cachePath"])
    frame = underlying_daily._read_parquet(path)
    closes = [float(v) for v in frame["close"].tolist()]
    return closes, item["firstDate"], item["lastDate"]


def _resolve_months(
    request: dict[str, Any], source: str, underlying: str, cache_dir: Path
) -> list[str]:
    explicit = request.get("expiryMonths")
    if explicit is not None:
        if not isinstance(explicit, list) or not all(isinstance(m, str) and m for m in explicit):
            raise OptionsError("BAD_REQUEST", "expiryMonths must be a list of YYMM strings")
        return list(explicit)
    if source == "synth":
        months = sorted({c["expiryMonth"] for c in synth.make_chain_cached()["contracts"]})
        return months
    from dsh_options import contracts

    snap = contracts.handle_contracts(
        {
            "source": source,
            "underlying": underlying,
            "cacheDir": str(cache_dir),
            **({} if request.get("iquantArgvPrefix") is None else {"iquantArgvPrefix": request["iquantArgvPrefix"]}),
        },
        cache_dir,
    )
    return sorted({c["expiryMonth"] for c in snap["contracts"]})


def _resolve_windows(
    raw: Any, default: tuple[int, ...] = DEFAULT_HV_WINDOWS
) -> tuple[int, ...]:
    if raw is None:
        return default
    if not isinstance(raw, list) or not raw or not all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and int(v) >= 2 for v in raw
    ):
        raise OptionsError("BAD_REQUEST", "hvWindows must be a list of integers >= 2")
    return tuple(int(v) for v in raw)


def _iv_request(request: dict[str, Any], month: str) -> dict[str, Any]:
    out = {
        "source": request["source"],
        "underlying": request["underlying"],
        "expiryMonth": month,
    }
    for key in ("rate", "dividendYield", "priceField", "asOf", "spot", "iquantArgvPrefix"):
        if request.get(key) is not None:
            out[key] = request[key]
    return out


def _charts_block(
    request: dict[str, Any],
    header: dict[str, Any],
    term: list[dict[str, Any]],
    smile_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """无 vizDir 且无 chartKinds 时不画图;只要种类不要目录则失败。"""
    viz_raw = request.get("vizDir")
    kinds_raw = request.get("chartKinds")
    if viz_raw is None and kinds_raw is None:
        return []
    if not isinstance(viz_raw, str) or not viz_raw:
        raise OptionsError(
            "BAD_REQUEST",
            "chartKinds requires vizDir" if kinds_raw is not None else "missing or invalid field: vizDir",
        )
    from dsh_options.vol_charts import resolve_chart_kinds, write_vol_charts

    return write_vol_charts(
        viz_dir=Path(viz_raw),
        underlying=str(request["underlying"]),
        stamp=_chart_stamp(header, request),
        term=term,
        smile=smile_rows,
        kinds=resolve_chart_kinds(kinds_raw),
    )


def _chart_stamp(header: dict[str, Any], request: dict[str, Any]) -> str:
    snap = header.get("snapshotAt")
    if isinstance(snap, str) and snap:
        return snap[:10]
    as_of = request.get("asOf")
    if isinstance(as_of, str) and as_of:
        return as_of[:10]
    return "live"


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value


def _iso(value: Any) -> str:
    return str(value)[:10]
