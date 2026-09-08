"""期权策略模板、到期损益与 Greeks 汇总辅助函数。"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from . import chain, margin, pricing, strategy_charts, synth
from .bsm import bs_greeks
from .protocol import OptionsError
from .registry import find_underlying

TEMPLATES = ("covered_call", "collar", "vertical", "straddle", "butterfly")
STRATEGY_CHART_KINDS = ("payoff", "greeks")
GREEK_KEYS = (
    "delta",
    "gamma",
    "vega",
    "vegaPerVolPoint",
    "theta",
    "thetaPerDay",
    "rho",
    "rhoPerBp",
)
MARGIN_NOTE = "标准义务仓逐腿加总；未含组合策略保证金与强平；券商可在交易所标准上上浮。"
DISCLAIMER = "未含组合策略保证金与强平路径"
ENTRY_NOTE = (
    "buy negative, sell positive; already × qty × multiplier "
    "(underlying qty is shares)"
)


def _required(params: dict[str, Any], name: str, fields: tuple[str, ...]) -> None:
    missing = [field for field in fields if field not in params]
    if missing:
        joined = ", ".join(missing)
        raise OptionsError("BAD_REQUEST", f"{name} requires: {joined}")


def _option(
    *,
    side: str,
    qty: int,
    option_type: str,
    strike: float,
    expiry_month: str,
) -> dict[str, Any]:
    return {
        "kind": "option",
        "side": side,
        "qty": qty,
        "optionType": option_type,
        "strike": strike,
        "expiryMonth": expiry_month,
        "fromTemplate": True,
    }


def expand_template(name: str, params: dict[str, Any], multiplier: int) -> list[dict[str, Any]]:
    """Expand a named strategy template into underlying and option legs."""
    if name not in TEMPLATES:
        raise OptionsError("BAD_REQUEST", f"unknown strategy template: {name!r}")

    qty = _positive_int(params.get("qty", 1), "qty")
    if name == "covered_call":
        _required(params, name, ("expiryMonth", "strike"))
        return [
            {
                "kind": "underlying",
                "side": "buy",
                "qty": qty * multiplier,
                "fromTemplate": True,
            },
            _option(
                side="sell",
                qty=qty,
                option_type="C",
                strike=params["strike"],
                expiry_month=params["expiryMonth"],
            ),
        ]

    if name == "collar":
        _required(params, name, ("expiryMonth", "callStrike", "putStrike"))
        return [
            {
                "kind": "underlying",
                "side": "buy",
                "qty": qty * multiplier,
                "fromTemplate": True,
            },
            _option(
                side="sell",
                qty=qty,
                option_type="C",
                strike=params["callStrike"],
                expiry_month=params["expiryMonth"],
            ),
            _option(
                side="buy",
                qty=qty,
                option_type="P",
                strike=params["putStrike"],
                expiry_month=params["expiryMonth"],
            ),
        ]

    if name == "vertical":
        _required(
            params,
            name,
            ("expiryMonth", "optionType", "longStrike", "shortStrike"),
        )
        return [
            _option(
                side="buy",
                qty=qty,
                option_type=params["optionType"],
                strike=params["longStrike"],
                expiry_month=params["expiryMonth"],
            ),
            _option(
                side="sell",
                qty=qty,
                option_type=params["optionType"],
                strike=params["shortStrike"],
                expiry_month=params["expiryMonth"],
            ),
        ]

    if name == "straddle":
        _required(params, name, ("expiryMonth", "strike"))
        side = params.get("side", "buy")
        return [
            _option(
                side=side,
                qty=qty,
                option_type=option_type,
                strike=params["strike"],
                expiry_month=params["expiryMonth"],
            )
            for option_type in ("C", "P")
        ]

    _required(
        params,
        name,
        ("expiryMonth", "optionType", "lowStrike", "midStrike", "highStrike"),
    )
    low = params["lowStrike"]
    mid = params["midStrike"]
    high = params["highStrike"]
    if not math.isclose(mid - low, high - mid):
        raise OptionsError("BAD_REQUEST", "butterfly strikes must have equal spacing")
    return [
        _option(
            side="buy",
            qty=qty,
            option_type=params["optionType"],
            strike=low,
            expiry_month=params["expiryMonth"],
        ),
        _option(
            side="sell",
            qty=2 * qty,
            option_type=params["optionType"],
            strike=mid,
            expiry_month=params["expiryMonth"],
        ),
        _option(
            side="buy",
            qty=qty,
            option_type=params["optionType"],
            strike=high,
            expiry_month=params["expiryMonth"],
        ),
    ]


def leg_expiry_pnl(
    *,
    kind: str,
    side: str,
    qty: int,
    multiplier: int,
    strike: float | None,
    option_type: str | None,
    premium: float,
    spot0: float,
    spot_t: float,
) -> float:
    """Return one leg's signed cash profit or loss at expiry."""
    sign = 1 if side == "buy" else -1
    if kind == "underlying":
        return sign * (spot_t - spot0) * qty
    if option_type == "C":
        intrinsic = max(spot_t - float(strike), 0.0)
    else:
        intrinsic = max(float(strike) - spot_t, 0.0)
    return sign * (intrinsic - premium) * qty * multiplier


def build_payoff(
    legs: list[dict[str, Any]], spot: float, tick: float
) -> list[dict[str, float]]:
    """Build an expiry payoff grid containing spot and every option strike."""
    strikes = [
        float(leg["strike"])
        for leg in legs
        if leg.get("kind") == "option" and leg.get("strike") is not None
    ]
    lo = min(0.70 * spot, 0.90 * min(strikes)) if strikes else 0.70 * spot
    hi = max(1.30 * spot, 1.10 * max(strikes)) if strikes else 1.30 * spot
    step = max(tick, 0.01)
    lo = math.floor(lo / step + 1e-12) * step
    count = math.floor((hi - lo) / step)
    points = {lo + index * step for index in range(count + 1)}
    points.update((lo, hi, spot, *strikes))

    rows = []
    for spot_t in sorted(points):
        pnl = sum(
            leg_expiry_pnl(
                kind=leg["kind"],
                side=leg["side"],
                qty=leg["qty"],
                multiplier=leg.get("multiplier", 1),
                strike=leg.get("strike"),
                option_type=leg.get("optionType"),
                premium=leg.get("premium", 0.0),
                spot0=leg.get("spot0", spot),
                spot_t=spot_t,
            )
            for leg in legs
        )
        rows.append({"spot": spot_t, "pnl": pnl})
    return rows


def signed_greeks(
    greeks: dict[str, float], *, side: str, qty: int, multiplier: int
) -> dict[str, float]:
    """Apply leg direction, quantity, and contract multiplier to Greeks."""
    scale = (1 if side == "buy" else -1) * qty * multiplier
    return {key: value * scale for key, value in greeks.items()}


def handle_strategy(request: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """`strategy` 子命令:模板/腿展开、到期损益、净 Greeks、标准义务仓保证金。

    Parameters
    ----------
    request : dict
        ``{source, underlying, legs?, template?, templateParams?,
        priceField?, asOf?, rate?, dividendYield?, spot?,
        premiumOverrides?, cacheDir, vizDir?, chartKinds?}``。
    cache_dir : Path
        缓存根(CLI 必填;本命令不读盘,链/IV 走既有快照路径)。

    Returns
    -------
    dict[str, Any]
        ``{source, underlying, spot, multiplier, snapshotAt, priceBasis,
        priceBasisNote, legs, entry, payoff, greeks, margin, charts,
        failures, meta}``。``vizDir`` 非空时按 ``chartKinds`` 写策略图。
    """
    source, underlying, reg = _validate_identity(request)
    _validate_akshare_asof(source, request)
    _validate_chart_kinds(request)
    multiplier = int(reg["multiplier"])
    tick = float(reg["tickSize"])
    raw_legs = _collect_legs(request, multiplier)
    if not raw_legs:
        raise OptionsError("BAD_REQUEST", "provide legs and/or template")
    for leg in raw_legs:
        _normalize_leg(leg, underlying=underlying, multiplier=multiplier)
    overrides = _premium_overrides(request, len(raw_legs))

    month_state, failures, first_error = _resolve_months(request, raw_legs)
    option_months = {leg["expiryMonth"] for leg in raw_legs if leg["kind"] == "option"}
    ok_months = [month for month, state in month_state.items() if state["status"] == "ok"]
    expired_months = {month for month, state in month_state.items() if state["status"] == "expired"}
    if option_months and not ok_months and not expired_months and first_error is not None:
        raise first_error

    spot = _resolve_spot(request, month_state, ok_months)
    header = _header_from_iv(request, source, month_state, ok_months)
    settle_quotes, settle_error = _load_settles(
        request, month_state, cache_dir, raw_legs
    )
    resolved = _resolve_option_legs(
        raw_legs,
        month_state,
        overrides,
        settle_quotes,
    )
    cover = _cover_plan(resolved, multiplier)
    for index, leg in enumerate(resolved):
        if index in cover and cover[index][1] == 0:
            leg["covered"] = True

    entry_cash = _entry_cash(resolved, spot, multiplier)
    payoff_legs = [
        {
            **leg,
            "multiplier": multiplier,
            "spot0": spot,
            "premium": leg.get("premium", 0.0) if leg["kind"] == "option" else 0.0,
        }
        for leg in resolved
    ]
    payoff = build_payoff(payoff_legs, spot, tick)
    greeks = _roll_greeks(resolved, spot, header, multiplier)
    margin_block = _margin_block(resolved, spot, multiplier, cover, settle_error)
    meta: dict[str, Any] = {
        "model": "bsm-european",
        "rate": header["rate"],
        "dividendYield": header["dividendYield"],
        "priceBasis": header["priceBasis"],
        "priceBasisNote": header["priceBasisNote"],
        "marginRule": "sse-szse-etf-standard-12-7",
        "marginSpotAssumption": "spot-as-prev-and-close",
        "disclaimer": DISCLAIMER,
    }
    public_legs = [_public_leg(leg) for leg in resolved]
    charts = _strategy_charts(
        request,
        underlying=underlying,
        spot=spot,
        tick=tick,
        multiplier=multiplier,
        header=header,
        legs=resolved,
        payoff=payoff,
    )
    return {
        "source": source,
        "underlying": underlying,
        "spot": spot,
        "multiplier": multiplier,
        "snapshotAt": header["snapshotAt"],
        "priceBasis": header["priceBasis"],
        "priceBasisNote": header["priceBasisNote"],
        "legs": public_legs,
        "entry": {"debitCredit": entry_cash, "note": ENTRY_NOTE},
        "payoff": payoff,
        "greeks": greeks,
        "margin": margin_block,
        "charts": charts,
        "failures": failures,
        "meta": meta,
    }


def _validate_identity(request: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    source = _require(request, "source")
    underlying = _require(request, "underlying")
    if source not in ("synth", "akshare", "iquant"):
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")
    if source == "synth" and underlying != synth.SYNTH_UNDERLYING:
        raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
    reg = find_underlying(source, underlying)
    if reg is None:
        raise OptionsError("BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings")
    return source, underlying, reg


def _validate_akshare_asof(source: str, request: dict[str, Any]) -> None:
    if source in ("akshare", "iquant") and request.get("asOf") is not None:
        raise OptionsError(
            "BAD_REQUEST",
            f"asOf is only supported for source=synth; {source} board is a live snapshot",
        )


def _validate_chart_kinds(request: dict[str, Any]) -> None:
    viz_raw = request.get("vizDir")
    kinds_raw = request.get("chartKinds")
    if kinds_raw is None:
        return
    if not isinstance(viz_raw, str) or not viz_raw:
        raise OptionsError("BAD_REQUEST", "chartKinds requires vizDir")
    allowed = list(STRATEGY_CHART_KINDS)
    if (
        not isinstance(kinds_raw, list)
        or not kinds_raw
        or not all(isinstance(item, str) for item in kinds_raw)
        or not set(kinds_raw) <= set(STRATEGY_CHART_KINDS)
    ):
        raise OptionsError("BAD_REQUEST", f"chartKinds must be a non-empty subset of {allowed}")


def _collect_legs(request: dict[str, Any], multiplier: int) -> list[dict[str, Any]]:
    raw: list[dict[str, Any]] = []
    template = request.get("template")
    if template is not None:
        params = request.get("templateParams") or {}
        if not isinstance(params, dict):
            raise OptionsError("BAD_REQUEST", "templateParams must be an object")
        raw.extend(expand_template(str(template), params, multiplier))
    legs = request.get("legs")
    if legs is None:
        return raw
    if not isinstance(legs, list):
        raise OptionsError("BAD_REQUEST", "legs must be an array")
    for item in legs:
        if not isinstance(item, dict):
            raise OptionsError("BAD_REQUEST", "each leg must be an object")
        copied = dict(item)
        copied["fromTemplate"] = False
        raw.append(copied)
    return raw


def _normalize_leg(leg: dict[str, Any], *, underlying: str, multiplier: int) -> None:
    kind = leg.get("kind")
    side = leg.get("side")
    if kind not in ("option", "underlying"):
        raise OptionsError(
            "BAD_REQUEST",
            f"leg kind must be 'option' or 'underlying', got {kind!r}",
        )
    if side not in ("buy", "sell"):
        raise OptionsError("BAD_REQUEST", f"leg side must be 'buy' or 'sell', got {side!r}")
    qty = _positive_int(leg.get("qty"), "qty")
    if kind == "underlying":
        if qty % multiplier != 0:
            raise OptionsError(
                "BAD_REQUEST",
                f"underlying qty must be a multiple of multiplier {multiplier}, got {qty}",
            )
        leg["qty"] = qty
        return
    code = leg.get("code")
    has_code = isinstance(code, str) and bool(code)
    has_triple = all(leg.get(key) is not None for key in ("optionType", "strike", "expiryMonth"))
    if has_code == has_triple:
        raise OptionsError(
            "BAD_REQUEST",
            "option leg must have code XOR (optionType, strike, expiryMonth)",
        )
    if has_code:
        try:
            parsed = synth.parse_long_code(str(code))
        except ValueError as err:
            raise OptionsError("BAD_REQUEST", str(err)) from err
        if parsed["underlying"] != underlying:
            raise OptionsError(
                "BAD_REQUEST",
                f"code underlying {parsed['underlying']!r} does not match {underlying!r}",
            )
        leg["optionType"] = parsed["optionType"]
        leg["strike"] = parsed["strike"]
        leg["expiryMonth"] = parsed["expiryMonth"]
    else:
        if leg.get("optionType") not in ("C", "P"):
            raise OptionsError(
                "BAD_REQUEST",
                f"optionType must be 'C' or 'P', got {leg.get('optionType')!r}",
            )
        strike = leg.get("strike")
        if not isinstance(strike, (int, float)) or isinstance(strike, bool) or strike <= 0:
            raise OptionsError("BAD_REQUEST", f"strike must be a positive number, got {strike!r}")
        month = leg.get("expiryMonth")
        if not isinstance(month, str) or not month:
            raise OptionsError("BAD_REQUEST", "missing or invalid field: expiryMonth")
        leg["strike"] = float(strike)
        try:
            leg["code"] = synth.make_long_code(
                underlying, str(leg["optionType"]), month, float(strike)
            )
        except ValueError as err:
            raise OptionsError("BAD_REQUEST", str(err)) from err
    leg["qty"] = qty


def _premium_overrides(request: dict[str, Any], n_legs: int) -> dict[int, float]:
    raw = request.get("premiumOverrides")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise OptionsError("BAD_REQUEST", "premiumOverrides must be an object")
    parsed: dict[int, float] = {}
    for key, value in raw.items():
        try:
            index = int(key)
        except (TypeError, ValueError) as err:
            raise OptionsError(
                "BAD_REQUEST", f"premiumOverrides key must be a leg index, got {key!r}"
            ) from err
        if index < 0 or index >= n_legs:
            raise OptionsError("BAD_REQUEST", f"premiumOverrides index {index} is out of range")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise OptionsError(
                "BAD_REQUEST", f"premiumOverrides[{index}] must be a number, got {value!r}"
            )
        parsed[index] = float(value)
    return parsed


def _resolve_months(
    request: dict[str, Any], raw_legs: list[dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]], OptionsError | None]:
    months: list[str] = []
    for leg in raw_legs:
        if leg["kind"] != "option":
            continue
        month = str(leg["expiryMonth"])
        if month not in months:
            months.append(month)
    state: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, str]] = []
    first_error: OptionsError | None = None
    for month in months:
        try:
            iv = pricing.handle_implied_vol(_iv_request(request, month))
        except OptionsError as err:
            if err.code == "BAD_REQUEST" and "already expired" in err.message:
                state[month] = {"status": "expired", "error": err}
                continue
            if first_error is None:
                first_error = err
            failures.append({"expiryMonth": month, "code": err.code, "message": err.message})
            state[month] = {"status": "failed", "error": err}
            continue
        state[month] = {"status": "ok", "iv": iv}
    return state, failures, first_error


def _iv_request(request: dict[str, Any], month: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "source": request["source"],
        "underlying": request["underlying"],
        "expiryMonth": month,
    }
    for key in ("rate", "dividendYield", "priceField", "asOf", "spot", "iquantArgvPrefix"):
        if request.get(key) is not None:
            out[key] = request[key]
    return out


def _resolve_spot(
    request: dict[str, Any], month_state: dict[str, dict[str, Any]], ok_months: list[str]
) -> float:
    if request.get("spot") is not None:
        spot = request["spot"]
        if not isinstance(spot, (int, float)) or isinstance(spot, bool) or spot <= 0:
            raise OptionsError("BAD_REQUEST", f"spot must be a positive number, got {spot!r}")
        return float(spot)
    for month in ok_months:
        return float(month_state[month]["iv"]["spot"])
    if request.get("source") == "synth":
        expired = [
            month for month, state in month_state.items() if state["status"] == "expired"
        ]
        if expired:
            as_of = request.get("asOf")
            snap = pricing._snapshot_synth(
                str(request["underlying"]),
                expired[0],
                "last",
                as_of if isinstance(as_of, str) else None,
            )
            return float(snap["spot"])
    raise OptionsError("BAD_REQUEST", "spot is required when no option month resolves")


def _header_from_iv(
    request: dict[str, Any],
    source: str,
    month_state: dict[str, dict[str, Any]],
    ok_months: list[str],
) -> dict[str, Any]:
    if ok_months:
        iv = month_state[ok_months[0]]["iv"]
        return {
            "snapshotAt": iv["snapshotAt"],
            "priceBasis": iv["priceBasis"],
            "priceBasisNote": iv["priceBasisNote"],
            "rate": iv["meta"]["rate"],
            "dividendYield": iv["meta"]["dividendYield"],
        }
    rate = request.get("rate")
    if rate is None:
        rate = pricing.SYNTH_RATE if source == "synth" else 0.0
    div = request.get("dividendYield", 0.0)
    return {
        "snapshotAt": None,
        "priceBasis": request.get("priceField", "last"),
        "priceBasisNote": "",
        "rate": float(rate)
        if isinstance(rate, (int, float)) and not isinstance(rate, bool)
        else 0.0,
        "dividendYield": float(div)
        if isinstance(div, (int, float)) and not isinstance(div, bool)
        else 0.0,
    }


def _load_settles(
    request: dict[str, Any],
    month_state: dict[str, dict[str, Any]],
    cache_dir: Path,
    raw_legs: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], OptionsError | None]:
    quotes: dict[str, dict[str, Any]] = {}
    settle_error: OptionsError | None = None
    wanted = [
        month
        for month, state in month_state.items()
        if state["status"] in ("ok", "expired")
    ]
    needed = [leg for leg in raw_legs if leg["kind"] == "option"]
    for month in wanted:
        month_quotes: dict[str, dict[str, Any]] = {}
        iv_ok = False
        if month_state[month]["status"] == "ok":
            try:
                settle_iv = pricing.handle_implied_vol(
                    {**_iv_request(request, month), "priceField": "prevSettle"}
                )
            except OptionsError as err:
                if err.code != "NO_DATA":
                    raise
                settle_error = err
                settle_iv = None
            if settle_iv is not None:
                iv_ok = True
                for row in settle_iv["results"]:
                    if row.get("price") is None:
                        continue
                    month_quotes[row["code"]] = {
                        "code": row["code"],
                        "optionType": row["optionType"],
                        "strike": row["strike"],
                        "prevSettle": float(row["price"]),
                    }
        month_legs = [leg for leg in needed if str(leg["expiryMonth"]) == month]
        need_fallback = (not iv_ok) or any(
            not _has_settle(leg, month_quotes) for leg in month_legs
        )
        if need_fallback:
            if request.get("source") == "synth":
                snap_error = _fill_synth_settles(request, month, month_quotes)
                if snap_error is not None:
                    settle_error = snap_error
                elif any(not _has_settle(leg, month_quotes) for leg in month_legs):
                    settle_error = OptionsError(
                        "NO_DATA",
                        f"no settlement price for month {month}",
                    )
            else:
                try:
                    snap = chain.handle_chain(
                        {
                            "source": request["source"],
                            "underlying": request["underlying"],
                            "expiryMonth": month,
                        },
                        cache_dir,
                    )
                except OptionsError as err:
                    if err.code == "NETWORK":
                        raise
                    settle_error = err
                else:
                    for quote in (*snap.get("calls", []), *snap.get("puts", [])):
                        month_quotes.setdefault(quote["code"], quote)
        quotes.update(month_quotes)
    return quotes, settle_error


def _fill_synth_settles(
    request: dict[str, Any],
    month: str,
    month_quotes: dict[str, dict[str, Any]],
) -> OptionsError | None:
    """synth 按 asOf 读 prevSettle 截面;不用忽略 asOf 的末行 chain。"""
    as_of = request.get("asOf")
    try:
        snap = pricing._snapshot_synth(
            str(request["underlying"]),
            month,
            "prevSettle",
            as_of if isinstance(as_of, str) else None,
        )
    except OptionsError as err:
        if err.code == "NETWORK":
            raise
        return err
    for quote in (*snap.get("calls", []), *snap.get("puts", [])):
        if quote.get("price") is None:
            continue
        month_quotes.setdefault(
            quote["code"],
            {
                "code": quote["code"],
                "optionType": quote["optionType"],
                "strike": quote["strike"],
                "prevSettle": float(quote["price"]),
            },
        )
    return None


def _has_settle(leg: dict[str, Any], quotes: dict[str, dict[str, Any]]) -> bool:
    if not quotes:
        return False
    match = _match_iv_row(leg, list(quotes.values()))
    return match is not None and match.get("prevSettle") is not None


def _resolve_option_legs(
    raw_legs: list[dict[str, Any]],
    month_state: dict[str, dict[str, Any]],
    overrides: dict[int, float],
    settle_quotes: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_legs):
        row: dict[str, Any] = {
            "index": index,
            "kind": raw["kind"],
            "side": raw["side"],
            "qty": raw["qty"],
            "fromTemplate": bool(raw.get("fromTemplate", False)),
        }
        if raw["kind"] == "underlying":
            row["ivStatus"] = "n/a"
            resolved.append(row)
            continue
        month = str(raw["expiryMonth"])
        row["optionType"] = raw["optionType"]
        row["strike"] = raw["strike"]
        row["expiryMonth"] = month
        row["code"] = raw.get("code")
        state = month_state.get(month, {})
        status = state.get("status")
        if status == "expired":
            row["ivStatus"] = "expired"
            row["premium"] = overrides.get(index, 0.0)
            row["iv"] = None
            row["expiryDate"] = synth.expiry_date_of(month).isoformat()
            row["marginSettle"] = _settle_for(row, settle_quotes)
            resolved.append(row)
            continue
        if status != "ok":
            row["ivStatus"] = "insufficient"
            row["premium"] = overrides.get(index, 0.0)
            row["iv"] = None
            row["marginSettle"] = _settle_for(row, settle_quotes)
            resolved.append(row)
            continue
        iv = state["iv"]
        match = _match_iv_row(raw, iv["results"])
        if match is None:
            raise OptionsError(
                "NO_DATA",
                f"no chain row for {raw.get('code') or (raw['optionType'], raw['strike'])}",
            )
        if match.get("price") is None and index not in overrides:
            raise OptionsError("NO_DATA", f"no quote price for {match['code']}")
        row["code"] = match["code"]
        row["expiryDate"] = iv["expiryDate"]
        row["years"] = iv["meta"]["years"]
        row["premium"] = overrides[index] if index in overrides else float(match["price"])
        row["iv"] = match.get("iv")
        row["converged"] = bool(match.get("converged"))
        if match.get("converged") and match.get("iv") is not None:
            row["ivStatus"] = "ok"
        else:
            row["ivStatus"] = "insufficient"
        row["marginSettle"] = _settle_for(row, settle_quotes)
        resolved.append(row)
    return resolved


def _match_iv_row(leg: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any] | None:
    code = leg.get("code")
    if isinstance(code, str) and code:
        for row in results:
            if row["code"] == code:
                return row
    for row in results:
        if row.get("optionType") != leg.get("optionType") or row.get("strike") is None:
            continue
        if math.isclose(float(row["strike"]), float(leg["strike"]), abs_tol=1e-9):
            return row
    return None


def _settle_for(
    leg: dict[str, Any],
    settle_quotes: dict[str, dict[str, Any]],
) -> float | None:
    quote = _match_iv_row(leg, list(settle_quotes.values())) if settle_quotes else None
    if quote is not None and quote.get("prevSettle") is not None:
        return float(quote["prevSettle"])
    return None


def _cover_plan(
    legs: list[dict[str, Any]], multiplier: int
) -> dict[int, tuple[int, int]]:
    remaining = sum(
        int(leg["qty"])
        for leg in legs
        if leg["kind"] == "underlying" and leg["side"] == "buy"
    )
    plan: dict[int, tuple[int, int]] = {}
    for index, leg in enumerate(legs):
        if not (
            leg["kind"] == "option"
            and leg["side"] == "sell"
            and leg.get("optionType") == "C"
        ):
            continue
        covered, uncovered = margin.cover_short_calls(
            long_shares=remaining, short_call_qty=int(leg["qty"]), multiplier=multiplier
        )
        remaining -= covered * multiplier
        plan[index] = (covered, uncovered)
    return plan


def _entry_cash(legs: list[dict[str, Any]], spot: float, multiplier: int) -> float:
    total = 0.0
    for leg in legs:
        sign = 1.0 if leg["side"] == "sell" else -1.0
        if leg["kind"] == "underlying":
            total += sign * spot * int(leg["qty"])
        else:
            total += sign * float(leg.get("premium", 0.0)) * int(leg["qty"]) * multiplier
    return total


def _roll_greeks(
    legs: list[dict[str, Any]],
    spot: float,
    header: dict[str, Any],
    multiplier: int,
) -> dict[str, Any]:
    net = {key: 0.0 for key in GREEK_KEYS}
    greeks_legs: list[dict[str, Any]] = []
    insufficient = False
    for leg in legs:
        if leg["kind"] == "underlying":
            sign = 1 if leg["side"] == "buy" else -1
            signed = {key: 0.0 for key in GREEK_KEYS}
            signed["delta"] = sign * int(leg["qty"])
            for key in GREEK_KEYS:
                net[key] += signed[key]
            greeks_legs.append({"index": leg["index"], "kind": "underlying", **signed})
            continue
        if leg.get("ivStatus") != "ok":
            insufficient = True
            greeks_legs.append({"index": leg["index"], "kind": "option", "status": "insufficient"})
            continue
        raw = bs_greeks(
            spot,
            float(leg["strike"]),
            float(leg["years"]),
            float(header["rate"]),
            float(header["dividendYield"]),
            float(leg["iv"]),
            leg["optionType"] == "C",
        )
        signed = signed_greeks(
            {key: float(raw[key]) for key in GREEK_KEYS},
            side=leg["side"],
            qty=int(leg["qty"]),
            multiplier=multiplier,
        )
        for key in GREEK_KEYS:
            net[key] += signed[key]
        greeks_legs.append({"index": leg["index"], "kind": "option", "status": "ok", **signed})
    return {
        "status": "insufficient" if insufficient else "ok",
        "net": net,
        "legs": greeks_legs,
    }


def _strategy_charts(
    request: dict[str, Any],
    *,
    underlying: str,
    spot: float,
    tick: float,
    multiplier: int,
    header: dict[str, Any],
    legs: list[dict[str, Any]],
    payoff: list[dict[str, float]],
) -> list[dict[str, Any]]:
    viz_raw = request.get("vizDir")
    if not isinstance(viz_raw, str) or not viz_raw:
        return []
    kinds_raw = request.get("chartKinds")
    kinds = (
        strategy_charts.CHART_KINDS
        if kinds_raw is None
        else tuple(dict.fromkeys(kinds_raw))
    )
    return strategy_charts.write_strategy_charts(
        viz_dir=Path(viz_raw),
        underlying=underlying,
        stamp=_chart_stamp(header, request),
        payoff=payoff,
        greeks_curve=_build_greeks_curve(legs, spot, tick, header, multiplier),
        kinds=kinds,
    )


def _build_greeks_curve(
    legs: list[dict[str, Any]],
    spot: float,
    tick: float,
    header: dict[str, Any],
    multiplier: int,
) -> list[dict[str, float]]:
    if any(leg["kind"] == "option" and leg.get("ivStatus") != "ok" for leg in legs):
        return []
    step = max(tick, 0.01)
    lo = 0.80 * spot
    hi = 1.20 * spot
    count = math.floor((hi - lo) / step)
    spots = {lo + index * step for index in range(count + 1)}
    spots.update((lo, spot, hi))
    curve: list[dict[str, float]] = []
    for bumped_spot in sorted(spots):
        delta = 0.0
        gamma = 0.0
        for leg in legs:
            sign = 1 if leg["side"] == "buy" else -1
            if leg["kind"] == "underlying":
                delta += sign * int(leg["qty"])
                continue
            raw = bs_greeks(
                bumped_spot,
                float(leg["strike"]),
                float(leg["years"]),
                float(header["rate"]),
                float(header["dividendYield"]),
                float(leg["iv"]),
                leg["optionType"] == "C",
            )
            scale = sign * int(leg["qty"]) * multiplier
            delta += float(raw["delta"]) * scale
            gamma += float(raw["gamma"]) * scale
        curve.append({"spot": bumped_spot, "delta": delta, "gamma": gamma})
    return curve


def _chart_stamp(header: dict[str, Any], request: dict[str, Any]) -> str:
    snap = header.get("snapshotAt")
    if isinstance(snap, str) and snap:
        return snap[:10]
    as_of = request.get("asOf")
    if isinstance(as_of, str) and as_of:
        return as_of[:10]
    return "live"


def _margin_block(
    legs: list[dict[str, Any]],
    spot: float,
    multiplier: int,
    cover: dict[int, tuple[int, int]],
    settle_error: OptionsError | None,
) -> dict[str, Any]:
    per_leg: list[dict[str, Any]] = []
    total_initial = 0.0
    total_maint = 0.0
    for index, leg in enumerate(legs):
        row: dict[str, Any] = {
            "index": index,
            "kind": leg["kind"],
            "side": leg["side"],
            "qty": leg["qty"],
        }
        if leg["kind"] == "underlying" and leg["side"] == "sell":
            row["status"] = "unsupported"
            per_leg.append(row)
            continue
        if leg["kind"] == "underlying" or leg["side"] == "buy":
            row["initial"] = 0.0
            row["maintenance"] = 0.0
            per_leg.append(row)
            continue
        settle = leg.get("marginSettle")
        charge_qty = int(leg["qty"])
        covered_flag = False
        if leg.get("optionType") == "C" and index in cover:
            _covered_qty, uncovered_qty = cover[index]
            charge_qty = uncovered_qty
            covered_flag = uncovered_qty == 0
            row["covered"] = covered_flag
            if covered_flag:
                row["status"] = "covered"
                row["initial"] = 0.0
                row["maintenance"] = 0.0
                per_leg.append(row)
                continue
        if settle is None:
            if settle_error is not None:
                raise settle_error
            raise OptionsError(
                "NO_DATA",
                f"no settlement price for {leg.get('code')}",
            )
        if leg.get("optionType") == "C":
            initial = margin.initial_short_call(
                prev_settle=float(settle),
                spot_prev=spot,
                strike=float(leg["strike"]),
                multiplier=multiplier,
                qty=charge_qty,
            )
            maint = margin.maintenance_short_call(
                settle=float(settle),
                spot_close=spot,
                strike=float(leg["strike"]),
                multiplier=multiplier,
                qty=charge_qty,
            )
        else:
            initial = margin.initial_short_put(
                prev_settle=float(settle),
                spot_prev=spot,
                strike=float(leg["strike"]),
                multiplier=multiplier,
                qty=charge_qty,
            )
            maint = margin.maintenance_short_put(
                settle=float(settle),
                spot_close=spot,
                strike=float(leg["strike"]),
                multiplier=multiplier,
                qty=charge_qty,
            )
        row["covered"] = covered_flag
        row["initial"] = initial
        row["maintenance"] = maint
        total_initial += initial
        total_maint += maint
        per_leg.append(row)
    return {
        "perLeg": per_leg,
        "totalInitial": total_initial,
        "totalMaintenance": total_maint,
        "note": MARGIN_NOTE,
    }


def _public_leg(leg: dict[str, Any]) -> dict[str, Any]:
    hidden = ("marginSettle", "years", "converged")
    return {key: value for key, value in leg.items() if key not in hidden}


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value


def _positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise OptionsError("BAD_REQUEST", f"{name} must be a positive integer, got {value!r}")
    return value
