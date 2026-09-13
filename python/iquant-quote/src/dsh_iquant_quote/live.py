from __future__ import annotations

import os
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.option_names import parse_option_name

CST = timezone(timedelta(hours=8))
DAY_MS = 86_400_000

#: A 股现货/期权市场 token。HK 交易时段不同，不做窗口短路。
CN_LIVE_MARKETS = {"SH", "SZ", "BJ", "SHO", "SZO"}


def trading_window_open(moment: datetime | None = None) -> bool:
    """A 股现货/ETF 期权可能产生新 tick 的时段：工作日 9:15–15:05（保守含集合竞价与收盘缓冲）。

    窗口外必然无新行情，ticker/chain 直接走日 K 回落，省掉每次 2s 的 drain 死等；
    节假日落在窗口内时仍走原 drain 路径，行为不变。
    """
    now = moment or datetime.now(tz=CST)
    if now.weekday() >= 5:
        return False
    minute_of_day = now.hour * 60 + now.minute
    return 9 * 60 + 15 <= minute_of_day <= 15 * 60 + 5


#: 分钟级 K 线最新一根落后"应有位置"超过该值即判停更（吸收跨分钟边界与收盘差 1 根的误差）。
KLINE_STALE_MS = 3 * 60_000


def expected_latest_open_ms(moment: datetime) -> int | None:
    """按 A 股交易时段推算"此刻应已存在的最新 1 分钟 bar"的 open 时间（毫秒）。

    返回 None 表示无法预期（周末、09:31 第一根之前），调用方跳过新鲜度校验；
    午休回指 11:30、收盘后回指 15:00，与真实最后一根差 1 分钟以内由 KLINE_STALE_MS 吸收。
    工作日节假日返回非 None，届时历史 1m 只会停在上个交易日 → 会被判停更（fail loud）。
    """
    if moment.weekday() >= 5:
        return None
    minute_of_day = moment.hour * 60 + moment.minute
    if minute_of_day < 9 * 60 + 31:
        return None
    if minute_of_day > 15 * 60:
        minute_of_day = 15 * 60
    elif 11 * 60 + 30 < minute_of_day < 13 * 60 + 1:
        minute_of_day = 11 * 60 + 30
    midnight = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return int((midnight + timedelta(minutes=minute_of_day)).timestamp() * 1000)


def fourth_wednesday(year: int, month: int) -> date:
    """该月第四个周三（沪深 ETF 期权行权日）；与 connector-options expiryDateOf 同口径。"""
    import calendar

    wednesdays = [
        day
        for day in range(1, calendar.monthrange(year, month)[1] + 1)
        if date(year, month, day).weekday() == 2
    ]
    return date(year, month, wednesdays[3])


def seasonal_focus_months(now: datetime | None = None) -> list[str]:
    """当月、次月中未过行权日的 YYMM（对齐 bridge seasonalExpiryMonths()[0..1]）。

    当月第四个周三已过 → 链已摘牌，跳过（预热摘牌月只会 NO_DATA）。
    """
    moment = now or datetime.now(tz=CST)
    out: list[str] = []
    for step in (0, 1):
        total = moment.year * 12 + (moment.month - 1) + step
        year, month_zero = divmod(total, 12)
        month = month_zero + 1
        if fourth_wednesday(year, month) < moment.date():
            continue
        out.append(f"{year % 100:02d}{month:02d}")
    return out


def focus_chain_rows(
    rows: list[dict[str, Any]], spot: float, strikes: int
) -> list[dict[str, Any]]:
    """只留距 spot 最近的 strikes 个行权价档（C/P 成对保留）；并列时低价优先。"""
    by_strike = sorted({float(row["strike"]) for row in rows})
    keep = set(sorted(by_strike, key=lambda s: (abs(s - spot), s))[: max(strikes, 1)])
    return [row for row in rows if float(row["strike"]) in keep]


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
        # 日 K 回落缓存：(cached_at 墙钟秒, quote)。盘中 60s 过期，窗口外当日复用。
        self._daily_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._klines_cache: dict[
            tuple[str, str, str, int], tuple[date, list[dict[str, Any]]]
        ] = {}
        # 时钟可注入：测试钉在盘内/盘后，避免真实时段决定 drain 行为。
        self._now: Callable[[], datetime] = lambda: datetime.now(tz=CST)
        self._login_lock = threading.Lock()

    def _ensure(self):
        if self._client is not None:
            return self._client
        # 预热线程与请求线程可能同时冷启动，双重 login 会泄漏客户端实例。
        with self._login_lock:
            if self._client is not None:
                return self._client
            paths = resolve_paths()
            for key in ("api_dll", "qmtquote", "config"):
                if not os.path.isfile(paths[key]):
                    raise QuoteGatewayError(
                        "NETWORK", f"iquant path missing: {paths[key]}"
                    )
            sdk_python = os.path.join(paths["sdk"], "python")
            if sdk_python not in sys.path:
                sys.path.insert(0, sdk_python)
            os.chdir(paths["bin_dir"])
            try:
                from iquant.quote import QuoteClient
            except Exception as err:  # noqa: BLE001
                raise QuoteGatewayError(
                    "NETWORK", f"cannot import iquant.quote: {err}"
                ) from err
            client = QuoteClient(paths["api_dll"], paths["qmtquote"], paths["config"])
            try:
                client.login(allow_network_login=True)
            except Exception as err:  # noqa: BLE001
                raise QuoteGatewayError(
                    "NETWORK", f"iquant login failed: {err}"
                ) from err
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

    def klines(
        self, market: str, code: str, interval: str, limit: int
    ) -> list[dict[str, Any]]:
        # 盘后同一自然日内日 K 不再变化，直接复用，盘后轮询不再每次打 SDK；
        # 盘中不复用，保留当日未收盘 bar 的实时性。
        key = (market, code, interval, limit)
        today = self._now().date()
        cached = self._klines_cache.get(key)
        if (
            cached is not None
            and cached[0] == today
            and not trading_window_open(self._now())
        ):
            return cached[1]
        period_ms = 86_400_000 if interval == "1d" else 60_000
        end_ms = int(self._now().timestamp() * 1000)
        start_ms = end_ms - max(limit, 1) * period_ms * 2
        bars = self.history_bars(market, code, start_ms, end_ms, limit, period_ms)
        if period_ms < DAY_MS:
            # 厂商本地历史库可能盘中停更（2026-09-11 510050 停在 10:30），
            # 停更数组整仓透传会把下游箱体钉死，陈旧数据宁可报错也不放行、更不回写缓存。
            self._assert_klines_fresh(bars, end_ms, market, code)
        self._klines_cache[key] = (today, bars)
        return bars

    def _assert_klines_fresh(
        self,
        bars: list[dict[str, Any]],
        end_ms: int,
        market: str,
        code: str,
    ) -> None:
        expected = expected_latest_open_ms(
            datetime.fromtimestamp(end_ms / 1000, tz=CST)
        )
        if expected is None:
            return
        latest = max((int(bar.get("openTime") or 0) for bar in bars), default=0)
        if latest and expected - latest > KLINE_STALE_MS:
            stalled_at = datetime.fromtimestamp(latest / 1000, tz=CST).isoformat()
            raise QuoteGatewayError(
                "STALE_DATA",
                f"klines for {code}.{market} stalled at {stalled_at}"
                f" ({(expected - latest) // 60_000} min behind)",
            )

    def instruments(self, market: str) -> list[dict[str, Any]]:
        cached = self._names_cache.get(market)
        if cached is not None and time.time() - cached[0] < 600:
            return cached[1]
        client = self._ensure()
        try:
            rows = client.get_instrument_names(market)
        except Exception as err:  # noqa: BLE001
            raise QuoteGatewayError(
                "NETWORK", f"instrument names failed: {err}"
            ) from err
        out = [
            {"market": market, "code": row.get("code"), "name": row.get("name")}
            for row in rows
        ]
        self._names_cache[market] = (time.time(), out)
        return out

    def snapshot(self, market: str, symbols: list[str]) -> list[dict[str, Any]]:
        if (market or "").upper() in CN_LIVE_MARKETS and not trading_window_open(
            self._now()
        ):
            raise QuoteGatewayError("NO_DATA", f"{market} outside trading window")
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
            # 只认本 code 的 tick：drain 队列是 SDK 进程级共享，并发请求会互灌
            # 别的标的/合约的 tick，跨标的回退曾把 510300 的价塞给 510050（2026-09-11）。
            snap = collected.get(code)
            if snap is None:
                continue
            out.append(
                {
                    "symbol": f"{code}.{market}",
                    "last": float(snap.get("last") or 0),
                    "preClose": float(
                        snap.get("pre_close") or snap.get("preClose") or 0
                    ),
                    "volume": int(snap.get("volume") or 0),
                    "timestamp": int(
                        snap.get("timestamp_ms") or snap.get("timestamp") or 0
                    ),
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
            status = req.wait(timeout_ms=timeout_ms)
            if status != 0:
                # 8/9=超时/取消等非完成态，bars 可能只有部分交付；留现场供停更排查。
                print(
                    f"[gateway] history wait status={status} bars={len(bars)}"
                    f" {code}.{market}",
                    flush=True,
                )
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
                "closeTime": int(
                    bar.get("timestamp_ms") or bar.get("timestampMs") or 0
                ),
                "timestampMs": int(
                    bar.get("timestamp_ms") or bar.get("timestampMs") or 0
                ),
            }
            for bar in bars[:limit]
        ]

    def option_instruments(self, market: str, underlying: str) -> list[dict[str, Any]]:
        token = (market or "").strip().upper()
        if token in {"SH", "SZ"}:
            token = "SHO" if token == "SH" else "SZO"
        if token not in {"SHO", "SZO"}:
            raise QuoteGatewayError(
                "BAD_REQUEST", f"option instruments require SHO/SZO, got {market!r}"
            )
        needle = underlying.strip()
        as_of = self._as_of or date.today()
        out: list[dict[str, Any]] = []
        for row in self.instruments(token):
            parsed = parse_option_name(
                str(row.get("name") or ""), market=token, as_of=as_of
            )
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

    def option_chain(
        self,
        market: str,
        underlying: str,
        expiry_month: str,
        atm_focus: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = (market or "").strip().upper()
        if token in {"SH", "SZ"}:
            token = "SHO" if token == "SH" else "SZO"
        month = (expiry_month or "").strip()
        if len(month) != 4 or not month.isdigit():
            raise QuoteGatewayError(
                "BAD_REQUEST", f"expiryMonth must be YYMM: {expiry_month!r}"
            )
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
        # ATM 焦点收窄：IV 路径只需要 ATM 附近档位，整链逐合约日 K 回落是首屏
        # 8s+ 的来源（2026-09-11 overview 慢诊断）；T 板不传 atm_focus，仍全链。
        if atm_focus is not None:
            rows = focus_chain_rows(
                rows, float(atm_focus["spot"]), int(atm_focus["strikes"])
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
            # 买一/卖一（全推快照五档第一档）。0 = 无盘（停牌/回落日 K），缺省键，
            # 下游套利扫描据此退回 last 近似（executable=false）。
            bid = float(quote.get("bid") or 0)
            ask = float(quote.get("ask") or 0)
            if bid > 0:
                item["bid"] = bid
            if ask > 0:
                item["ask"] = ask
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

    def _collect_ticks(
        self, market: str, codes: list[str]
    ) -> dict[str, dict[str, Any]]:
        if not codes:
            return {}
        if (market or "").upper() in CN_LIVE_MARKETS and not trading_window_open(
            self._now()
        ):
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
                "timestamp": int(
                    snap.get("timestamp_ms") or snap.get("timestamp") or 0
                ),
            }
            # 五档数组第一档（iquant SDK snapshot_to_dict 的 ask/bid）；0 = 无盘不落键。
            levels = snap.get("ask")
            if (
                isinstance(levels, (list, tuple))
                and len(levels) > 0
                and float(levels[0]) > 0
            ):
                out[code]["ask"] = float(levels[0])
            levels = snap.get("bid")
            if (
                isinstance(levels, (list, tuple))
                and len(levels) > 0
                and float(levels[0]) > 0
            ):
                out[code]["bid"] = float(levels[0])
        return out

    def _last_daily_quote(self, market: str, code: str) -> dict[str, Any] | None:
        if not code:
            return None
        cached = self._daily_cache.get((market, code))
        if cached is not None:
            cached_at, quote = cached
            # 盘中 60s 过期：曾有 tick 失败回退把早间日 K close 钉死全天（2026-09-11
            # 510050 last 停在 3.017）；窗口外当日日 K 不变，直接复用。
            if not trading_window_open(self._now()) or time.time() - cached_at < 60.0:
                return quote
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - 14 * DAY_MS
        try:
            bars = self.history_bars(
                market, code, start_ms, end_ms, 8, timeout_ms=3_000
            )
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
        self._daily_cache[(market, code)] = (time.time(), quote)
        return quote
