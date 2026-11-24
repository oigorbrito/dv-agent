Fix `merge_intervals(intervals)` in intervals.py. Input is an iterable of closed integer pairs (start, end) in any order. Overlapping and touching intervals are merged. The result is a list of (start, end) tuples sorted by start. An empty input returns []. Any pair with start > end raises ValueError.

Run the tests with: python -m unittest discover -s tests -p "test_*.py"
Edit only the source module. Do not modify anything under tests/.
