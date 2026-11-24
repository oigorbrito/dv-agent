Fix `slugify(text, max_len=50)` in slugs.py. It must return a lowercase ASCII slug: each run of characters that is not a-z or 0-9 becomes a single '-', there is no leading or trailing '-', and the result is at most max_len characters and never ends with '-'.

Run the tests with: python -m unittest discover -s tests -p "test_*.py"
Edit only the source module. Do not modify anything under tests/.
