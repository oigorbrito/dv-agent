import unittest

from durations import parse_duration


class ParseDurationTests(unittest.TestCase):
    def test_spaced_components(self):
        self.assertEqual(parse_duration("1h 30m"), 5400)

    def test_compact_components(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_case_insensitive(self):
        self.assertEqual(parse_duration("2D"), 172800)

    def test_seconds_and_zero(self):
        self.assertEqual(parse_duration("90s"), 90)
        self.assertEqual(parse_duration("0s"), 0)

    def test_invalid_inputs_raise(self):
        for bad in ("", "   ", "1h30", "30m1h", "1h1h", "1x", "m"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_duration(bad)

    def test_non_string_raises(self):
        with self.assertRaises(ValueError):
            parse_duration(5)


if __name__ == "__main__":
    unittest.main()
