"""
QA harness for the deployed WhatsApp chatbot.
================================================
Drives the live Cloud Run chatbot by sending simulated Meta WhatsApp
webhook payloads, then reads back the bot's state (and reply text from
the new /admin/conversation endpoint, if present).

Usage:
    python scripts/qa_harness.py smoke
    python scripts/qa_harness.py persona <lang> <persona> <phone>
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import uuid
from typing import Optional

import requests


BOT_URL = "https://whatsapp-chatbot-ay6blp2yuq-uc.a.run.app"
WEBHOOK = f"{BOT_URL}/webhook/whatsapp"
ADMIN_INFO = f"{BOT_URL}/admin/candidate-info"
ADMIN_CONV = f"{BOT_URL}/admin/conversation"
ADMIN_RESET = f"{BOT_URL}/admin/reset-candidate"
ADMIN_DELETE = f"{BOT_URL}/admin/delete-candidate"

WAIT_AFTER_SEND = 8.0  # seconds — give the bot time to process


def _meta_payload(phone: str, text: str) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "QA_HARNESS",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": "QA",
                        "phone_number_id": "QA",
                    },
                    "contacts": [{
                        "profile": {"name": "QA Test"},
                        "wa_id": phone,
                    }],
                    "messages": [{
                        "from": phone,
                        "id": f"wamid.qa.{uuid.uuid4().hex}",
                        "timestamp": str(int(time.time())),
                        "text": {"body": text},
                        "type": "text",
                    }],
                },
            }],
        }],
    }


def _retrying_request(method: str, url: str, attempts: int = 4, **kw):
    last_exc = None
    for i in range(attempts):
        try:
            return requests.request(method, url, **kw)
        except (requests.ConnectionError, requests.Timeout) as e:
            last_exc = e
            backoff = 3.0 * (i + 1)
            print(f"  ! network blip ({type(e).__name__}); retry in {backoff:.0f}s")
            time.sleep(backoff)
    raise last_exc


def send_message(phone: str, text: str, wait: float = WAIT_AFTER_SEND) -> dict:
    payload = _meta_payload(phone, text)
    r = _retrying_request("post", WEBHOOK, json=payload, timeout=25)
    r.raise_for_status()
    time.sleep(wait)
    return r.json()


def candidate_info(phone: str) -> dict:
    try:
        r = _retrying_request("get", ADMIN_INFO, params={"phone": phone}, timeout=20)
        return r.json() if r.ok else {"error": r.text, "status_code": r.status_code}
    except Exception as e:
        return {"error": str(e)}


def conversation(phone: str, limit: int = 20) -> dict:
    """Calls /admin/conversation (added by the QA pass). Falls back if 404."""
    try:
        r = requests.get(ADMIN_CONV, params={"phone": phone, "limit": limit}, timeout=15)
        if r.ok:
            return r.json()
        return {"error": r.text, "status_code": r.status_code}
    except Exception as e:
        return {"error": str(e)}


def replies_from_logs(phone: str, freshness_min: int = 10, limit: int = 80) -> list[dict]:
    """
    Pull recent bot reply log lines for the given phone from Cloud Run logs.
    Returns list of {timestamp, text} dicts.  Note: replies are truncated to
    ~80 chars in the existing log line, so this captures register/language
    but may cut off full sentence detail.
    """
    cmd = [
        "gcloud.cmd", "logging", "read",
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="whatsapp-chatbot" '
        f'AND textPayload:"Sending reply to {phone}"',
        "--project", "dewan-chatbot-1234",
        "--limit", str(limit),
        f"--freshness={freshness_min}m",
        "--format=json",
    ]
    try:
        out = subprocess.check_output(cmd, encoding="utf-8", errors="replace")
        events = json.loads(out)
    except Exception as e:
        return [{"error": str(e)}]
    replies = []
    for ev in events:
        txt = ev.get("textPayload", "")
        # ✂  Match "Sending reply to <phone>: <body>"
        marker = f"Sending reply to {phone}:"
        idx = txt.find(marker)
        if idx >= 0:
            body = txt[idx + len(marker):].strip()
            replies.append({"timestamp": ev.get("timestamp"), "text": body})
    # Sort old → new
    replies.sort(key=lambda r: r.get("timestamp") or "")
    return replies


def sync_calls_from_logs(phone: str, freshness_min: int = 10) -> list[dict]:
    """Pull CRM sync log lines for the test phone — used to verify CRM ingestion."""
    cmd = [
        "gcloud.cmd", "logging", "read",
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="whatsapp-chatbot" '
        f'AND textPayload:"{phone}" AND (textPayload:"sync" OR textPayload:"recruitment" OR textPayload:"intake")',
        "--project", "dewan-chatbot-1234",
        "--limit", "30",
        f"--freshness={freshness_min}m",
        "--format=json",
    ]
    try:
        out = subprocess.check_output(cmd, encoding="utf-8", errors="replace")
        events = json.loads(out)
    except Exception as e:
        return [{"error": str(e)}]
    return [{"timestamp": e.get("timestamp"), "text": e.get("textPayload", "")[:300]} for e in events]


def reset(phone: str) -> dict:
    r = requests.post(ADMIN_RESET, params={"phone": phone}, timeout=15)
    return r.json() if r.ok else {"error": r.text}


def delete(phone: str) -> dict:
    r = requests.delete(ADMIN_DELETE, params={"phone": phone}, timeout=15)
    return r.json() if r.ok else {"error": r.text}


def smoke():
    """Send one English 'hi' and dump the candidate state + last conversation."""
    phone = "94770099001"
    print(f"[SMOKE] reset {phone}")
    print(json.dumps(reset(phone), ensure_ascii=False, indent=2))
    print(f"[SMOKE] send 'hi' to {phone}")
    print(json.dumps(send_message(phone, "hi"), ensure_ascii=False, indent=2))
    print(f"[SMOKE] candidate state:")
    print(json.dumps(candidate_info(phone), ensure_ascii=False, indent=2))
    print(f"[SMOKE] conversation:")
    print(json.dumps(conversation(phone), ensure_ascii=False, indent=2))


def run_script(phone: str, label: str, messages: list[str], wait: float = WAIT_AFTER_SEND):
    """Send a scripted sequence of messages and capture state + history."""
    print(f"\n{'='*70}\n[{label}] phone={phone}, {len(messages)} messages\n{'='*70}")
    reset(phone)
    time.sleep(2)
    for i, msg in enumerate(messages, 1):
        print(f"\n>>> [{i}] USER: {msg}")
        try:
            send_message(phone, msg, wait=wait)
        except Exception as e:
            print(f"!!! webhook error: {e}")
    print(f"\n--- final candidate state ---")
    print(json.dumps(candidate_info(phone), ensure_ascii=False, indent=2))
    print(f"\n--- conversation history ---")
    print(json.dumps(conversation(phone), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "smoke"
    if cmd == "smoke":
        smoke()
    elif cmd == "send":
        # python qa_harness.py send <phone> <text>
        phone, text = sys.argv[2], sys.argv[3]
        print(json.dumps(send_message(phone, text), ensure_ascii=False, indent=2))
    elif cmd == "info":
        print(json.dumps(candidate_info(sys.argv[2]), ensure_ascii=False, indent=2))
    elif cmd == "conv":
        print(json.dumps(conversation(sys.argv[2]), ensure_ascii=False, indent=2))
    elif cmd == "reset":
        print(json.dumps(reset(sys.argv[2]), ensure_ascii=False, indent=2))
    else:
        print(f"unknown command: {cmd}")
        sys.exit(1)
