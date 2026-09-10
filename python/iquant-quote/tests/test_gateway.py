"""网关层：客户端先断开只记一行、慢请求记一行、快请求保持安静。"""

from __future__ import annotations

import json
import socket
import struct
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from dsh_iquant_quote import gateway


class _StubService:
    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.started = threading.Event()

    def handle_command(self, command: str, body: dict) -> dict:
        self.started.set()
        time.sleep(self.delay)
        return {"command": command}


@pytest.fixture()
def serve(monkeypatch):
    servers = []

    def start(service: _StubService) -> int:
        monkeypatch.setattr(gateway, "SERVICE", service)
        server = ThreadingHTTPServer(("127.0.0.1", 0), gateway.Handler)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server.server_address[1]

    yield start

    for server in servers:
        server.shutdown()
        server.server_close()


def _wait_line(capsys, needle: str, timeout_s: float = 5.0) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        out = capsys.readouterr().out
        if needle in out:
            return out
        time.sleep(0.02)
    pytest.fail(f"gateway log line {needle!r} not seen")


def _post_bytes(port: int, path: str) -> bytes:
    body = b"{}"
    head = (
        f"POST {path} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    return head + body


def _rst_close(sock: socket.socket) -> None:
    """RST 断开，模拟 urllib 30s 超时后的硬断开。"""
    for fmt in ("ii", "hh"):  # Windows linger 是 u_short 对，POSIX 是 int 对
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack(fmt, 1, 0))
            break
        except OSError:
            continue
    sock.close()


def test_client_gone_logs_single_line(serve, capsys):
    service = _StubService(delay=0.5)
    port = serve(service)
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.sendall(_post_bytes(port, "/v1/snapshot"))
    # 等服务端读完请求体进入 handle_command 再断开，确保断在"写响应"而非"读请求"
    assert service.started.wait(5), "server never entered handle_command"
    _rst_close(sock)
    out = _wait_line(capsys, "client-gone POST /v1/snapshot")
    assert out.count("client-gone") == 1
    time.sleep(0.2)  # 断开路径在 _send 内消化，不应走到 handle_error 打 traceback
    assert "Traceback" not in capsys.readouterr().err


def test_slow_request_logs_duration(serve, monkeypatch, capsys):
    monkeypatch.setattr(gateway, "SLOW_LOG_S", 0.05)
    port = serve(_StubService(delay=0.15))
    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/v1/snapshot", data=b"{}", timeout=5
    ) as resp:
        assert json.loads(resp.read())["ok"] is True
    _wait_line(capsys, "slow POST /v1/snapshot")


def test_fast_request_stays_silent(serve, capsys):
    port = serve(_StubService(delay=0.0))
    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/v1/snapshot", data=b"{}", timeout=5
    ) as resp:
        assert json.loads(resp.read())["ok"] is True
    time.sleep(0.1)
    captured = capsys.readouterr()
    assert captured.out == ""
