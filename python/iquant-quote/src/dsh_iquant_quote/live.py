from __future__ import annotations

import os
import sys
import time
from typing import Any

from dsh_iquant_quote.errors import QuoteGatewayError

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
        snaps = self.snapshot(market, [code])
        if not snaps:
            raise QuoteGatewayError("NO_DATA", f"no ticker for {code}.{market}")
        return snaps[0]

    def klines(self, market: str, code: str, interval: str, limit: int) -> list[dict[str, Any]]:
        period_ms = 86_400_000 if interval == "1d" else 60_000
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - max(limit, 1) * period_ms * 2
        return self.history_bars(market, code, start_ms, end_ms, limit, period_ms)

    def instruments(self, market: str) -> list[dict[str, Any]]:
        client = self._ensure()
        try:
            rows = client.get_instrument_names(market)
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError("NETWORK", f"instrument names failed: {err}") from err
        return [{"market": market, "code": row.get("code"), "name": row.get("name")} for row in rows]

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
            req.wait(timeout_ms=15_000)
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

    def option_chain(self, market: str, underlying: str, expiry_month: str) -> dict[str, Any]:
        raise QuoteGatewayError(
            "NO_DATA",
            f"option_chain assembly is not implemented in the quote gateway; use instruments + ticks ({market} {underlying} {expiry_month})",
        )

    def option_instruments(self, market: str, underlying: str) -> list[dict[str, Any]]:
        rows = self.instruments(market)
        needle = underlying.strip()
        return [row for row in rows if needle in str(row.get("name") or "") or needle in str(row.get("code") or "")]
