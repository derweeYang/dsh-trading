# CLI 契约:进程内分发(子命令 BAD_REQUEST + synth 端到端)与子进程 wire 一行 JSON。

import io
import json
import subprocess
import sys

import pytest

from dsh_options.cli import HANDLERS, main


def _run(subcommand: str, request: object, capsys) -> tuple[int, dict]:
    """进程内走 run_cli:stdin 喂请求,捕获 stdout 的一行 JSON。"""
    stdin = sys.stdin
    sys.stdin = io.StringIO(json.dumps(request))
    try:
        code = main([subcommand])
    finally:
        sys.stdin = stdin
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1, "stdout must be exactly one line"
    return code, json.loads(lines[0])


def test_cli_subcommands_are_registered():
    assert sorted(HANDLERS) == [
        "chain",
        "contracts",
        "fetch_daily",
        "fetch_underlying_daily",
        "implied_vol",
        "parity_check",
        "price",
        "strategy",
        "underlyings",
        "vol_analytics",
    ]


def test_cli_chain_synth_end_to_end(capsys):
    code, response = _run(
        "chain",
        {"source": "synth", "underlying": "910050", "expiryMonth": "2609"},
        capsys,
    )
    assert code == 0 and response["ok"] is True
    assert response["result"]["expiryMonth"] == "2609"
    assert len(response["result"]["calls"]) > 0


def test_cli_underlyings_needs_no_cachedir(capsys):
    code, response = _run("underlyings", {"source": "akshare"}, capsys)
    assert code == 0 and response["ok"] is True
    assert response["result"]["rows"] >= 7


@pytest.mark.parametrize(
    ("subcommand", "req"),
    [
        ("underlyings", {}),
        ("underlyings", {"source": "bogus"}),
        ("contracts", {"source": "synth"}),  # 缺 cacheDir
        ("chain", {"source": "synth", "underlying": "910050"}),  # 缺 expiryMonth
        ("fetch_daily", {"source": "synth", "cacheDir": "."}),  # 缺 contract
        ("fetch_underlying_daily", {"source": "akshare"}),  # 缺 cacheDir
        ("vol_analytics", {"source": "synth", "underlying": "910050"}),  # 缺 cacheDir
        ("strategy", {"source": "synth", "underlying": "910050"}),  # 缺 cacheDir
    ],
)
def test_cli_bad_requests_exit_2(subcommand, req, capsys):
    code, response = _run(subcommand, req, capsys)
    assert code == 2
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"


def test_cli_invalid_json_is_bad_request(capsys, monkeypatch):
    stdin = sys.stdin
    sys.stdin = io.StringIO("not json")
    try:
        code = main(["underlyings"])
    finally:
        sys.stdin = stdin
    lines = capsys.readouterr().out.splitlines()
    assert code == 2
    assert json.loads(lines[0])["error"]["code"] == "BAD_REQUEST"


def test_cli_subprocess_wire_contract(tmp_path):
    """子进程边界:stdin JSON → stdout 恰好一行 {ok,...};BAD_REQUEST 退出码 2。"""
    request = json.dumps({"source": "synth", "underlying": "910050", "expiryMonth": "2612"})
    ok_run = subprocess.run(
        [sys.executable, "-m", "dsh_options.cli", "chain"],
        input=request,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert ok_run.returncode == 0, ok_run.stderr
    assert len(ok_run.stdout.strip().splitlines()) == 1
    payload = json.loads(ok_run.stdout)
    assert payload["ok"] is True and payload["result"]["expiryMonth"] == "2612"

    bad_run = subprocess.run(
        [sys.executable, "-m", "dsh_options.cli", "chain"],
        input=json.dumps({"source": "synth"}),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert bad_run.returncode == 2
    assert json.loads(bad_run.stdout)["error"]["code"] == "BAD_REQUEST"
