Fix `parse_duration(text)` in durations.py. It converts a duration such as '1h 30m' or '2d' into whole seconds. Units are d, h, m, s, case-insensitive, and must appear in that order, each at most once. Whitespace is allowed between components. Empty text, unknown units, trailing numbers without a unit, out-of-order or repeated units, and non-string input raise ValueError.

Run the tests with: python -m unittest discover -s tests -p "test_*.py"
Edit only the source module. Do not modify anything under tests/.
