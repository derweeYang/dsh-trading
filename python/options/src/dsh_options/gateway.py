"""常驻 HTTP 网关：把 dsh-options 子命令暴露为 POST /v1/<subcommand>。

本仓 T 板要轮询，不能每次 uv run 拉进程。默认 127.0.0.1:8090。
请求体 = 内核 JSON 文档；响应 = {ok, result|error}。
"""

from __future__ import annotations

import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from dsh_options.cli import HANDLERS
from dsh_options.protocol import OptionsError, encode_response

HOST = os.environ.get("DSH_OPTIONS_GATEWAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("DSH_OPTIONS_GATEWAY_PORT", "8090"))
DEFAULT_CACHE_DIR = os.environ.get(
    "DSH_OPTIONS_CACHE_DIR",
    os.path.join(tempfile.gettempdir(), "dsh-options-cache"),
)


class OptionsGatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(200, {"ok": True, "service": "dsh-options-gateway"})
            return
        self._send(404, encode_response(False, {"code": "BAD_REQUEST", "message": f"unknown path {path}"}))

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        prefix = "/v1/"
        if not path.startswith(prefix):
            self._send(404, encode_response(False, {"code": "BAD_REQUEST", "message": f"unknown path {path}"}))
            return
        command = path[len(prefix) :].strip("/")
        handler = HANDLERS.get(command)
        if handler is None:
            self._send(400, encode_response(False, {"code": "BAD_REQUEST", "message": f"unknown subcommand {command!r}"}))
            return
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            request = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as err:
            self._send(400, encode_response(False, {"code": "BAD_REQUEST", "message": f"request is not valid JSON: {err}"}))
            return
        if not isinstance(request, dict):
            self._send(400, encode_response(False, {"code": "BAD_REQUEST", "message": "request must be a JSON object"}))
            return
        request.setdefault("cacheDir", DEFAULT_CACHE_DIR)
        os.makedirs(str(request["cacheDir"]), exist_ok=True)
        try:
            result = handler(request)
        except OptionsError as err:
            status = 400 if err.code == "BAD_REQUEST" else 200
            self._send(status, encode_response(False, {"code": err.code, "message": err.message}))
            return
        except Exception as err:  # noqa: BLE001 — 网关边界收口为 INTERNAL
            self._send(500, encode_response(False, {"code": "INTERNAL", "message": str(err)}))
            return
        self._send(200, encode_response(True, result))

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), OptionsGatewayHandler)
    print(f"dsh-options gateway http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
