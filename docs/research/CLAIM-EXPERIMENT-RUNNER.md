# Claim experiment runner (CI gate)

**Status:** gate, accounting report and a free-tier micro-batch adapter implemented. The registered design (C-T1, 3 tasks, `FT-S2-MB3-01`) is **BLOCKED**: no arm can execute yet. The workflow `.github/workflows/run-claim-experiment.yml` validates and plans. Execute-requested runs fail closed.

## Why it does not execute today

- `experiments/p1/wp07-treatment-bindings-v1.json` lists every WP-07 treatment B0–B4 as `UNBOUND`. This is why WP-07 designs cannot run. The free-tier design does not use those bindings.
- The registered free-tier design `C-T1` has `verifier_files: []` (no S2 verifier pinned; `s2-candidate-wave-01.json` has `admitted_count: 0`) and its three slice tasks have `bundle: null` (`NOT_MATERIALIZED`). The gate reports both as GAP.

Pinning verifiers and materializing bundles is a research decision (new frozen revision), not a CI change.

## Free-tier micro-batch adapter (`arm_source: FREE_TIER_MICROBATCH_PROFILES`)

- Design: `experiments/p1/claim-experiment-registry-v1.json` → `designs.C-T1`. Arms are frozen profiles `FT-BASE-FULL` (full history) and `FT-ELIDE-K4` (rule-based elision of observations older than the last 4). This is a partial proxy for C-T1, which concerns elision before LLM summarization.
- Slice: `experiments/p1/free-tier-microbatch-slice-v1.json` (`dv-free-tier-microbatch-slice-v1`, 1..5 tasks, each with a sha256-pinned `bundle.json`).
- Adapter: `tools/dv_free_tier_microbatch_adapter.py`. Providers `gemini_free` (`GEMINI_API_KEY`) and `groq_free` (`GROQ_API_KEY`), both through OpenAI-compatible chat completions. Model IDs are marked `UNVERIFIED_AGAINST_LIVE_FREE_TIER`.
- Executor protocol: one JSON action per reply (`list_dir`, `read_file`, `write_file`, `finish`). No shell and no git. Writes to oracle `test_paths` are refused. Test files are re-hashed after the run (`ORACLE_TAMPER`). A bundle containing `.git` is rejected.
- Limits: `max_tasks <= 5`, `max_steps <= 20` (default 15), `rpm <= 20` (default 10), HTTP 429 retries capped at 4 with `Retry-After` honoured, transient errors capped at 2, stuck detection after 3 identical action+outcome pairs.
- Accounting: every HTTP attempt is recorded. An attempt without reported usage (429, timeout, 5xx) makes that row's token totals `null`, never zero. `usd` is 0.0 with `usd_basis: FREE_QUOTA_NOT_BILLED`. Tokens are still accounted, so `FREE != ZERO_COST`.
- Outputs: `artifacts/arm-rows.json` (`dv-claim-arm-rows-v1`), `artifacts/adapter-meta.json` (no credential), `artifacts/trajectories/*.json` (raw runs), and verifier logs.
- Credential: read from the environment only, sent in the `Authorization` header, never printed or written. Missing credential: `UNKNOWN_EXTERNAL` (exit 3), no request sent.

The report adds optional `input_tokens`, `output_tokens` and `reasoning_tokens` per row. When input and output are both reported, `total_system_tokens` must equal their sum. Reasoning tokens are assumed to be inside output (OpenAI-style usage) and are not added twice. The summary shows failures by reason and component totals.

### How to trigger

- `dry_run=true` (default): plan only. Expected today: `PLAN_BLOCKED_DRY_RUN`, exit 0.
- `dry_run=false`: `claim_id=C-T1`, `baseline_setting=FT-BASE-FULL`, `treatment_setting=FT-ELIDE-K4`, `corpus_slice=FT-S2-MB3-01`, `executor_provider=gemini_free|groq_free`. Without the secret: `UNKNOWN_EXTERNAL` (exit 3). With a secret but a blocked plan: `BLOCKED_GAP` (exit 1). Execution starts only when the plan is `READY_FOR_EXECUTION`.

## Reuse map (REUSE → WRAP)

| Need | Reused source | Used as |
|---|---|---|
| Claim identity and status | `claims/claims-v1.json` | must exist and be `UNTESTED` |
| Treatment identity | `experiments/p1/wp07-treatment-bindings-v1.json` | must be `BOUND` with bindings |
| Accounting partitions and metrics | `experiments/p1/run-accounting-contract-v1.json` | partition keys, primary metric, failure cost rule |
| Fail-closed execution token pattern | `tools/ndv_run_wp07_codex_single_hop.py` (`--execute-token`) | same idea: no execution without explicit request |
| Runner outputs (for a future adapter) | `classification.verified_solved_task`, `usage.total_system_tokens_component`, `wall_seconds`, failure cost retained | to be mapped into `dv-claim-arm-rows-v1` |

Nothing in `tools/ndv_*`, `experiments/`, `claims/` or `provenance/` was modified.

## Components

- `tools/dv_claim_experiment_gate.py`: validates the request (claim, arms, slice, budget ceiling 10.00 USD), checks the frozen design, corpus pin, verifier pins, binding status and estimated spend. Dry run by default. `--execute` requires `DV_EXECUTOR_API_KEY` (presence only, never printed). `--verify-manifest` re-hashes oracle files recorded in a plan.
- `tools/dv_claim_experiment_report.py`: summarizes normalized arm rows (`dv-claim-arm-rows-v1`). Only `VERIFIED_SOLVED` counts as solved. Missing telemetry yields `null` and blocks the primary metric; it is never zero. Pending verification blocks the primary metric. Failed, inconclusive and pending runs keep their cost. Output decision is always `NOT_DECIDED`. No composite score.
- `experiments/p1/claim-experiment-registry-v1.json`: registry of frozen designs (one free-tier design, blocked).
- `tools/dv_free_tier_microbatch_adapter.py`: free-tier micro-batch executor (see above), with `tools/test_dv_free_tier_microbatch_adapter.py` (fake transport, no live calls).
- `.github/workflows/run-claim-experiment.yml`: `workflow_dispatch` only, `permissions: contents: read`, inputs `claim_id`, `baseline_setting`, `treatment_setting`, `corpus_slice`, `executor_provider` (default `gemini_free`), `max_budget_usd` (default `2.00`), `dry_run` (default `true`). Writes the plan to the step summary, runs the adapter only when `dry_run=false`, re-checks oracle pins, writes the accounting summary, and uploads `artifacts/` (plan, arm rows, trajectories).

## Exit and status vocabulary

| Situation | Status | Exit |
|---|---|---|
| Invalid input | `INVALID_INPUT` | 2 |
| Dry run, any plan | `PLAN_VALID_DRY_RUN` or `PLAN_BLOCKED_DRY_RUN` | 0 |
| Execute requested, local GAP | `BLOCKED_GAP` | 1 |
| Execute requested, credential missing | `UNKNOWN_EXTERNAL` (takes precedence over GAP) | 3 |
| Adapter: plan not `READY_FOR_EXECUTION` / bundle or slice pin drift | `REFUSED` / `BLOCKED` | 1 |
| Adapter: micro-batch larger than 5 tasks or limit flags out of range | `INVALID_INPUT` | 2 |
| Execute requested, all checks pass | `READY_FOR_EXECUTION` (workflow then fails closed: no adapter) | 0, then the adapter step fails |

## Adding a design (future revision, not automatic)

1. Freeze the corpus slice under `experiments/p1/` and record its sha256.
2. Pin the verifier and oracle files (`verifier_files`), not editable during execution.
3. Bind the treatments in the bindings registry (`status: BOUND`, binding file sha256).
4. Set `runs_per_arm` and `estimated_usd_per_run` for each arm.
5. Implement an execution adapter that writes `arm-rows.json` (`dv-claim-arm-rows-v1`), then review the resulting summary by a human. The workflow never merges or promotes a claim.

## Non-goals

- No automatic claim promotion, no auto-merge, no composite score.
- No provider credentials in the repository or in logs.
- No attempt to reproduce upstream benchmarks; benchmark version preferences are in `docs/research/EXTERNAL-FINDINGS-2026.md`.
