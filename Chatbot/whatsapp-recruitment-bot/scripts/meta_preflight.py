import argparse
import os
import secrets
import sys
from urllib.parse import urlencode

import requests
from dotenv import load_dotenv


def read_env(name: str, required: bool = True) -> str:
    value = os.getenv(name, "").strip()
    if required and not value:
        raise ValueError(f"Missing required env var: {name}")
    return value


def mask(value: str, visible: int = 6) -> str:
    if not value:
        return ""
    if len(value) <= visible * 2:
        return "*" * len(value)
    return f"{value[:visible]}...{value[-visible:]}"


def graph_get(path: str, token: str, api_version: str, params: dict | None = None) -> requests.Response:
    url = f"https://graph.facebook.com/{api_version}/{path.lstrip('/')}"
    headers = {"Authorization": f"Bearer {token}"}
    return requests.get(url, headers=headers, params=params or {}, timeout=30)


def check_graph_access(token: str, api_version: str, phone_number_id: str, waba_id: str) -> bool:
    ok = True

    phone_fields = "id,display_phone_number,verified_name,quality_rating,messaging_limit_tier"
    res_phone = graph_get(phone_number_id, token, api_version, {"fields": phone_fields})
    if res_phone.status_code != 200:
        ok = False
        print("[FAIL] Phone number lookup failed")
        print(f"       status={res_phone.status_code} body={res_phone.text}")
    else:
        data = res_phone.json()
        print("[PASS] Phone number lookup")
        print(
            "       "
            f"display_phone_number={data.get('display_phone_number')} "
            f"verified_name={data.get('verified_name')} "
            f"quality_rating={data.get('quality_rating')} "
            f"messaging_limit_tier={data.get('messaging_limit_tier')}"
        )

    waba_fields = "id,name,currency"
    res_waba = graph_get(waba_id, token, api_version, {"fields": waba_fields})
    if res_waba.status_code != 200:
        ok = False
        print("[FAIL] WABA lookup failed")
        print(f"       status={res_waba.status_code} body={res_waba.text}")
    else:
        data = res_waba.json()
        print("[PASS] WABA lookup")
        print(f"       id={data.get('id')} name={data.get('name')} currency={data.get('currency')}")

    return ok


def check_webhook(callback_url: str, verify_token: str) -> bool:
    challenge = secrets.token_hex(8)
    params = {
        "hub.mode": "subscribe",
        "hub.verify_token": verify_token,
        "hub.challenge": challenge,
    }
    url = f"{callback_url.rstrip('/')}/webhook/whatsapp?{urlencode(params)}"

    try:
        response = requests.get(url, timeout=30)
    except requests.RequestException as exc:
        print("[FAIL] Webhook challenge request failed")
        print(f"       error={exc}")
        return False

    if response.status_code == 200 and response.text.strip() == challenge:
        print("[PASS] Webhook challenge check")
        print(f"       callback={callback_url.rstrip('/')}/webhook/whatsapp")
        return True

    print("[FAIL] Webhook challenge check")
    print(f"       status={response.status_code} body={response.text}")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Meta WhatsApp production preflight checks")
    parser.add_argument(
        "--skip-webhook",
        action="store_true",
        help="Skip webhook challenge check if callback URL is not publicly reachable yet",
    )
    args = parser.parse_args()

    load_dotenv()

    try:
        token = read_env("META_ACCESS_TOKEN")
        waba_id = read_env("META_WHATSAPP_BUSINESS_ACCOUNT_ID")
        phone_number_id = read_env("META_PHONE_NUMBER_ID")
        verify_token = read_env("META_VERIFY_TOKEN")
        api_version = read_env("META_API_VERSION")
        callback_base = read_env("CLOUD_RUN_URL")
    except ValueError as exc:
        print(f"[FAIL] {exc}")
        return 1

    print("Meta preflight configuration")
    print(f"- META_API_VERSION={api_version}")
    print(f"- META_WHATSAPP_BUSINESS_ACCOUNT_ID={waba_id}")
    print(f"- META_PHONE_NUMBER_ID={phone_number_id}")
    print(f"- META_VERIFY_TOKEN={mask(verify_token)}")
    print(f"- META_ACCESS_TOKEN={mask(token)}")
    print(f"- CLOUD_RUN_URL={callback_base}")

    graph_ok = check_graph_access(token, api_version, phone_number_id, waba_id)
    webhook_ok = True
    if not args.skip_webhook:
        webhook_ok = check_webhook(callback_base, verify_token)

    if graph_ok and webhook_ok:
        print("\n[READY] Preflight passed. You can continue Meta dashboard Verify and Save + Live mode.")
        return 0

    print("\n[BLOCKED] Preflight failed. Fix errors above before go-live.")
    return 2


if __name__ == "__main__":
    sys.exit(main())