from __future__ import annotations

import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.option_names import parse_option_name

CST = timezone(timedelta(hours=8))
DAY_MS = 86_400_000

DEFAULT_SDK_ROOT = r"D:\workspace\myquant\iquant_market_clean_fresh"
DEFAULT_VENDOR_ROOT = r"D:\workspace\myquant\installed\国信iQuant策略交易平台"


def resolve_paths() -> dict[str, str]:
    sdk = os.environ.get("IQUANT_SDK_ROOT", DEFAULT_SDK_ROOT)
    vendor = os.environ.get("IQUANT_VENDOR_ROOT", DEFAULT_VENDOR_ROOT)
    api_dll = os.environ.get(
        "IQUANT_API_DLL",
        os.path.join(sdk, "build", "native", "Release", "iquant_quote.dll"),
    )
    qmtquote = os.environ.get(
        "IQUANT_QMTQUOTE_DLL",
        os.path.join(vendor, "bin.x64", "qmtquote.dll"),
    )
    config = os.environ.get(
        "IQUANT_QUOTE_CONFIG",
        os.path.join(vendor, "config", "xtquoterconfig.xml"),
    )
    return {
        "sdk": sdk,
        "api_dll": api_dll,
        "qmtquote": qmtquote,
        "config": config,
        "bin_dir": os.path.dirname(qmtquote),
    }


class LiveBackend:
    def __init__(self) -> None:
        self._client = None
        self._as_of: date | None = None
        self._names_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._daily_cache: dict[tuple[str, str], dict[str, Any]] = {}

    def _ensure(self):
        if self._client is not None:
            return self._client
        paths = resolve_paths()
        for key in ("api_dll", "qmtquote", "config"):
            if not os.path.isfile(paths[key]):
                raise QuoteGatewayError("NETWORK", f"iquant path missing: {paths[key]}")
        sdk_python = os.path.join(paths["sdk"], "python")
        if sdk_python not in sys.path:
            sys.path.insert(0, sdk_python)
        os.chdir(paths["bin_dir"])
        try:
            from iquant.quote import QuoteClient
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"cannot import iquant.quote: {err}") from err
        client = QuoteClient(paths["api_dll"], paths["qmtquote"], paths["config"])
        try:
            client.login(allow_network_login=True)
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"iquant login failed: {err}") from err
        self._client = client
        return client

    def ticker(self, market: str, code: str) -> dict[str, Any]:
        try:
            snaps = self.snapshot(market, [code])
        except QuoteGatewayError as err:
            if err.code != "NO_DATA":
                raise
            snaps = []
        row = snaps[0] if snaps else None
        if row is not None and float(row.get("last") or 0) > 0:
            return row
        daily = self._last_daily_quote(market, code)
        if daily is None or float(daily.get("last") or 0) <= 0:
            raise QuoteGatewayError("NO_DATA", f"no ticker for {code}.{market}")
        return {
            "symbol": f"{code}.{market}",
            "last": daily["last"],
            "preClose": daily["preClose"],
            "volume": daily["volume"],
            "timestamp": daily["timestamp"],
        }

    def klines(self, market: str, code: str, interval: str, limit: int) -> list[dict[str, Any]]:
        period_ms = 86_400_000 if interval == "1d" else 60_000
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - max(limit, 1) * period_ms * 2
        return self.history_bars(market, code, start_ms, end_ms, limit, period_ms)

    def instruments(self, market: str) -> list[dict[str, Any]]:
        cached = self._names_cache.get(market)
        if cached is not None and time.time() - cached[0] < 600:
            return cached[1]
        client = self._ensure()
        try:
            rows = client.get_instrument_names(market)
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"instrument names failed: {err}") from err
        out = [{"market": market, "code": row.get("code"), "name": row.get("name")} for row in rows]
        self._names_cache[market] = (time.time(), out)
        return out

    def snapshot(self, market: str, symbols: list[str]) -> list[dict[str, Any]]:
        client = self._ensure()
        codes = [str(item).split(".")[0] for item in symbols]
        try:
            sub_id = client.subscribe_symbols(market, codes)
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"subscribe failed: {err}") from err
        collected: dict[str, dict[str, Any]] = {}

        def on_tick(symbol: str, snap: dict[str, Any]) -> None:
            collected[str(symbol)] = snap

        deadline = time.time() + 2.0
        try:
            while time.time() < deadline and len(collected) < len(codes):
                client.drain(on_tick, max_count=64, timeout_ms=200)
        finally:
            try:
                client.unsubscribe(sub_id)
            except Exception:
                pass
        out = []
        for code in codes:
            snap = collected.get(code) or next(iter(collected.values()), None)
            if snap is None:
                continue
            out.append(
                {
                    "symbol": f"{code}.{market}",
                    "last": float(snap.get("last") or 0),
                    "preClose": float(snap.get("pre_close") or snap.get("preClose") or 0),
                    "volume": int(snap.get("volume") or 0),
                    "timestamp": int(snap.get("timestamp_ms") or snap.get("timestamp") or 0),
                }
            )
        if not out:
            raise QuoteGatewayError("NO_DATA", f"no snapshot for {codes} on {market}")
        return out

    def history_bars(
        self,
        market: str,
        symbol: str,
        start_ms: int,
        end_ms: int,
        limit: int,
        period_ms: int = 86_400_000,
        timeout_ms: int = 15_000,
    ) -> list[dict[str, Any]]:
        client = self._ensure()
        code = str(symbol).split(".")[0]
        bars: list[dict[str, Any]] = []

        # QuoteClient 形参名是 symbol/period，实参是 (market, code)。
        # 回调是 (status, tag, bars)，不是单根 bar。
        def on_history(_status: int, _tag: int, rows: list[dict[str, Any]]) -> None:
            if isinstance(rows, list):
                bars.extend(rows)

        req = None
        try:
            req = client.request_history(
                market,
                code,
                start_ms,
                end_ms,
                period_ms,
                3001,
                limit,
                on_history,
            )
            req.wait(timeout_ms=timeout_ms)
        except QuoteGatewayError:
            raise
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"history failed: {err}") from err
        finally:
            closer = getattr(req, "close", None) if req is not None else None
            if callable(closer):
                closer()
        if not bars:
            raise QuoteGatewayError("NO_DATA", f"no history for {code}.{market}")
        return [
            {
                "openTime": int(bar.get("timestamp_ms") or bar.get("timestampMs") or 0),
                "open": float(bar.get("open") or 0),
                "high": float(bar.get("high") or 0),
                "low": float(bar.get("low") or 0),
                "close": float(bar.get("close") or 0),
                "volume": float(bar.get("volume") or 0),
                "closeTime": int(bar.get("timestamp_ms") or bar.get("timestampMs") or 0),
                "timestampMs": int(bar.get("timestamp_ms") or bar.get("timestampMs") or 0),
            }
            for bar in bars[:limit]
        ]

    def option_instruments(self, market: str, underlying: str) -> list[dict[str, Any]]:
        token = (market or "").strip().upper()
        if token in {"SH", "SZ"}:
            token = "SHO" if token == "SH" else "SZO"
        if token not in {"SHO", "SZO"}:
            raise QuoteGatewayError("BAD_REQUEST", f"option instruments require SHO/SZO, got {market!r}")
        needle = underlying.strip()
        as_of = self._as_of or date.today()
        out: list[dict[str, Any]] = []
        for row in self.instruments(token):
            parsed = parse_option_name(str(row.get("name") or ""), market=token, as_of=as_of)
            if parsed is None or parsed.underlying != needle:
                continue
            out.append(
                {
                    "code": parsed.long_code,
                    "shortCode": str(row.get("code") or ""),
                    "optionType": parsed.option_type,
                    "strike": parsed.strike,
                    "expiryMonth": parsed.expiry_month,
                    "expiryDate": parsed.expiry_date,
                    "multiplier": 10000,
                    "underlying": parsed.underlying,
                    "name": row.get("name"),
                }
            )
        return out

    def option_chain(self, market: str, underlying: str, expiry_month: str) -> dict[str, Any]:
        token = (market or "").strip().upper()
        if token in {"SH", "SZ"}:
            token = "SHO" if token == "SH" else "SZO"
        month = (expiry_month or "").strip()
        if len(month) != 4 or not month.isdigit():
            raise QuoteGatewayError("BAD_REQUEST", f"expiryMonth must be YYMM: {expiry_month!r}")
        rows = [
            row
            for row in self.option_instruments(token, underlying)
            if row["expiryMonth"] == month
        ]
        if not rows:
            raise QuoteGatewayError(
                "NO_DATA",
                f"no option contracts for {underlying} {month} on {token}",
            )
        shorts = [row["shortCode"] for row in rows if row["shortCode"]]
        ticks = self._collect_ticks(token, shorts)
        calls: list[dict[str, Any]] = []
        puts: list[dict[str, Any]] = []
        snapshot_ms = 0
        daily_deadline = time.time() + 8.0
        for row in rows:
            quote = ticks.get(row["shortCode"])
            if quote is None and time.time() < daily_deadline:
                quote = self._last_daily_quote(token, row["shortCode"])
            if quote is None:
                quote = {"last": 0.0, "preClose": 0.0, "volume": 0, "timestamp": 0}
            snapshot_ms = max(snapshot_ms, int(quote.get("timestamp") or 0))
            last = float(quote.get("last") or 0)
            pre_close = float(quote.get("preClose") or 0)
            item = {
                "code": row["code"],
                "strike": row["strike"],
                "last": last,
                "preClose": pre_close,
                "volume": int(quote.get("volume") or 0),
            }
            if pre_close:
                item["changePct"] = round((last - pre_close) / pre_close * 100.0, 4)
            (calls if row["optionType"] == "C" else puts).append(item)
        if snapshot_ms > 0:
            snapshot_at = datetime.fromtimestamp(snapshot_ms / 1000, tz=CST).isoformat()
        else:
            snapshot_at = datetime.now(tz=CST).replace(microsecond=0).isoformat()
        return {
            "expiryDate": rows[0]["expiryDate"],
            "snapshotAt": snapshot_at,
            "calls": sorted(calls, key=lambda item: item["strike"]),
            "puts": sorted(puts, key=lambda item: item["strike"]),
        }

    def _collect_ticks(self, market: str, codes: list[str]) -> dict[str, dict[str, Any]]:
        if not codes:
            return {}
        client = self._ensure()
        try:
            sub_id = client.subscribe_symbols(market, codes)
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"subscribe failed: {err}") from err
        collected: dict[str, dict[str, Any]] = {}

        def on_tick(symbol: str, snap: dict[str, Any]) -> None:
            collected[str(symbol)] = snap

        deadline = time.time() + 2.0
        try:
            while time.time() < deadline and len(collected) < len(codes):
                client.drain(on_tick, max_count=64, timeout_ms=200)
        finally:
            try:
                client.unsubscribe(sub_id)
            except Exception:
                pass
        out: dict[str, dict[str, Any]] = {}
        for code in codes:
            snap = collected.get(code)
            if snap is None:
                continue
            out[code] = {
                "last": float(snap.get("last") or 0),
                "preClose": float(snap.get("pre_close") or snap.get("preClose") or 0),
                "volume": int(snap.get("volume") or 0),
                "timestamp": int(snap.get("timestamp_ms") or snap.get("timestamp") or 0),
            }
        return out

    def _last_daily_quote(self, market: str, code: str) -> dict[str, Any] | None:
        if not code:
            return None
        cached = self._daily_cache.get((market, code))
        if cached is not None:
            return cached
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - 14 * DAY_MS
        try:
            bars = self.history_bars(market, code, start_ms, end_ms, 8, timeout_ms=3_000)
        except QuoteGatewayError:
            return None
        if not bars:
            return None
        last = bars[-1]
        prev = bars[-2] if len(bars) > 1 else last
        quote = {
            "last": float(last.get("close") or 0),
            "preClose": float(prev.get("close") or 0),
            "volume": int(last.get("volume") or 0),
            "timestamp": int(last.get("closeTime") or last.get("timestampMs") or 0),
        }
        self._daily_cache[(market, code)] = quote
        return quote

