"""Simple webhook load and latency probe for pre-release validation."""

from __future__ import annotations

import argparse
import json
import random
import statistics
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests


def build_payload(phone: str, msg_id: str, text: str) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "LOADTEST",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "123",
                                "phone_number_id": "123",
                            },
                            "contacts": [{"profile": {"name": "Load Tester"}, "wa_id": phone}],
                            "messages": [
                                {
                                    "from": phone,
                                    "id": msg_id,
                                    "timestamp": str(int(time.time())),
                                    "type": "text",
                                    "text": {"body": text},
                                }
                            ],
                        },
                    }
                ],
            }
        ],
    }


def one_call(base_url: str, idx: int, timeout: float) -> tuple[float, int]:
    phone = f"947799{random.randint(10000, 99999)}"
    msg_id = f"wamid.LOAD_{int(time.time()*1000)}_{idx}"
    payload = build_payload(phone, msg_id, "show vacancies")
    start = time.perf_counter()
    resp = requests.post(base_url, json=payload, timeout=timeout)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return elapsed_ms, resp.status_code


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (k - f) * (sorted_vals[c] - sorted_vals[f])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Webhook URL (e.g. https://.../webhook/whatsapp)")
    parser.add_argument("--requests", type=int, default=50)
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--p95-threshold-ms", type=float, default=2000.0)
    parser.add_argument("--output", default="canary_metrics.json")
    args = parser.parse_args()

    latencies = []
    status_codes = []

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = [pool.submit(one_call, args.url, i, args.timeout) for i in range(args.requests)]
        for fut in as_completed(futures):
            elapsed, status = fut.result()
            latencies.append(elapsed)
            status_codes.append(status)

    p50 = percentile(latencies, 0.50)
    p95 = percentile(latencies, 0.95)
    max_v = max(latencies) if latencies else 0.0
    ok = sum(1 for s in status_codes if s == 200)
    fail = len(status_codes) - ok

    report = {
        "requests": args.requests,
        "concurrency": args.concurrency,
        "requests_observed": len(status_codes),
        "ok": ok,
        "fail": fail,
        "p50_ms": round(p50, 2),
        "p95_ms": round(p95, 2),
        "max_ms": round(max_v, 2),
        "error_rate_pct": round((fail / len(status_codes) * 100.0), 3) if status_codes else 0.0,
        "status_histogram": {str(code): status_codes.count(code) for code in sorted(set(status_codes))},
        "pass": (fail == 0 and p95 <= args.p95_threshold_ms),
        "p95_threshold_ms": args.p95_threshold_ms,
    }

    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
