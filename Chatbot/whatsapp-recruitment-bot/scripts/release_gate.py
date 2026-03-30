"""Release gate runner for pre-production validation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TEST_COMMANDS = [
    [sys.executable, "-m", "unittest", "tests.test_agents"],
    [sys.executable, "-m", "unittest", "tests.test_metrics_utils"],
    [sys.executable, "-m", "unittest", "tests.test_intent_service"],
    [sys.executable, "-m", "unittest", "tests.test_orchestrator"],
    [sys.executable, "-m", "unittest", "tests.test_language_service"],
    [sys.executable, "-m", "unittest", "tests.test_job_matching_service"],
    [sys.executable, "-m", "unittest", "tests.test_message_router"],
    [sys.executable, "-m", "unittest", "tests.test_webhooks_routing"],
    [sys.executable, "-m", "unittest", "tests.test_recruitment_sync_contract"],
]


def run_command(cmd: list[str]) -> int:
    print(f"[gate] running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(ROOT), check=False)
    return result.returncode


def main() -> int:
    print("[gate] release gate start")
    compile_rc = run_command([sys.executable, "-m", "compileall", "app"])
    if compile_rc != 0:
        print("[gate] compile failed")
        return compile_rc

    for cmd in TEST_COMMANDS:
        rc = run_command(cmd)
        if rc != 0:
            print("[gate] test command failed")
            return rc

    print("[gate] all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
