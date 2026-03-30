import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.services.job_matching_service import job_matching_service


class JobMatchingServiceTests(unittest.TestCase):
    def test_weighted_country_match_prioritized(self):
        jobs = [
            {
                "title": "Driver",
                "countries": ["Qatar"],
                "requirements": {"skills": "driving", "experience_years": 2},
            },
            {
                "title": "Driver",
                "countries": ["UAE"],
                "requirements": {"skills": "driving", "experience_years": 2},
            },
        ]

        with patch("app.services.job_matching_service.vacancy_service.get_ranked_jobs", new=AsyncMock(return_value=jobs)):
            result = asyncio.run(
                job_matching_service.get_ranked_matches(
                    job_role="Driver",
                    country="Qatar",
                    candidate_skills=["driving"],
                    experience_years=3,
                    limit=2,
                )
            )

        self.assertEqual(result[0]["countries"][0], "Qatar")
        self.assertGreaterEqual(result[0]["match_score"], result[1]["match_score"])


if __name__ == "__main__":
    unittest.main()
