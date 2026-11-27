// Agregação de múltiplos baselines no bootstrap pareado e validação fail-fast do histórico do roteador no CLI (offline).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CONTRACT_V4_SHA256 } from "../src/bench/contract_labels.ts";
import { computePairedBootstrap, renderPairedBootstrap } from "../src/bench/paired_bootstrap.ts";
import type { BenchReport, RunRecord } from "../src/bench/report.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

function run(task: string, policy: string, solved: boolean, tokens: number, repeat = 0): RunRecord {
	return {
		task_id: task,
		repeat,
		tier: "easy",
		policy,
		final_outcome: solved ? "solved" : "unsolved",
		solved,
		escalated: null,
		steps: [
			{
				rung: 0,
				role: "executor",
				model: "anthropic/test-model",
				reasoning_effort: null,
				verdict: solved ? "PASS" : "FAIL",
				run_status: "completed",
				ceiling_status: "within_verified",
				spent_lower_bound_usd: 0,
				ledger_path: `ledger-${task}-${policy}-${repeat}.jsonl`,
				ledger_sha256: "0".repeat(64),
				metrics: {
					calls: 1,
					telemetry_complete: true,
					prompt_tokens: tokens,
					completion_tokens: 0,
					total_tokens: tokens,
					uncached_input_tokens: tokens,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					cost_usd: null,
				},
				conformance_status: "PASS",
			},
		],
		conformance_status: "PASS",
		conformance_violations: [],
	} as unknown as RunRecord;
}

function report(runs: RunRecord[]): BenchReport {
	return {
		schema: "dv-bench-summary-v2",
		contract_id: "p1-run-accounting-v4",
		contract_sha256: CONTRACT_V4_SHA256,
		auth_mode: "offline-faux",
		tier: "all",
		tiers: ["easy"],
		task: null,
		tasks: null,
		policies: [...new Set(runs.map((r) => r.policy))],
		model: "anthropic/test-model",
		escalation_model: null,
		ladder_models: null,
		max_cost_usd: 1,
		max_tokens: null,
		editor_limits: { maxTurns: 1, maxOutputTokens: 1 },
		repeats: 1,
		temperature: null,
		temperature_notes: [],
		runs,
		rows: [],
		conformance_violations: [],
	} as unknown as BenchReport;
}

// Dois braços single (baseline em duas execuções independentes) e um tratamento, mesmas células.
const baselineA = report([run("t1", "single", true, 100), run("t2", "single", false, 300)]);
const baselineB = report([run("t1", "single", true, 200), run("t2", "single", true, 500)]);
const treatment = report([run("t1", "ladder", true, 50), run("t2", "ladder", true, 100)]);

test("baseline único: duplicata de 'single' continua sendo erro explícito (comportamento preservado)", () => {
	assert.throws(
		() => computePairedBootstrap([baselineA, baselineB, treatment], { policyA: "single", policyB: "ladder" }),
		/duplicate paired run for single/,
	);
});

test("mean: baseline por célula é a média dos braços; diferença = tratamento - média", () => {
	const result = computePairedBootstrap([baselineA, baselineB, treatment], {
		policyA: "single",
		policyB: "ladder",
		baselineAggregation: "mean",
		resamples: 200,
	});
	// t1: média(100,200)=150 -> 50-150=-100; t2: média(300,500)=400 -> 100-400=-300; média por tarefa = -200.
	assert.equal(result.total_tokens_difference.estimate, -200);
	assert.equal(result.total_tokens_difference.units, 2);
	assert.equal(result.baseline_arms, 2);
	assert.equal(result.baseline_aggregation, "mean");
	// solve_rate: t1 tratamento 1 - média(1,1)=1 -> 0; t2 tratamento 1 - média(0,1)=0,5 -> 0,5; média por tarefa = 0,25.
	assert.equal(result.pass_rate_difference.estimate, 0.25);
});

test("mean: renderiza a nota de agregação com o número de braços", () => {
	const result = computePairedBootstrap([baselineA, baselineB, treatment], {
		policyA: "single",
		policyB: "ladder",
		baselineAggregation: "mean",
		resamples: 50,
	});
	const text = renderPairedBootstrap(result);
	assert.match(text, /Baseline: média de 2 braços `single`/);
});

test("single explícito com um só baseline: sem nota de agregação (saída inalterada)", () => {
	const result = computePairedBootstrap([baselineA, treatment], {
		policyA: "single",
		policyB: "ladder",
		resamples: 50,
	});
	assert.equal(result.baseline_aggregation, "single");
	assert.equal(result.baseline_arms, 1);
	assert.doesNotMatch(renderPairedBootstrap(result), /Baseline: média/);
});

test("mean: um único resumo de baseline é erro (não há o que agregar)", () => {
	assert.throws(
		() =>
			computePairedBootstrap([baselineA, treatment], {
				policyA: "single",
				policyB: "ladder",
				baselineAggregation: "mean",
			}),
		/exige pelo menos dois resumos/,
	);
});

test("mean: braço incompleto (célula ausente) é erro, nunca média parcial", () => {
	const incomplete = report([run("t1", "single", true, 200)]); // falta t2
	assert.throws(
		() =>
			computePairedBootstrap([baselineA, incomplete, treatment], {
				policyA: "single",
				policyB: "ladder",
				baselineAggregation: "mean",
			}),
		/baseline incompleto para t2\/rep-0: 1 de 2 braços/,
	);
});

// ---------- CLI: validação fail-fast do histórico do roteador ----------

function runBench(args: string[]) {
	return spawnSync(process.execPath, [join(ROOT, "scripts/dv-bench.ts"), ...args], { encoding: "utf8", cwd: ROOT });
}

test("CLI bench: --routing-history sem partição calibration é recusado antes de criar o outdir", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-guard-"));
	const outdir = join(dir, "run-a");
	const history = join(dir, "summary.json");
	writeFileSync(history, "{}");
	const r1 = runBench(["--routing-history", history, "--policies", "predictive-harness-router", "--outdir", outdir]);
	assert.equal(r1.status, 1);
	assert.match(r1.stderr, /exige --routing-history-partition calibration/);
	const r2 = runBench([
		"--routing-history",
		history,
		"--routing-history-partition",
		"holdout",
		"--policies",
		"predictive-harness-router",
		"--outdir",
		outdir,
	]);
	assert.equal(r2.status, 1, "holdout nunca é partição de histórico do roteador");
	assert.match(r2.stderr, /exige --routing-history-partition calibration/);
	assert.equal(existsSync(outdir), false, "nenhum outdir criado em caso de erro de validação");
});

test("CLI bench: --routing-history só com a política preditiva", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-guard-"));
	const outdir = join(dir, "run-b");
	const history = join(dir, "summary.json");
	writeFileSync(history, "{}");
	const r = runBench([
		"--routing-history",
		history,
		"--routing-history-partition",
		"calibration",
		"--policies",
		"single",
		"--outdir",
		outdir,
	]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /só se aplica a --policies predictive-harness-router/);
	assert.equal(existsSync(outdir), false);
});

test("CLI bench: partição sem histórico é recusada", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-guard-"));
	const outdir = join(dir, "run-c");
	const r = runBench(["--routing-history-partition", "calibration", "--policies", "single", "--outdir", outdir]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /exige --routing-history/);
	assert.equal(existsSync(outdir), false);
});

test("CLI métricas: --baseline-aggregate aceita só single ou mean e exige modo pareado", () => {
	const script = join(ROOT, "scripts/dv-bench-metrics.ts");
	const bad = spawnSync(
		process.execPath,
		[script, "--baseline", "single", "--treatment", "ladder", "--baseline-aggregate", "x", "a.json"],
		{
			encoding: "utf8",
			cwd: ROOT,
		},
	);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /--baseline-aggregate deve ser single ou mean/);
	const orphan = spawnSync(process.execPath, [script, "--baseline-aggregate", "mean", "a.json"], {
		encoding: "utf8",
		cwd: ROOT,
	});
	assert.equal(orphan.status, 1);
});

test("CLI bench: --compaction aceita só off ou by_model", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-guard-"));
	const outdir = join(dir, "run-d");
	const r = runBench(["--compaction", "aggressive", "--policies", "single", "--outdir", outdir]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--compaction deve ser off ou by_model/);
	assert.equal(existsSync(outdir), false);
});
