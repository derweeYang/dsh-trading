# 标的 ETF 现货日线:东财 fund_etf_hist_em,沪深两市通用,无 synth。
#
# 与 fetch_daily(期权合约)分开:合约日线受 szse_static_only 限制,标的现货不是。
# 单标的失败抛原始错误码;批量部分失败写入 failures;批量全失败传播首个错误。
# 不把 NETWORK 降级为 NO_DATA。非法行剔除、不填 0。落盘先写 .tmp 再 os.replace。

from __future__ import annotations

import json
import os
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying, load_registry

OHLCV_COLUMNS = ["date", "open", "high", "low", "close", "volume"]
PREVIEW_ROWS = 10
RETRY_ATTEMPTS = 3
MANIFEST_NAME = "manifest.jsonl"
_RETRYABLE = ("502", "503", "504", "timeout", "timed out")
_COLUMN_ALIASES = {
    "date": ("date", "日期"),
    "open": ("open", "开盘"),
    "high": ("high", "最高"),
    "low": ("low", "最低"),
    "close": ("close", "收盘"),
    "volume": ("volume", "成交量"),
}


def handle_fetch_underlying_daily(request: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """`fetch_underlying_daily` 子命令:标的 ETF 现货日线,parquet cache-first。

    Parameters
    ----------
    request : dict
        ``{source, underlying?, start?, end?, adjust?, forceRefresh?, cacheDir}``。
        ``source`` 为 ``akshare`` 或 ``iquant``;``underlying`` 缺省或 ``all`` 时拉该 source 注册表全表。
    cache_dir : Path
        缓存根目录。

    Returns
    -------
    dict[str, Any]
        ``{source, adjust, rows, underlyings, failures}``。
    """
    source = _require(request, "source")
    if source not in ("akshare", "iquant"):
        raise OptionsError(
            "BAD_REQUEST", "fetch_underlying_daily only serves source=akshare or source=iquant"
        )
    response_adjust, cache_suffix = _normalize_adjust(request.get("adjust"))
    if source == "iquant" and cache_suffix != "raw":
        raise OptionsError(
            "BAD_REQUEST", "iquant underlying daily has no qfq/hfq adjustment"
        )
    force = bool(request.get("forceRefresh", False))
    start = request.get("start")
    end = request.get("end")
    targets = _resolve_targets(request.get("underlying"), source)
    items: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    first_error: OptionsError | None = None
    for row in targets:
        try:
            items.append(
                _load_one(
                    row,
                    cache_dir,
                    cache_suffix,
                    response_adjust,
                    force,
                    start,
                    end,
                    source,
                    request,
                )
            )
        except OptionsError as err:
            if len(targets) == 1:
                raise
            if first_error is None:
                first_error = err
            failures.append(
                {"underlying": row["underlying"], "code": err.code, "message": err.message}
            )
    if not items:
        assert first_error is not None
        raise first_error
    return {
        "source": source,
        "adjust": response_adjust,
        "rows": len(items),
        "underlyings": items,
        "failures": failures,
    }


def _load_one(
    row: dict[str, Any],
    cache_dir: Path,
    cache_suffix: str,
    response_adjust: str,
    force: bool,
    start: Any,
    end: Any,
    source: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    path = _cache_path(cache_dir, row["underlying"], cache_suffix, source)
    df, cached = _load_or_fetch(
        path, row["underlying"], cache_suffix, force, source, request
    )
    df = _filter_range(df, start, end)
    if df.empty:
        raise OptionsError(
            "NO_DATA",
            f"no rows for {row['underlying']} in [{start or 'begin'}, {end or 'end'}]",
        )
    if not cached:
        _append_manifest(
            cache_dir, row["underlying"], response_adjust, int(len(df)), path, source
        )
    return {
        "underlying": row["underlying"],
        "name": row["name"],
        "exchange": row["exchange"],
        "cached": cached,
        "rows": int(len(df)),
        "firstDate": _iso(df["date"].iloc[0]),
        "lastDate": _iso(df["date"].iloc[-1]),
        "cachePath": str(path),
        "preview": [
            {"date": _iso(item.date), "close": float(item.close)}
            for item in df.tail(PREVIEW_ROWS).itertuples()
        ],
    }


def _load_or_fetch(
    path: Path,
    underlying: str,
    cache_suffix: str,
    force: bool,
    source: str,
    request: dict[str, Any],
) -> tuple[pd.DataFrame, bool]:
    if path.exists() and not force:
        return _read_parquet(path), True
    if source == "iquant":
        from dsh_options import iquant

        row = iquant.require_row(underlying)
        start_ms, end_ms, limit = iquant.history_window(request)
        raw = iquant.run_quote(
            "history_bars",
            {
                "market": iquant.market_of(row),
                "symbol": underlying,
                "period": "1d",
                "startMs": start_ms,
                "endMs": end_ms,
                "limit": limit,
            },
            request,
        )
        df = iquant.bars_to_ohlcv(raw["bars"])
    else:
        df = _sanitize(_normalize_ohlcv(_fetch_em_daily(underlying, cache_suffix)))
    if df.empty:
        raise OptionsError("NO_DATA", f"no valid daily rows for {underlying}")
    _atomic_write_parquet(path, df)
    return df, False


def _fetch_em_daily(underlying: str, adjust: str) -> pd.DataFrame:
    """带退避重试的东财日线;仅 502/503/504/timeout 重试。"""
    last: BaseException | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            return _fund_etf_hist_em(underlying, adjust)
        except OptionsError:
            raise
        except Exception as err:
            last = err
            if not _is_retryable(err) or attempt == RETRY_ATTEMPTS - 1:
                raise OptionsError(
                    "NETWORK", f"eastmoney hist failed for {underlying}: {err}"
                ) from err
            time.sleep(2**attempt)
    raise OptionsError("NETWORK", f"eastmoney hist failed for {underlying}: {last}")


def _fund_etf_hist_em(underlying: str, adjust: str) -> pd.DataFrame:
    """东财 ETF 日线原表;测试替换本函数以避开真网。"""
    import akshare as ak

    ak_adjust = "" if adjust in ("raw", "none", "") else adjust
    try:
        raw = ak.fund_etf_hist_em(
            symbol=underlying,
            period="daily",
            start_date="19900101",
            end_date=date.today().strftime("%Y%m%d"),
            adjust=ak_adjust,
        )
    except OptionsError:
        raise
    except Exception as err:
        if _is_retryable(err):
            raise
        raise OptionsError(
            "NETWORK", f"eastmoney hist failed for {underlying}: {err}"
        ) from err
    if raw is None or raw.empty:
        raise OptionsError("NO_DATA", f"eastmoney returned no daily rows for {underlying}")
    return raw


def _normalize_ohlcv(raw: pd.DataFrame) -> pd.DataFrame:
    renamed: dict[str, str] = {}
    for dest, aliases in _COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in raw.columns:
                renamed[alias] = dest
                break
        else:
            raise OptionsError("INTERNAL", f"hist frame missing {dest} column")
    df = raw.rename(columns=renamed)[OHLCV_COLUMNS].copy()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def _sanitize(df: pd.DataFrame) -> pd.DataFrame:
    valid = df.dropna(subset=["date", "close", "volume"])
    valid = valid[(valid["close"] > 0) & (valid["volume"] >= 0)]
    return valid.sort_values("date").reset_index(drop=True)


def _resolve_targets(underlying: Any, source: str = "akshare") -> list[dict[str, Any]]:
    rows = load_registry(source)
    if underlying is None or underlying == "" or underlying == "all":
        return rows
    if not isinstance(underlying, str):
        raise OptionsError("BAD_REQUEST", "missing or invalid field: underlying")
    row = find_underlying(source, underlying)
    if row is None:
        raise OptionsError(
            "BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings"
        )
    return [row]


def _normalize_adjust(value: Any) -> tuple[str, str]:
    """返回 (响应 adjust, 缓存文件后缀)。缺省响应 ``none``、文件 ``raw``。"""
    if value is None or value == "":
        return "none", "raw"
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", "missing or invalid field: adjust")
    if value in ("none", "raw"):
        return "none", "raw"
    if value in ("qfq", "hfq"):
        return value, value
    raise OptionsError("BAD_REQUEST", f"unknown adjust: {value!r}")


def _cache_path(cache_dir: Path, underlying: str, suffix: str, source: str = "akshare") -> Path:
    if source == "iquant":
        return cache_dir / "underlyings" / "iquant" / f"{underlying}_{suffix}.parquet"
    return cache_dir / "underlyings" / f"{underlying}_{suffix}.parquet"


def _atomic_write_parquet(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def _append_manifest(
    cache_dir: Path,
    underlying: str,
    adjust: str,
    rows: int,
    path: Path,
    source: str = "akshare",
) -> None:
    record = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "command": "fetch_underlying_daily",
        "underlying": underlying,
        "source": source,
        "adjust": adjust,
        "rows": rows,
        "cachePath": str(path),
    }
    manifest = cache_dir / MANIFEST_NAME
    with manifest.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False))
        handle.write("\n")


def _read_parquet(path: Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    if list(df.columns) != OHLCV_COLUMNS:
        raise OptionsError("INTERNAL", f"cache {path} has unexpected columns: {list(df.columns)}")
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def _filter_range(df: pd.DataFrame, start: Any, end: Any) -> pd.DataFrame:
    mask = pd.Series(True, index=df.index)
    if start is not None:
        mask &= df["date"] >= pd.Timestamp(start)
    if end is not None:
        mask &= df["date"] <= pd.Timestamp(end)
    return df[mask]


def _is_retryable(err: BaseException) -> bool:
    if isinstance(err, TimeoutError):
        return True
    text = str(err).lower()
    return any(marker in text for marker in _RETRYABLE)


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value


def _iso(value: Any) -> str:
    return pd.Timestamp(value).strftime("%Y-%m-%d")
