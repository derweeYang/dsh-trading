# 用合约日线 + 标的日线回放近月 ATM IV,给 iv-daily 做种子。
#
# 活牌 implied_vol 拒绝 asOf;本路径不走 T 板,只读 history_bars / 合成日线。
# 近月必须仍在合约清单且剩余期限 ≤ maxTermDays,避免用已上市的远月冒充近月。

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pandas as pd

from dsh_options import bsm, contracts, pricing, synth, underlying_daily, vol_analytics
from dsh_options.protocol import OptionsError
from dsh_options.registry import load_registry

DEFAULT_LOOKBACK_DAYS = 80
DEFAULT_MAX_TERM_DAYS = 45
HV20_WINDOW = 20


def handle_replay_atm_iv(request: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """`replay_atm_iv` 子命令:按日回放近月 ATM IV(+ 可选 HV20)。

    Parameters
    ----------
    request : dict
        ``{source, underlying?, lookbackDays?, maxTermDays?, rate?,
        dividendYield?, start?, end?, cacheDir, iquant*}``。
        ``source`` 为 ``synth`` 或 ``iquant``;``underlying`` 缺省或 ``all``
        时拉该 source 全表(synth 仅 910050)。
    """
    source = _require(request, "source")
    if source not in ("synth", "iquant"):
        raise OptionsError(
            "BAD_REQUEST",
            "replay_atm_iv only serves source=synth or source=iquant "
            "(akshare live board has no asOf IV and expired-month codes are a registered gap)",
        )
    lookback = _positive_int(request.get("lookbackDays"), DEFAULT_LOOKBACK_DAYS, "lookbackDays")
    max_term = _positive_int(request.get("maxTermDays"), DEFAULT_MAX_TERM_DAYS, "maxTermDays")
    rate = _rate(request, source)
    div = float(request["dividendYield"]) if isinstance(request.get("dividendYield"), (int, float)) else 0.0
    names = _targets(request.get("underlying"), source)
    start, end = _window(request, lookback)
    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    first_error: OptionsError | None = None
    for name in names:
        try:
            part, skip = _replay_one(
                source, name, cache_dir, request, start, end, lookback, max_term, rate, div
            )
            rows.extend(part)
            skipped.extend(skip)
        except OptionsError as err:
            if len(names) == 1:
                raise
            if first_error is None:
                first_error = err
            failures.append({"underlying": name, "code": err.code, "message": err.message})
    if not rows and not skipped and first_error is not None:
        raise first_error
    return {
        "source": source,
        "lookbackDays": lookback,
        "maxTermDays": max_term,
        "priceBasis": "close",
        "priceBasisNote": (
            "replay ATM IV from option daily close + spot daily close; "
            "not a live T-board implied_vol snapshot"
        ),
        "rows": rows,
        "skipped": skipped,
        "failures": failures,
        "okDays": len(rows),
        "skippedDays": len(skipped),
    }


def _replay_one(
    source: str,
    underlying: str,
    cache_dir: Path,
    request: dict[str, Any],
    start: str,
    end: str,
    lookback: int,
    max_term: int,
    rate: float,
    div: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    instruments = _instruments(source, underlying, cache_dir, request)
    spot = _spot_frame(source, underlying, cache_dir, request, start, end)
    if spot.empty:
        raise OptionsError("NO_DATA", f"no spot daily rows for {underlying}")
    spot = spot.tail(lookback + HV20_WINDOW + 1)
    needed = _needed_codes(instruments, spot, max_term)
    wanted = [item for item in instruments if str(item["code"]) in needed]
    closes_by_code = _load_option_closes(source, underlying, wanted, cache_dir, request, start, end)
    out: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    closes = [float(v) for v in spot["close"].tolist()]
    for index, srow in enumerate(spot.itertuples(index=False)):
        day = _iso(srow.date)
        as_of = date.fromisoformat(day)
        spot_px = float(srow.close)
        expiry, month_rows = _near_month(instruments, as_of, max_term)
        if expiry is None or not month_rows:
            skipped.append({"date": day, "underlying": underlying, "reason": "no-listed-near-month"})
            continue
        years = (expiry - as_of).days / 365.0
        if years <= 0.0:
            skipped.append({"date": day, "underlying": underlying, "reason": "expired"})
            continue
        strikes = sorted({float(item["strike"]) for item in month_rows})
        strike = min(strikes, key=lambda level: abs(level - spot_px))
        day_ivs: list[float] = []
        for option_type, is_call in (("C", True), ("P", False)):
            code = _code_of(month_rows, option_type, strike)
            if code is None:
                continue
            price = closes_by_code.get(code, {}).get(day)
            if price is None or price <= 0:
                continue
            iv, status = bsm.implied_vol(price, spot_px, strike, years, rate, div, is_call)
            if status == "ok" and iv is not None:
                day_ivs.append(float(iv))
        if not day_ivs:
            skipped.append({"date": day, "underlying": underlying, "reason": "no-converged-atm"})
            continue
        hv = _hv20_at(closes, index)
        row: dict[str, Any] = {
            "date": day,
            "underlying": underlying,
            "atmIv": float(sum(day_ivs) / len(day_ivs)),
            "expiryMonth": month_rows[0]["expiryMonth"],
            "expiryDate": expiry.isoformat(),
            "atmStrike": strike,
            "source": "replay",
        }
        if hv is not None:
            row["hv20"] = hv
        out.append(row)
    return out, skipped


def _instruments(
    source: str, underlying: str, cache_dir: Path, request: dict[str, Any]
) -> list[dict[str, Any]]:
    if source == "synth":
        if underlying != synth.SYNTH_UNDERLYING:
            raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
        chain = synth.make_chain_cached()
        return [
            {
                "code": item["code"],
                "optionType": item["optionType"],
                "strike": float(item["strike"]),
                "expiryMonth": item["expiryMonth"],
                "expiryDate": item["expiryDate"],
                "multiplier": chain["multiplier"],
            }
            for item in chain["contracts"]
        ]
    from dsh_options import iquant

    row = iquant.require_row(underlying)
    raw = iquant.run_quote(
        "option_instruments",
        {"market": iquant.option_market_of(row), "underlying": underlying},
        request,
    )
    instruments = list(raw.get("instruments") or [])
    if not instruments:
        snap = contracts.handle_contracts(
            {"source": "iquant", "underlying": underlying, "cacheDir": str(cache_dir)},
            cache_dir,
        )
        instruments = list(snap["contracts"])
    if not instruments:
        raise OptionsError("NO_DATA", f"no iquant contracts for {underlying}")
    return instruments


def _spot_frame(
    source: str,
    underlying: str,
    cache_dir: Path,
    request: dict[str, Any],
    start: str,
    end: str,
) -> pd.DataFrame:
    if source == "synth":
        spot = synth.make_chain_cached()["spot"].copy()
        spot = spot[(spot["date"] >= pd.Timestamp(start)) & (spot["date"] <= pd.Timestamp(end))]
        return spot.reset_index(drop=True)
    fetched = underlying_daily.handle_fetch_underlying_daily(
        {
            "source": source,
            "underlying": underlying,
            "start": start,
            "end": end,
            **_forward_iquant(request),
        },
        cache_dir,
    )
    path = Path(fetched["underlyings"][0]["cachePath"])
    frame = underlying_daily._read_parquet(path)
    return underlying_daily._filter_range(frame, start, end)


def _load_option_closes(
    source: str,
    underlying: str,
    instruments: list[dict[str, Any]],
    cache_dir: Path,
    request: dict[str, Any],
    start: str,
    end: str,
) -> dict[str, dict[str, float]]:
    if source == "synth":
        chain = synth.make_chain_cached()
        out: dict[str, dict[str, float]] = {}
        for item in chain["contracts"]:
            by_day = {}
            for _, row in item["daily"].iterrows():
                by_day[_iso(row["date"])] = float(row["close"])
            out[item["code"]] = by_day
        return out
    from dsh_options import iquant

    row = iquant.require_row(underlying)
    out = {}
    for item in instruments:
        code = str(item["code"])
        symbol = str(item.get("shortCode") or code)
        path = cache_dir / "daily" / "iquant" / f"{code}.parquet"
        if path.exists():
            frame = pd.read_parquet(path)
        else:
            start_ms, end_ms, limit = iquant.history_window({"start": start, "end": end})
            raw = iquant.run_quote(
                "history_bars",
                {
                    "market": iquant.option_market_of(row),
                    "symbol": symbol,
                    "period": "1d",
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "limit": limit,
                },
                request,
            )
            frame = iquant.bars_to_ohlcv(raw.get("bars") or [])
            if not frame.empty:
                path.parent.mkdir(parents=True, exist_ok=True)
                frame.to_parquet(path, index=False)
        out[code] = {
            _iso(rec.date): float(rec.close)
            for rec in frame.itertuples(index=False)
            if float(rec.close) > 0
        }
    return out


def _needed_codes(
    instruments: list[dict[str, Any]], spot: pd.DataFrame, max_term: int
) -> set[str]:
    needed: set[str] = set()
    for srow in spot.itertuples(index=False):
        as_of = date.fromisoformat(_iso(srow.date))
        _expiry, month_rows = _near_month(instruments, as_of, max_term)
        if not month_rows:
            continue
        strikes = sorted({float(item["strike"]) for item in month_rows})
        strike = min(strikes, key=lambda level: abs(level - float(srow.close)))
        for option_type in ("C", "P"):
            code = _code_of(month_rows, option_type, strike)
            if code is not None:
                needed.add(code)
    return needed


def _near_month(
    instruments: list[dict[str, Any]], as_of: date, max_term: int
) -> tuple[date | None, list[dict[str, Any]]]:
    alive: list[tuple[date, dict[str, Any]]] = []
    for item in instruments:
        expiry = date.fromisoformat(str(item["expiryDate"]))
        if expiry > as_of:
            alive.append((expiry, item))
    if not alive:
        return None, []
    nearest = min(expiry for expiry, _ in alive)
    if (nearest - as_of).days > max_term:
        return None, []
    return nearest, [item for expiry, item in alive if expiry == nearest]


def _code_of(month_rows: list[dict[str, Any]], option_type: str, strike: float) -> str | None:
    for item in month_rows:
        if item["optionType"] == option_type and abs(float(item["strike"]) - strike) < 1e-9:
            return str(item["code"])
    return None


def _hv20_at(closes: list[float], index: int) -> float | None:
    if index < HV20_WINDOW:
        return None
    window = closes[index - HV20_WINDOW : index + 1]
    row = vol_analytics.realized_vol(window, HV20_WINDOW)
    hv = row.get("hv")
    return float(hv) if isinstance(hv, (int, float)) else None


def _targets(raw: object, source: str) -> list[str]:
    if source == "synth":
        if raw in (None, "", "all", synth.SYNTH_UNDERLYING):
            return [synth.SYNTH_UNDERLYING]
        raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
    if raw in (None, "", "all"):
        return [str(row["underlying"]) for row in load_registry("iquant")]
    if not isinstance(raw, str) or not raw.strip():
        raise OptionsError("BAD_REQUEST", "underlying must be a code or 'all'")
    return [raw.strip()]


def _window(request: dict[str, Any], lookback: int) -> tuple[str, str]:
    end_raw = request.get("end")
    start_raw = request.get("start")
    end = date.fromisoformat(end_raw) if isinstance(end_raw, str) and end_raw else date.today()
    start = (
        date.fromisoformat(start_raw)
        if isinstance(start_raw, str) and start_raw
        else end - timedelta(days=lookback * 2 + 40)
    )
    if start >= end:
        raise OptionsError("BAD_REQUEST", "start must be before end")
    return start.isoformat(), end.isoformat()


def _rate(request: dict[str, Any], source: str) -> float:
    raw = request.get("rate")
    if raw is None and source == "synth":
        return pricing.SYNTH_RATE
    if not isinstance(raw, (int, float)) or isinstance(raw, bool):
        raise OptionsError(
            "BAD_REQUEST",
            "rate is required for source=iquant (pick an explicit funding rate, e.g. 0.02)",
        )
    return float(raw)


def _forward_iquant(request: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in (
        "iquantArgvPrefix",
        "iquantSource",
        "sdkPath",
        "apiDllPath",
        "vendorQmtquotePath",
        "quoteConfigPath",
        "snapshotWaitMs",
    ):
        if request.get(key) is not None:
            out[key] = request[key]
    return out


def _positive_int(raw: object, default: int, name: str) -> int:
    if raw is None:
        return default
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1:
        raise OptionsError("BAD_REQUEST", f"{name} must be a positive integer")
    return raw


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value


def _iso(value: object) -> str:
    return pd.Timestamp(value).strftime("%Y-%m-%d")
