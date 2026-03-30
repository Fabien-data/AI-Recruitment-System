import unittest

from app.agents.intake_agent import intake_agent
from app.agents.recovery_agent import recovery_agent


class AgentModuleTests(unittest.TestCase):
    def test_intake_next_missing_field(self):
        state = {"collected_data": {"job_role": "Driver"}}
        self.assertEqual(intake_agent.next_missing_field(state), "country")

    def test_recovery_handoff_prompt_has_human(self):
        prompt = recovery_agent.handoff_prompt("en")
        self.assertIn("human", prompt.lower())


if __name__ == "__main__":
    unittest.main()
