"""常驻 HTTP 网关：国信 iQuant 只行情。默认 127.0.0.1:5810。"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.live import LiveBackend
from dsh_iquant_quote.service import QuoteService

HOST = os.environ.get("IQUANT_QUOTE_GATEWAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("IQUANT_QUOTE_GATEWAY_PORT", "5810"))
SERVICE = QuoteService(LiveBackend())
#: 客户端先超时/取消断开后,写响应会抛这类连接错误;只记一行,不打 traceback。
CLIENT_GONE = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)
#: 请求耗时超过该秒数记一行慢日志(休市 ticker 恒 ~2s 即触发),用于定位慢 command。
SLOW_LOG_S = 1.0


def encode(ok: bool, payload: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "result": payload} if ok else {"ok": False, "error": payload}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def handle_one_request(self) -> None:
        self._started = time.monotonic()
        super().handle_one_request()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = {
            key: values[0] for key, values in parse_qs(parsed.query).items() if values
        }
        if path in ("/health", "/"):
            self._send(200, {"ok": True, "service": "dsh-iquant-quote-gateway"})
            return
        try:
            if path == "/v1/ticker":
                self._send(200, encode(True, SERVICE.ticker(query.get("symbol", ""))))
                return
            if path == "/v1/klines":
                self._send(
                    200,
                    encode(
                        True,
                        SERVICE.klines(
                            query.get("symbol", ""),
                            query.get("interval", "1d"),
                            int(query.get("limit") or 100),
                        ),
                    ),
                )
                return
            if path == "/v1/instruments":
                self._send(
                    200, encode(True, SERVICE.instruments(query.get("market", "")))
                )
                return
        except QuoteGatewayError as err:
            status = 400 if err.code == "BAD_REQUEST" else 200
            self._send(
                status, encode(False, {"code": err.code, "message": err.message})
            )
            return
        self._send(
            404,
            encode(False, {"code": "BAD_REQUEST", "message": f"unknown path {path}"}),
        )

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        prefix = "/v1/"
        if not path.startswith(prefix):
            self._send(
                404,
                encode(
                    False, {"code": "BAD_REQUEST", "message": f"unknown path {path}"}
                ),
            )
            return
        command = path[len(prefix) :].strip("/")
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as err:
            self._send(
                400,
                encode(
                    False, {"code": "BAD_REQUEST", "message": f"invalid JSON: {err}"}
                ),
            )
            return
        if not isinstance(body, dict):
            self._send(
                400,
                encode(
                    False,
                    {"code": "BAD_REQUEST", "message": "request must be an object"},
                ),
            )
            return
        try:
            result = SERVICE.handle_command(command, body)
        except QuoteGatewayError as err:
            status = 400 if err.code == "BAD_REQUEST" else 200
            self._send(
                status, encode(False, {"code": err.code, "message": err.message})
            )
            return
        except Exception as err:  # noqa: BLE001
            self._send(500, encode(False, {"code": "INTERNAL", "message": str(err)}))
            return
        self._send(200, encode(True, result))

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except CLIENT_GONE:
            # 客户端已先断开(常见:上游 30s 超时),响应无处可写,只记一行。
            self.close_connection = True
            self._log_line("client-gone")
            return
        if time.monotonic() - self._started >= SLOW_LOG_S:
            self._log_line("slow")

    def _log_line(self, tag: str) -> None:
        elapsed = time.monotonic() - self._started
        print(f"[gateway] {tag} {self.command} {self.path} {elapsed:.2f}s", flush=True)


class GatewayServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        err = sys.exc_info()[1]
        if isinstance(err, CLIENT_GONE):
            return  # 读请求体/keep-alive 阶段客户端断开,同样不打 traceback。
        super().handle_error(request, client_address)


def preheat_symbols() -> list[str]:
    """预热标的清单：默认页面轮询的 ETF 自选，可用环境变量覆盖。"""
    raw = os.environ.get(
        "IQUANT_QUOTE_PREHEAT_SYMBOLS",
        "510050.SH,510300.SH,588000.SH,588080.SH,159901.SZ,159915.SZ,159919.SZ",
    )
    return [item.strip() for item in raw.split(",") if item.strip()]


def preheat() -> None:
    """后台预热：login + SHO/SZO 合约表 + 常用标的 ticker/1m K 缓存。

    尽力而为：任一步失败只记一行；跑在 daemon 线程，health 不等它。
    """
    started = time.monotonic()
    for market in ("SHO", "SZO"):
        try:
            SERVICE.instruments(market)
        except Exception as err:  # noqa: BLE001
            print(f"[preheat] instruments {market} failed: {err}", flush=True)
    for symbol in preheat_symbols():
        try:
            SERVICE.ticker(symbol)
            SERVICE.klines(symbol, "1m", 60)
            print(f"[preheat] {symbol} ok", flush=True)
        except Exception as err:  # noqa: BLE001
            print(f"[preheat] {symbol} failed: {err}", flush=True)
    print(f"[preheat] done in {time.monotonic() - started:.1f}s", flush=True)


def main() -> None:
    server = GatewayServer((HOST, PORT), Handler)
    print(f"dsh-iquant-quote-gateway http://{HOST}:{PORT}", flush=True)
    threading.Thread(target=preheat, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
