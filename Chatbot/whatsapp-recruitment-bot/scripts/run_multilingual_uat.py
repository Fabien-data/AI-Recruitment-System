"""Local multilingual UAT runner for modular orchestrator logic."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.orchestrator import intake_orchestrator


class DummyDB:
    def commit(self):
        return None


class InMemoryRepo:
    def __init__(self):
        self.candidate = None

    def get_or_create(self):
        if self.candidate is None:
            self.candidate = SimpleNamespace(
                id=1,
                phone_number="94770000000",
                agent_state={},
                extracted_data={},
                language_preference=SimpleNamespace(value="en"),
                confidence_score=0.0,
                handoff_flag=False,
                conversation_state="initial",
            )
        return self.candidate


def contains_expected(response, expected_tokens):
    if isinstance(response, dict):
        text = json.dumps(response).lower()
    else:
        text = str(response).lower()
    return any(tok.lower() in text for tok in expected_tokens)


async def run_suite(suite_path: Path, output_path: Path | None = None) -> int:
    suite = json.loads(suite_path.read_text(encoding="utf-8"))
    scenarios = suite.get("scenarios", [])

    passed = 0
    failed = 0

    for scenario in scenarios:
        repo = InMemoryRepo()
        cand = repo.get_or_create()
        ok = True
        final_response = ""

        for step in scenario.get("steps", []):
            # monkey patch minimal repo calls per scenario
            from app.core import orchestrator as orch_mod

            original_get = orch_mod.crud.get_or_create_candidate
            original_update = orch_mod.crud.update_candidate_state
            try:
                orch_mod.crud.get_or_create_candidate = lambda db, phone: cand
                orch_mod.crud.update_candidate_state = lambda db, cid, st: cand
                response = await intake_orchestrator.process_text_message(
                    db=DummyDB(),
                    phone_number=cand.phone_number,
                    message_text=step,
                )
                final_response = response
            finally:
                orch_mod.crud.get_or_create_candidate = original_get
                orch_mod.crud.update_candidate_state = original_update

        if not contains_expected(final_response, scenario.get("expected", [])):
            ok = False

        if ok:
            passed += 1
            print(f"[uat] PASS {scenario.get('id')}")
        else:
            failed += 1
            print(f"[uat] FAIL {scenario.get('id')}")
            print(f"[uat] final_response={final_response}")

    report = {"passed": passed, "failed": failed, "total": len(scenarios)}
    print(json.dumps(report, indent=2))
    if output_path is not None:
        output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if failed == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--suite",
        default="scripts/multilingual_uat_suite.json",
        help="Path to multilingual UAT suite JSON",
    )
    parser.add_argument("--output", default="uat_report.json", help="Output JSON report path")
    args = parser.parse_args()
    return asyncio.run(run_suite(Path(args.suite), Path(args.output)))


if __name__ == "__main__":
    raise SystemExit(main())
