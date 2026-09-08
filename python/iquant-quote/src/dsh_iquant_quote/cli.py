from __future__ import annotations

import json
import sys

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.gateway import SERVICE, encode


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print(json.dumps(encode(False, {"code": "BAD_REQUEST", "message": "missing subcommand"}), ensure_ascii=False))
        return 2
    command = args[0]
    raw = sys.stdin.read() if not sys.stdin.isatty() else "{}"
    try:
        body = json.loads(raw or "{}")
    except json.JSONDecodeError as err:
        print(json.dumps(encode(False, {"code": "BAD_REQUEST", "message": str(err)}), ensure_ascii=False))
        return 2
    if not isinstance(body, dict):
        print(json.dumps(encode(False, {"code": "BAD_REQUEST", "message": "stdin must be an object"}), ensure_ascii=False))
        return 2
    try:
        result = SERVICE.handle_command(command, body)
    except QuoteGatewayError as err:
        print(json.dumps(encode(False, {"code": err.code, "message": err.message}), ensure_ascii=False))
        return 1
    print(json.dumps(encode(True, result), ensure_ascii=False))
    return 0
