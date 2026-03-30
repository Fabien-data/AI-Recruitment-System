"""Fetch Cloud Run logs via gcloud and compute canary metrics."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.utils.metrics import error_rate, parse_duration_to_ms, percentile


def build_command(gcloud_exe: str, project: str, service: str, region: str, freshness: str) -> list[str]:
    query = (
        'resource.type="cloud_run_revision" '
        f'resource.labels.service_name="{service}" '
        f'resource.labels.location="{region}" '
        'httpRequest.requestMethod="POST" '
        'httpRequest.requestUrl:"/webhook/whatsapp"'
    )
    return [
        gcloud_exe,
        "logging",
        "read",
        query,
        "--project",
        project,
        "--freshness",
        freshness,
        "--format",
        "json",
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--service", default="whatsapp-chatbot")
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--freshness", default="30m")
    parser.add_argument("--p95-threshold-ms", type=float, default=2000.0)
    parser.add_argument("--error-threshold-pct", type=float, default=1.0)
    parser.add_argument("--min-requests", type=int, default=20)
    parser.add_argument("--output", default="canary_metrics.json")
    args = parser.parse_args()

    gcloud_exe = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if gcloud_exe is None:
        print(json.dumps({"error": "gcloud CLI not found"}, indent=2))
        return 2

    cmd = build_command(gcloud_exe, args.project, args.service, args.region, args.freshness)
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(json.dumps({"error": "gcloud logging read failed", "stderr": result.stderr}, indent=2))
        return result.returncode

    try:
        entries = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        print(json.dumps({"error": "invalid gcloud JSON output"}, indent=2))
        return 3

    latencies = []
    statuses = []
    for e in entries:
        http_req = e.get("httpRequest") or {}
        status = int(http_req.get("status", 0) or 0)
        latency = http_req.get("latency", "")
        if status:
            statuses.append(status)
        if latency:
            try:
                latencies.append(parse_duration_to_ms(latency))
            except Exception:
                pass

    p95 = percentile(latencies, 0.95)
    err = error_rate(statuses)

    report = {
        "project": args.project,
        "service": args.service,
        "region": args.region,
        "freshness": args.freshness,
        "requests_observed": len(statuses),
        "p95_ms": round(p95, 2),
        "error_rate_pct": round(err, 3),
        "p95_threshold_ms": args.p95_threshold_ms,
        "error_threshold_pct": args.error_threshold_pct,
        "min_requests": args.min_requests,
        "pass": (
            len(statuses) >= args.min_requests
            and p95 <= args.p95_threshold_ms
            and err <= args.error_threshold_pct
        ),
    }

    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
