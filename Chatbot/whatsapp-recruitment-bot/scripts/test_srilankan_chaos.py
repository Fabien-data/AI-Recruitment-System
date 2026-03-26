"""
Ultimate E2E Chaos Testing Suite (Sri Lanka)

Purpose:
- Simulate Meta WhatsApp webhook payloads against FastAPI webhook endpoint.
- Stress chaos-path behaviors (code-switching, gibberish, voice, wrong media).
- Run multilingual full-flow smoke across en/si/ta/singlish/tanglish.

Usage:
  python scripts/test_srilankan_chaos.py
  python scripts/test_srilankan_chaos.py --webhook-url http://localhost:8000/webhook/whatsapp
  python scripts/test_srilankan_chaos.py --webhook-url https://<ngrok>/webhook/whatsapp --base-phone 94770001000

Recommended local run order:
1) Start server: uvicorn app.main:app --reload
2) Run this script
3) Watch backend logs for tone, Meta button schema issues, and duplicate suppression behavior
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from typing import Any

import requests


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


WEBHOOK_URL_DEFAULT = _env("WEBHOOK_URL", "http://localhost:8000/webhook/whatsapp")
BASE_PHONE_DEFAULT = _env("TEST_PHONE", "94770000000")
REQUEST_TIMEOUT_DEFAULT = float(_env("CHAOS_TIMEOUT", "15"))
DELAY_SECONDS_DEFAULT = float(_env("CHAOS_DELAY", "2"))


@dataclass
class StepResult:
    label: str
    status_code: int | None
    ok: bool
    note: str = ""


def make_payload(
    *,
    phone: str,
    message_type: str,
    content: dict[str, Any],
    profile_name: str = "Test User",
    force_message_id: str | None = None,
) -> dict[str, Any]:
    now = int(time.time())
    message_id = force_message_id or f"wamid.TEST_{now}_{random.randint(1000, 9999)}"

    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "TEST_ACCOUNT_ID",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "1234567890",
                                "phone_number_id": "TEST_PHONE_ID",
                            },
                            "contacts": [
                                {
                                    "profile": {"name": profile_name},
                                    "wa_id": phone,
                                }
                            ],
                            "messages": [
                                {
                                    "from": phone,
                                    "id": message_id,
                                    "timestamp": str(now),
                                    "type": message_type,
                                    message_type: content,
                                }
                            ],
                        },
                    }
                ],
            }
        ],
    }
    return payload


def post_webhook(webhook_url: str, payload: dict[str, Any], timeout: float) -> requests.Response:
    return requests.post(webhook_url, json=payload, timeout=timeout)


def send_message(
    *,
    webhook_url: str,
    phone: str,
    message_type: str,
    content: dict[str, Any],
    label: str,
    delay_seconds: float,
    timeout: float,
    profile_name: str = "Test User",
    force_message_id: str | None = None,
) -> StepResult:
    payload = make_payload(
        phone=phone,
        message_type=message_type,
        content=content,
        profile_name=profile_name,
        force_message_id=force_message_id,
    )

    print(f"\n[🚀 SEND] {label}")
    print(f"  type={message_type} phone={phone}")
    print(f"  content={json.dumps(content, ensure_ascii=False)}")

    try:
        response = post_webhook(webhook_url, payload, timeout)
        ok = response.status_code == 200
        note = "ok" if ok else f"unexpected status={response.status_code}"
        print(f"[✅ STATUS] {response.status_code}")
        if not ok:
            print(f"[⚠️ BODY] {response.text[:400]}")
        time.sleep(delay_seconds)
        return StepResult(label=label, status_code=response.status_code, ok=ok, note=note)
    except Exception as exc:
        print(f"[❌ ERROR] {exc}")
        time.sleep(delay_seconds)
        return StepResult(label=label, status_code=None, ok=False, note=str(exc))


def run_phase_1_chaos(
    *, webhook_url: str, phone: str, delay_seconds: float, timeout: float
) -> list[StepResult]:
    results: list[StepResult] = []

    print("\n" + "=" * 72)
    print("PHASE 1: CHAOS PATH")
    print("=" * 72)

    print("\n--- TEST 1: Code-switching (Singlish intent extraction) ---")
    results.append(
        send_message(
            webhook_url=webhook_url,
            phone=phone,
            message_type="text",
            content={"body": "Mata job ekak one dubai wala driver kenek wenna"},
            label="T1 Singlish intent",
            delay_seconds=delay_seconds,
            timeout=timeout,
        )
    )
    print("Expected: infer job intent + destination without asking repetitive questions.")

    print("\n--- TEST 2: Gibberish 2-strike ---")
    results.append(
        send_message(
            webhook_url=webhook_url,
            phone=phone,
            message_type="text",
            content={"body": "Hmm"},
            label="T2.1 Gibberish strike #1",
            delay_seconds=max(delay_seconds, 2.0),
            timeout=timeout,
        )
    )
    results.append(
        send_message(
            webhook_url=webhook_url,
            phone=phone,
            message_type="text",
            content={"body": "👍"},
            label="T2.2 Gibberish strike #2",
            delay_seconds=max(delay_seconds, 2.5),
            timeout=timeout,
        )
    )
    print("Expected: strike #1 gentle clarification, strike #2 auto-skip and progress state.")

    print("\n--- TEST 3: Voice note ---")
    results.append(
        send_message(
            webhook_url=webhook_url,
            phone=phone,
            message_type="audio",
            content={"id": "mock_audio_id_123", "mime_type": "audio/ogg"},
            label="T3 Voice note audio/ogg",
            delay_seconds=max(delay_seconds, 2.0),
            timeout=timeout,
        )
    )
    print("Expected: either transcribe path or friendly typed-fallback, no crash.")

    print("\n--- TEST 4: Wrong media type when CV expected ---")
    results.append(
        send_message(
            webhook_url=webhook_url,
            phone=phone,
            message_type="image",
            content={
                "id": "mock_image_id_456",
                "mime_type": "image/jpeg",
                "sha256": "mock_hash",
            },
            label="T4 Image instead of CV document",
            delay_seconds=max(delay_seconds, 2.0),
            timeout=timeout,
        )
    )
    print("Expected: friendly image/CV guidance, no dead-end state.")

    return results


def _lang_flow_messages() -> dict[str, list[str]]:
    return {
        "english": [
            "Hi",
            "I want to apply for a driver job in Dubai",
            "UAE",
            "3 years",
            "I only have image now",
        ],
        "sinhala": [
            "හෙලෝ",
            "මට ඩුබායි වල ඩ්‍රයිවර් ජොබ් එකකට apply කරන්න ඕන",
            "UAE",
            "අවුරුදු 4",
            "දැන් තියෙන්නේ ෆොටෝ එකක් විතරයි",
        ],
        "tamil": [
            "வணக்கம்",
            "எனக்கு டுபாயில் டிரைவர் வேலைக்கு apply பண்ணணும்",
            "UAE",
            "3 வருடம்",
            "இப்போ photo தான் இருக்கு",
        ],
        "singlish": [
            "Kohomada aiye",
            "Mata Qatar wala helper job ekak one",
            "Qatar",
            "2 years wage",
            "Dan thiyenne photo ekak witharai",
        ],
        "tanglish": [
            "Vanakkam bro",
            "Enaku Saudi la warehouse job apply panna venum",
            "Saudi",
            "5 varusham experience",
            "Ippo image mattum irukku",
        ],
    }


def run_phase_2_multilingual(
    *,
    webhook_url: str,
    base_phone: str,
    delay_seconds: float,
    timeout: float,
) -> list[StepResult]:
    print("\n" + "=" * 72)
    print("PHASE 2: FULL USERFLOW (EN/SI/TA/SINGLISH/TANGLISH)")
    print("=" * 72)

    flows = _lang_flow_messages()
    all_results: list[StepResult] = []

    base = int(re.sub(r"\D", "", base_phone) or "94770000000")

    for index, (lang, messages) in enumerate(flows.items(), start=1):
        phone = str(base + index)
        profile_name = f"Chaos-{lang.title()}"

        print("\n" + "-" * 72)
        print(f"LANG FLOW: {lang.upper()} (phone={phone})")
        print("-" * 72)

        for step, message_text in enumerate(messages, start=1):
            step_label = f"{lang} step {step}"
            result = send_message(
                webhook_url=webhook_url,
                phone=phone,
                message_type="text",
                content={"body": message_text},
                label=step_label,
                delay_seconds=delay_seconds,
                timeout=timeout,
                profile_name=profile_name,
            )
            all_results.append(result)

            if step == 4:
                # Inject ambiguity after experience to verify recovery (chaos within full flow)
                all_results.append(
                    send_message(
                        webhook_url=webhook_url,
                        phone=phone,
                        message_type="text",
                        content={"body": "hmm" if lang in ("english", "singlish") else "👍"},
                        label=f"{lang} ambiguity probe",
                        delay_seconds=max(delay_seconds, 1.5),
                        timeout=timeout,
                        profile_name=profile_name,
                    )
                )

        # Send image to ensure fallback instruction appears in each language journey
        all_results.append(
            send_message(
                webhook_url=webhook_url,
                phone=phone,
                message_type="image",
                content={"id": f"mock_img_{lang}", "mime_type": "image/jpeg", "sha256": "abc"},
                label=f"{lang} image fallback check",
                delay_seconds=max(delay_seconds, 2.0),
                timeout=timeout,
                profile_name=profile_name,
            )
        )

    print("\nExpected for each language flow:")
    print("- Onboarding progresses without infinite loops")
    print("- Ambiguous turn gets clarified or safely skipped")
    print("- Image prompt gives document/CV guidance")
    return all_results


def run_duplicate_probe(
    *, webhook_url: str, phone: str, delay_seconds: float, timeout: float
) -> list[StepResult]:
    print("\n" + "=" * 72)
    print("BONUS CHECK: DUPLICATE WEBHOOK SUPPRESSION")
    print("=" * 72)

    duplicate_id = f"wamid.DUPL_{int(time.time())}"
    r1 = send_message(
        webhook_url=webhook_url,
        phone=phone,
        message_type="text",
        content={"body": "duplicate check one"},
        label="D1 duplicate first send",
        delay_seconds=delay_seconds,
        timeout=timeout,
        force_message_id=duplicate_id,
    )
    r2 = send_message(
        webhook_url=webhook_url,
        phone=phone,
        message_type="text",
        content={"body": "duplicate check one"},
        label="D2 duplicate second send same message_id",
        delay_seconds=delay_seconds,
        timeout=timeout,
        force_message_id=duplicate_id,
    )
    print("Expected: second message should be skipped by dedupe cache in backend logs.")
    return [r1, r2]


def print_go_live_checklist() -> None:
    print("\n" + "=" * 72)
    print("GO-LIVE CHECKLIST (MANUAL LOG OBSERVATION)")
    print("=" * 72)
    print("1) Tone Guardrail:")
    print("   - Ensure bot never drifts to formal Sinhala (e.g. 'කරුණාකර ඔබගේ ...').")
    print("2) Meta Interactive Buttons:")
    print("   - Watch for HTTP 400 from Meta API in logs.")
    print("   - Confirm button labels stay <= 20 characters.")
    print("3) Timeout / Duplicates:")
    print("   - Look for slow processing (>3-4s) and duplicate webhook retries.")
    print("   - Confirm dedupe path logs skip repeated message IDs.")
    print("4) Gibberish 2-Strike:")
    print("   - Verify strike #2 progresses state and does not loop forever.")


def print_summary(results: list[StepResult]) -> int:
    total = len(results)
    passed = sum(1 for r in results if r.ok)
    failed = total - passed

    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    print(f"Total webhook sends: {total}")
    print(f"HTTP 200 accepted  : {passed}")
    print(f"Failed requests    : {failed}")

    if failed:
        print("\nFailed sends:")
        for result in results:
            if not result.ok:
                print(f"- {result.label}: {result.note}")

    print_go_live_checklist()
    return 0 if failed == 0 else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sri Lankan WhatsApp chaos E2E webhook tester")
    parser.add_argument("--webhook-url", default=WEBHOOK_URL_DEFAULT, help="Webhook URL to POST Meta-style payloads")
    parser.add_argument("--base-phone", default=BASE_PHONE_DEFAULT, help="Base phone number for synthetic users")
    parser.add_argument("--delay", type=float, default=DELAY_SECONDS_DEFAULT, help="Delay between sends (seconds)")
    parser.add_argument("--timeout", type=float, default=REQUEST_TIMEOUT_DEFAULT, help="HTTP timeout in seconds")
    parser.add_argument("--skip-duplicate-probe", action="store_true", help="Skip duplicate webhook check")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    print("=" * 72)
    print("ULTIMATE E2E CHAOS TEST SUITE")
    print("=" * 72)
    print(f"Webhook URL : {args.webhook_url}")
    print(f"Base phone  : {args.base_phone}")
    print(f"Delay (sec) : {args.delay}")
    print(f"Timeout (s) : {args.timeout}")

    all_results: list[StepResult] = []

    # Phase 1: core chaos injections
    all_results.extend(
        run_phase_1_chaos(
            webhook_url=args.webhook_url,
            phone=args.base_phone,
            delay_seconds=args.delay,
            timeout=args.timeout,
        )
    )

    # Phase 2: language full-flow matrix
    all_results.extend(
        run_phase_2_multilingual(
            webhook_url=args.webhook_url,
            base_phone=args.base_phone,
            delay_seconds=max(1.5, args.delay),
            timeout=args.timeout,
        )
    )

    # Optional duplicate suppression probe
    if not args.skip_duplicate_probe:
        all_results.extend(
            run_duplicate_probe(
                webhook_url=args.webhook_url,
                phone=str(int(re.sub(r"\D", "", args.base_phone) or "94770000000") + 999),
                delay_seconds=max(1.0, args.delay),
                timeout=args.timeout,
            )
        )

    return print_summary(all_results)


if __name__ == "__main__":
    sys.exit(main())
