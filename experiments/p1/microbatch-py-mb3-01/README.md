# FT-PY-MB3-01 (frozen pilot micro-batch)

Three synthetic Python micro-tasks for claim C-T1 (free-tier arms FT-BASE-FULL vs FT-ELIDE-K4).
Each task directory holds `bundle.json` (pinned by the slice manifest), `workspace.zip` (buggy module + tests, no `.git`), `prompt.md` (executor-visible) and `oracle/` (the unittest file, pinned in the registry).

Regenerate with `python tools/dv_build_free_tier_microbatch.py --write`; verify with `--check`.
The files are byte-stable. Changing any of them is a new frozen revision of the slice.
