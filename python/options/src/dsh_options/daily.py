# 单合约全历史日线:cache-first parquet;akshare 路径经新浪短代码映射。
#
# 两套代码体系:标准长代码(主键)与新浪短代码(daily 接口的参数)。映射经逐合约
# Greeks 接口懒建立并落盘缓存;映射缺失显式 NO_DATA,绝不猜测。
# 深交所合约的日线是已登记缺口(szse_static_only),同样显式 NO_DATA。

import time
from pathlib import Path
from typing import Any

import pandas as pd

from dsh_options import synth
from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying

OHLCV_COLUMNS = ["date", "open", "high", "low", "close", "volume"]
PREVIEW_ROWS = 10
# 逐合约网络请求节流(2026-09-05 探测:1.5s 间隔 8 请求全通;取保守 0.5s)
REQUEST_PAUSE_SECONDS = 0.5
MAPPING_COLUMNS = ["code", "sinaCode"]


def handle_fetch_daily(request: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """`fetch_daily` 子命令:单合约全历史日线,parquet cache-first。

    Parameters
    ----------
    request : dict
        ``{contract, source, start?, end?, forceRefresh?, cacheDir}``;
        contract 为标准长代码(如 ``510050C2609M02850``)。
    cache_dir : Path
        缓存根目录。

    Returns
    -------
    dict[str, Any]
        ``{cached, rows, firstDate, lastDate, cachePath, preview}``。
    """
    contract = _require(request, "contract")
    source = _require(request, "source")
    start = request.get("start")
    end = request.get("end")
    force = bool(request.get("forceRefresh", False))
    try:
        parsed = synth.parse_long_code(contract)
    except ValueError as err:
        raise OptionsError("BAD_REQUEST", f"invalid contract code: {err}") from err
    path = _daily_path(cache_dir, source, contract)

    df, cached = _load_or_fetch(path, source, parsed, force, cache_dir, request)
    df = _filter_range(df, start, end)
    if df.empty:
        raise OptionsError(
            "NO_DATA", f"no rows for {contract} in [{start or 'begin'}, {end or 'end'}]"
        )
    return {
        "cached": cached,
        "rows": int(len(df)),
        "firstDate": _iso(df["date"].iloc[0]),
        "lastDate": _iso(df["date"].iloc[-1]),
        "cachePath": str(path),
        "preview": [
            {"date": _iso(row.date), "close": float(row.close)}
            for row in df.tail(PREVIEW_ROWS).itertuples()
        ],
    }


def _load_or_fetch(
    path: Path,
    source: str,
    parsed: dict[str, Any],
    force: bool,
    cache_dir: Path,
    request: dict[str, Any],
) -> tuple[pd.DataFrame, bool]:
    """cache-first 读取;miss 或 force 时拉取并原子性落盘。"""
    if path.exists() and not force:
        return _read_parquet(path), True
    df = _fetch_remote(source, parsed, cache_dir, request)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return df, False


def _fetch_remote(
    source: str, parsed: dict[str, Any], cache_dir: Path, request: dict[str, Any]
) -> pd.DataFrame:
    if source == "synth":
        if parsed["underlying"] != synth.SYNTH_UNDERLYING:
            raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
        chain = synth.make_chain()
        for c in chain["contracts"]:
            if (
                c["optionType"] == parsed["optionType"]
                and c["strike"] == parsed["strike"]
                and c["expiryMonth"] == parsed["expiryMonth"]
            ):
                return c["daily"].copy()
        raise OptionsError("NO_DATA", f"synth chain has no contract for {parsed}")
    if source == "iquant":
        from dsh_options import iquant

        row = iquant.require_row(parsed["underlying"])
        start_ms, end_ms, limit = iquant.history_window(request)
        raw = iquant.run_quote(
            "history_bars",
            {
                "market": iquant.market_of(row),
                "symbol": request["contract"],
                "period": "1d",
                "startMs": start_ms,
                "endMs": end_ms,
                "limit": limit,
            },
            request,
        )
        return iquant.bars_to_ohlcv(raw["bars"])
    if source != "akshare":
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")
    row = find_underlying("akshare", parsed["underlying"])
    if row is None:
        raise OptionsError(
            "BAD_REQUEST", f"unknown underlying {parsed['underlying']!r}; see underlyings"
        )
    if row["quotesSource"] != "sse_board":
        raise OptionsError(
            "NO_DATA",
            f"{parsed['underlying']} daily history is a registered gap (szse_static_only)",
        )
    sina_code = _resolve_sina_code(row["underlying"], parsed, cache_dir)
    return _fetch_sina_daily(sina_code)


def _resolve_sina_code(underlying: str, parsed: dict[str, Any], cache_dir: Path) -> str:
    """长代码 → 新浪短代码:映射缓存优先,miss 时经 codes+greeks 接口建立。"""
    contract = synth.make_long_code(
        underlying, parsed["optionType"], parsed["expiryMonth"], parsed["strike"]
    )
    mapping = _ensure_mapping(underlying, parsed["expiryMonth"], parsed["optionType"], cache_dir)
    if contract not in mapping:
        raise OptionsError(
            "NO_DATA",
            f"no sina mapping for {contract}; month codes exist but this strike is absent",
        )
    return mapping[contract]


def _ensure_mapping(
    underlying: str, expiry_month: str, option_type: str, cache_dir: Path
) -> dict[str, str]:
    """建立/读取该标的该月的 {长代码: 新浪短代码} 映射表。"""
    import akshare as ak

    path = _mapping_path(cache_dir, underlying, expiry_month)
    if path.exists():
        df = pd.read_parquet(path)
        if list(df.columns) == MAPPING_COLUMNS:
            return dict(zip(df["code"], df["sinaCode"]))
    label = "看涨期权" if option_type == "C" else "看跌期权"
    try:
        codes = ak.option_sse_codes_sina(
            symbol=label, trade_date=expiry_month, underlying=underlying
        )
    except Exception as err:  # noqa: BLE001 - 第三方接口异常形态不稳定,统一收口
        raise OptionsError("NETWORK", f"sina codes fetch failed: {err}") from err
    if codes is None or codes.empty:
        raise OptionsError("NO_DATA", f"sina has no codes for {underlying} {expiry_month}")
    mapping: dict[str, str] = {}
    for sina_code in codes["期权代码"]:
        if mapping:  # 节流:首个请求前不睡,此后每次 greeks 请求前小睡
            time.sleep(REQUEST_PAUSE_SECONDS)
        try:
            greeks = ak.option_sse_greeks_sina(symbol=str(sina_code))
        except Exception as err:  # noqa: BLE001
            raise OptionsError(
                "NETWORK", f"sina greeks fetch failed for {sina_code}: {err}"
            ) from err
        long_code = _extract_trade_code(greeks)
        if long_code is not None:
            mapping[long_code] = str(sina_code)
    if not mapping:
        raise OptionsError(
            "NO_DATA", f"no sina mapping established for {underlying} {expiry_month}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(sorted(mapping.items()), columns=MAPPING_COLUMNS).to_parquet(path, index=False)
    return mapping


def _extract_trade_code(greeks: pd.DataFrame) -> str | None:
    """从 greeks 接口返回中取「交易代码」字段(长代码)。"""
    try:
        matched = greeks.loc[greeks["字段"] == "交易代码", "值"]
        if matched.empty:
            return None
        return str(matched.iloc[0])
    except (KeyError, IndexError):  # noqa: TRY203 - 返回形状不符按无映射处理
        return None


def _fetch_sina_daily(sina_code: str) -> pd.DataFrame:
    """新浪单合约全历史日线 → OHLCV 契约。"""
    import akshare as ak

    try:
        raw = ak.option_sse_daily_sina(symbol=sina_code)
    except Exception as err:  # noqa: BLE001
        raise OptionsError("NETWORK", f"sina daily fetch failed for {sina_code}: {err}") from err
    if raw is None or raw.empty:
        raise OptionsError("NO_DATA", f"sina returned no daily rows for {sina_code}")
    return pd.DataFrame(
        {
            "date": pd.to_datetime(raw["日期"]),
            "open": raw["开盘"].astype("float64"),
            "high": raw["最高"].astype("float64"),
            "low": raw["最低"].astype("float64"),
            "close": raw["收盘"].astype("float64"),
            "volume": raw["成交量"].astype("int64"),
        }
    )


def _daily_path(cache_dir: Path, source: str, contract: str) -> Path:
    return cache_dir / "daily" / source / f"{contract}.parquet"


def _mapping_path(cache_dir: Path, underlying: str, expiry_month: str) -> Path:
    return cache_dir / "mappings" / f"{underlying}_{expiry_month}.parquet"


def _filter_range(df: pd.DataFrame, start: str | None, end: str | None) -> pd.DataFrame:
    mask = pd.Series(True, index=df.index)
    if start is not None:
        mask &= df["date"] >= pd.Timestamp(start)
    if end is not None:
        mask &= df["date"] <= pd.Timestamp(end)
    return df[mask]


def _read_parquet(path: Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    if list(df.columns) != OHLCV_COLUMNS:
        raise OptionsError("INTERNAL", f"cache {path} has unexpected columns: {list(df.columns)}")
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value


def _iso(value: Any) -> str:
    return pd.Timestamp(value).strftime("%Y-%m-%d")
