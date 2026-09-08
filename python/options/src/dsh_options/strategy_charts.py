"""期权策略到期损益与 sticky-strike Greeks PNG 图。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from dsh_options.protocol import OptionsError

CHART_KINDS = ("payoff", "greeks")


def write_strategy_charts(
    *,
    viz_dir: Path,
    underlying: str,
    stamp: str,
    payoff: list[dict[str, float]],
    greeks_curve: list[dict[str, float]],
    kinds: tuple[str, ...],
) -> list[dict[str, Any]]:
    """按种类写策略 PNG，并返回 ``charts[]`` 行。"""
    try:
        dest = viz_dir / underlying / stamp
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as err:
        raise OptionsError("BAD_REQUEST", f"vizDir is not a writable directory: {err}") from err

    rows: list[dict[str, Any]] = []
    if "payoff" in kinds:
        rows.append(_write_payoff(dest, underlying, stamp, payoff))
    if "greeks" in kinds:
        rows.append(_write_greeks(dest, underlying, stamp, greeks_curve))
    return rows


def _write_payoff(
    dest: Path,
    underlying: str,
    stamp: str,
    payoff: list[dict[str, float]],
) -> dict[str, Any]:
    title = f"{underlying} expiry payoff {stamp}"
    if not payoff:
        return {"kind": "payoff", "status": "insufficient", "title": title}
    path = dest / "payoff.png"
    plt = _pyplot()
    fig, ax = plt.subplots(figsize=(7.0, 4.0))
    ax.plot(
        [float(row["spot"]) for row in payoff],
        [float(row["pnl"]) for row in payoff],
        label="P&L",
    )
    ax.axhline(0.0, color="black", linewidth=0.8)
    ax.set_title(title)
    ax.set_xlabel("underlying at expiry")
    ax.set_ylabel("P&L")
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return {"kind": "payoff", "status": "ok", "title": title, "path": str(path)}


def _write_greeks(
    dest: Path,
    underlying: str,
    stamp: str,
    curve: list[dict[str, float]],
) -> dict[str, Any]:
    title = f"{underlying} sticky-strike Greeks {stamp}"
    if not curve:
        return {"kind": "greeks", "status": "insufficient", "title": title}
    path = dest / "greeks.png"
    spots = [float(row["spot"]) for row in curve]
    plt = _pyplot()
    fig, (delta_ax, gamma_ax) = plt.subplots(2, 1, sharex=True, figsize=(7.0, 5.5))
    delta_ax.plot(spots, [float(row["delta"]) for row in curve], label="net delta")
    gamma_ax.plot(spots, [float(row["gamma"]) for row in curve], label="net gamma")
    delta_ax.set_title(title)
    delta_ax.set_ylabel("delta")
    gamma_ax.set_xlabel("underlying spot")
    gamma_ax.set_ylabel("gamma")
    delta_ax.legend()
    gamma_ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return {"kind": "greeks", "status": "ok", "title": title, "path": str(path)}


def _pyplot():
    """导入 pyplot 前锁定 Agg;缺库按 INTERNAL 失败。"""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as err:
        raise OptionsError("INTERNAL", "matplotlib is required to write strategy charts") from err
    return plt
