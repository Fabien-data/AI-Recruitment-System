import unittest

from app.utils.metrics import error_rate, parse_duration_to_ms, percentile


class MetricsUtilsTests(unittest.TestCase):
    def test_parse_duration(self):
        self.assertEqual(parse_duration_to_ms("250ms"), 250.0)
        self.assertEqual(parse_duration_to_ms("1s"), 1000.0)
        self.assertEqual(parse_duration_to_ms("0.5m"), 30000.0)

    def test_percentile(self):
        vals = [100, 200, 300, 400]
        p95 = percentile(vals, 0.95)
        self.assertTrue(p95 >= 300)

    def test_error_rate(self):
        self.assertEqual(error_rate([200, 201, 204]), 0.0)
        self.assertGreater(error_rate([200, 500, 503]), 0.0)


if __name__ == "__main__":
    unittest.main()
