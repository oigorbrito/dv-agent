import unittest

from intervals import merge_intervals


class MergeIntervalsTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(merge_intervals([]), [])

    def test_unsorted_overlap(self):
        self.assertEqual(merge_intervals([(8, 10), (1, 3), (2, 6)]), [(1, 6), (8, 10)])

    def test_touching_intervals_merge(self):
        self.assertEqual(merge_intervals([(1, 2), (2, 3)]), [(1, 3)])

    def test_disjoint_kept_apart(self):
        self.assertEqual(merge_intervals([(1, 2), (4, 5)]), [(1, 2), (4, 5)])

    def test_contained_interval(self):
        self.assertEqual(merge_intervals([(1, 10), (2, 3)]), [(1, 10)])

    def test_returns_tuples(self):
        self.assertTrue(all(isinstance(x, tuple) for x in merge_intervals([(5, 6), (1, 1)])))

    def test_invalid_interval_raises(self):
        with self.assertRaises(ValueError):
            merge_intervals([(3, 1)])


if __name__ == "__main__":
    unittest.main()
