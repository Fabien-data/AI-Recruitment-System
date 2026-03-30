"""Generate go-live evidence report from gate and canary artifacts."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def read_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def normalize_canary(canary: dict | None) -> dict | None:
    if not canary:
        return None
    if "error_rate_pct" in canary and "p95_ms" in canary:
        return canary

    # Fallback schema from load_webhook_latency.py
    requests = int(canary.get("requests", 0) or 0)
    fail = int(canary.get("fail", 0) or 0)
    error_rate_pct = (fail / requests * 100.0) if requests else 0.0
    normalized = dict(canary)
    normalized["requests_observed"] = requests
    normalized["error_rate_pct"] = round(error_rate_pct, 3)
    normalized.setdefault("p95_ms", 0.0)
    normalized.setdefault("pass", fail == 0)
    return normalized


def status_line(name: str, passed: bool, details: str) -> str:
    mark = "PASS" if passed else "FAIL"
    return f"- {name}: {mark} - {details}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--canary-metrics", default="canary_metrics.json")
    parser.add_argument("--uat-report", default="uat_report.json")
    parser.add_argument("--output", default="GO_LIVE_REPORT.md")
    parser.add_argument("--release-gate-passed", action="store_true")
    args = parser.parse_args()

    canary = normalize_canary(read_json(Path(args.canary_metrics)))
    uat = read_json(Path(args.uat_report))

    checks = []
    checks.append(status_line("Release gate", args.release_gate_passed, "compile + automated tests"))

    if canary:
        checks.append(
            status_line(
                "Canary metrics",
                bool(canary.get("pass")),
                f"p95={canary.get('p95_ms')}ms, 5xx={canary.get('error_rate_pct')}%",
            )
        )
    else:
        checks.append(status_line("Canary metrics", False, "missing canary_metrics.json"))

    if uat:
        passed = int(uat.get("failed", 1)) == 0
        checks.append(status_line("Multilingual UAT", passed, f"passed={uat.get('passed')}, failed={uat.get('failed')}"))
    else:
        checks.append(status_line("Multilingual UAT", False, "missing uat_report.json"))

    go_live = all("PASS" in line for line in checks)

    body = [
        "# Go-Live Evidence Report",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "## Checks",
        *checks,
        "",
        f"## Decision",
        f"- Recommendation: {'GO' if go_live else 'NO-GO'}",
    ]

    Path(args.output).write_text("\n".join(body) + "\n", encoding="utf-8")
    print("\n".join(body))
    return 0 if go_live else 1


if __name__ == "__main__":
    raise SystemExit(main())
