# iquant 适配器:子进程调用 dsh-iquant-quote,按 request 转发 synth 或 live。
#
# SDK 接触只在 iquant-quote。options 只认 stdout JSON,并把 UNSUPPORTED 收成
# NO_DATA(期权协议没有 UNSUPPORTED 码)。测试替换 call_quote。

from __future__ import annotations

import json
import subprocess
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pandas as pd

from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying

CST = timezone(timedelta(hours=8))
DAY_MS = 86_400_000
#: 与 iquant-quote synth 锚点一致,缺省日线窗口从这里起算。
DEFAULT_BARS_START_MS = 1_704_159_060_000
DEFAULT_BARS_LIMIT = 2000
EXCHANGE_MARKET = {"SSE": "SH", "SZSE": "SZ"}


class QuoteReplyError(Exception):
    """iquant-quote 领域错误,供注入 runner 与真实 stdout 共用映射。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def market_of(row: dict[str, Any]) -> str:
    """注册表交易所 → iquant-quote 市场 token。"""
    try:
        return EXCHANGE_MARKET[row["exchange"]]
    except KeyError as err:
        raise OptionsError("INTERNAL", f"iquant registry exchange {row['exchange']!r}") from err


def require_row(underlying: str) -> dict[str, Any]:
    row = find_underlying("iquant", underlying)
    if row is None:
        raise OptionsError(
            "BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings"
        )
    return row


def map_quote_error(code: str, message: str) -> OptionsError:
    """iquant-quote 错误码 → 期权协议。UNSUPPORTED 收成诚实的 NO_DATA。"""
    if code == "UNSUPPORTED":
        return OptionsError("NO_DATA", f"iquant-quote cannot serve this: {message}")
    if code in ("BAD_REQUEST", "NO_DATA", "NETWORK", "INTERNAL"):
        return OptionsError(code, message)
    return OptionsError("NO_DATA", f"iquant-quote cannot serve this: {code}: {message}")



def _require_live_host_path(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"iquantSource live requires {key}")
    return value


def _live_quote_payload(body: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    payload = {
        **body,
        "source": "live",
        "allowNetworkLogin": True,
        "sdkPath": _require_live_host_path(request, "sdkPath"),
        "apiDllPath": _require_live_host_path(request, "apiDllPath"),
        "vendorQmtquotePath": _require_live_host_path(request, "vendorQmtquotePath"),
        "quoteConfigPath": _require_live_host_path(request, "quoteConfigPath"),
    }
    wait = request.get("snapshotWaitMs")
    if isinstance(wait, int):
        payload["maxWaitMs"] = wait
    return payload


def run_quote(subcommand: str, body: dict[str, Any], request: dict[str, Any] | None = None) -> dict[str, Any]:
    """调用 iquant-quote;``iquantSource: live`` 时转发宿主路径,否则 ``source: synth``。"""
    request = request or {}
    if request.get("iquantSource") == "live":
        payload = _live_quote_payload(body, request)
    else:
        payload = {**body, "source": "synth"}
    try:
        return call_quote(subcommand, payload, request)
    except QuoteReplyError as err:
        raise map_quote_error(err.code, err.message) from err
    except OSError as err:
        raise OptionsError("NO_DATA", f"iquant-quote cannot serve this: {err}") from err


def call_quote(subcommand: str, body: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    """默认 spawn ``iquantArgvPrefix + subcommand``;测试替换本函数。"""
    prefix = request.get("iquantArgvPrefix")
    if not isinstance(prefix, list) or not prefix or not all(isinstance(item, str) for item in prefix):
        raise OptionsError("BAD_REQUEST", "iquant source requires iquantArgvPrefix")
    try:
        proc = subprocess.run(
            [*prefix, subcommand],
            input=json.dumps(body, ensure_ascii=False),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        raise
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise OptionsError(
            "NO_DATA",
            f"iquant-quote cannot serve this: expected one stdout line, got {proc.stdout!r}",
        )
    try:
        response = json.loads(lines[0])
    except json.JSONDecodeError as err:
        raise OptionsError(
            "NO_DATA", f"iquant-quote cannot serve this: undecodable stdout: {err}"
        ) from err
    if not isinstance(response, dict) or "ok" not in response:
        raise OptionsError("NO_DATA", "iquant-quote cannot serve this: response is not {ok, ...}")
    if response.get("ok") is True:
        result = response.get("result")
        if not isinstance(result, dict):
            raise OptionsError("INTERNAL", "iquant-quote result is not an object")
        return result
    error = response.get("error") or {}
    code = str(error.get("code") or "INTERNAL")
    message = str(error.get("message") or "iquant-quote failed")
    raise QuoteReplyError(code, message)


def map_chain_quote(row: dict[str, Any]) -> dict[str, Any]:
    """iquant option_chain 行 → options chain 列名(preClose → prevSettle)。"""
    quote = {
        "code": row["code"],
        "strike": float(row["strike"]),
        "last": float(row["last"]),
        "prevSettle": float(row["preClose"]),
        "volume": int(row["volume"]),
    }
    if "changePct" in row:
        quote["changePct"] = float(row["changePct"])
    return quote


def bars_to_ohlcv(bars: list[dict[str, Any]]) -> pd.DataFrame:
    """history_bars 行 → options OHLCV 契约。"""
    rows = [
        {
            "date": _bar_date(int(bar["timestampMs"])),
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
            "volume": int(bar["volume"]),
        }
        for bar in bars
    ]
    frame = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])
    frame["date"] = pd.to_datetime(frame["date"])
    return frame.sort_values("date").reset_index(drop=True)


def history_window(request: dict[str, Any]) -> tuple[int, int, int]:
    """把可选 ISO start/end 收成 iquant-quote 的毫秒窗与 limit。"""
    start_raw = request.get("start")
    end_raw = request.get("end")
    start_ms = _iso_to_ms(start_raw, end_of_day=False) if isinstance(start_raw, str) and start_raw else DEFAULT_BARS_START_MS
    if isinstance(end_raw, str) and end_raw:
        end_ms = _iso_to_ms(end_raw, end_of_day=True) + 1
    else:
        end_ms = start_ms + DEFAULT_BARS_LIMIT * DAY_MS
    if end_ms <= start_ms:
        raise OptionsError("BAD_REQUEST", "end must be after start")
    return start_ms, end_ms, DEFAULT_BARS_LIMIT


def fetch_spot(underlying: str, request: dict[str, Any]) -> float:
    """标的 ETF 最新价:走 iquant-quote snapshot。"""
    row = require_row(underlying)
    result = run_quote(
        "snapshot",
        {
            "market": market_of(row),
            "symbols": [underlying],
            "maxWaitMs": 2_000,
        },
        request,
    )
    snaps = result.get("snapshots") or []
    if not snaps:
        raise OptionsError("NO_DATA", f"iquant-quote returned no snapshot for {underlying}")
    return float(snaps[0]["last"])


def _bar_date(timestamp_ms: int) -> date:
    return datetime.fromtimestamp(timestamp_ms / 1000.0, tz=CST).date()


def _iso_to_ms(iso: str, *, end_of_day: bool) -> int:
    day = date.fromisoformat(iso)
    hour, minute, second = (23, 59, 59) if end_of_day else (0, 0, 0)
    moment = datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=CST)
    return int(moment.timestamp() * 1000)
