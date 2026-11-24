import unittest

from slugs import slugify


class SlugifyTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_collapses_runs(self):
        self.assertEqual(slugify("  a__b   c  "), "a-b-c")

    def test_strips_edges(self):
        self.assertEqual(slugify("--x--"), "x")

    def test_non_ascii_is_a_separator(self):
        self.assertEqual(slugify("Café au lait"), "caf-au-lait")

    def test_truncation_never_leaves_trailing_dash(self):
        self.assertEqual(slugify("abc def", 4), "abc")
        self.assertEqual(slugify("abcdef", 4), "abcd")

    def test_empty_and_symbols(self):
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("!!!"), "")


if __name__ == "__main__":
    unittest.main()
