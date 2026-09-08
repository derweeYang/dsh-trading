# 子进程边界协议:请求/响应的编码、错误分类与分发框架。
#
# TS 侧(tool-options,O3)只信 stdout 的 JSON 文档;退出码是给人看的冗余信号。
# 与 dsh_quant.protocol 同款契约,独立维护(DO1:内核分立)。

import json
import sys
from typing import Any, Callable

# 错误码 → 进程退出码。BAD_REQUEST/NO_DATA/NETWORK 是领域性结果,INTERNAL 是缺陷。
EXIT_CODES = {"BAD_REQUEST": 2, "NO_DATA": 3, "NETWORK": 3, "INTERNAL": 4}


class OptionsError(Exception):
    """领域性失败,映射为 ``{ok: false, error: {code, message}}`` 响应。

    Parameters
    ----------
    code : str
        ``BAD_REQUEST`` | ``NO_DATA`` | ``NETWORK`` | ``INTERNAL`` 之一。
    message : str
        面向模型的可读错误说明。
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def encode_response(ok: bool, payload: dict[str, Any]) -> dict[str, Any]:
    """包装子命令的裸负载为 wire 响应文档。

    Parameters
    ----------
    ok : bool
        True 时 payload 是 result,False 时 payload 是 error 文档。
    payload : dict
        子命令结果,或 ``{"code": ..., "message": ...}``。

    Returns
    -------
    dict[str, Any]
        ``{ok: true, result: ...}`` 或 ``{ok: false, error: ...}``。
    """
    key = "result" if ok else "error"
    return {"ok": ok, key: payload}


def run_cli(
    subcommand: str,
    handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]],
) -> int:
    """读 stdin JSON 请求,分发给 argv 指定的子命令处理器,写一行 JSON 到 stdout。

    Parameters
    ----------
    subcommand : str
        argv 上的子命令名;不在 handlers 中按 BAD_REQUEST 处理。
    handlers : dict
        子命令名 → 处理器(请求 dict → 结果 dict)。

    Returns
    -------
    int
        进程退出码(0 成功,其余按 :data:`EXIT_CODES`)。
    """
    raw = sys.stdin.read()
    try:
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as err:
            raise OptionsError("BAD_REQUEST", f"request is not valid JSON: {err}") from err
        if not isinstance(request, dict):
            raise OptionsError("BAD_REQUEST", "request must be a JSON object")
        handler = handlers.get(subcommand)
        if handler is None:
            raise OptionsError("BAD_REQUEST", f"unknown subcommand: {subcommand!r}")
        result = handler(request)
    except OptionsError as err:
        _emit(encode_response(False, {"code": err.code, "message": err.message}))
        return EXIT_CODES[err.code]
    except Exception as err:  # noqa: BLE001 - 边界处统一兜底为 INTERNAL
        _emit(encode_response(False, {"code": "INTERNAL", "message": str(err)}))
        return EXIT_CODES["INTERNAL"]
    _emit(encode_response(True, result))
    return 0


def _emit(response: dict[str, Any]) -> None:
    """写恰好一行 JSON 到 stdout 并刷新(批式管道下必须显式 flush)。"""
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()
