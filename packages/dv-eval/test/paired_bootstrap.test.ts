// Bootstrap pareado determinístico por tarefa e integração offline da CLI de métricas.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CONTRACT_V4_SHA256 } from "../src/bench/contract_labels.ts";
import { computePairedBootstrap, renderPairedBootstrap } from "../src/bench/paired_bootstrap.ts";
import type { BenchReport, RunRecord } from "../src/bench/report.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

function run(
	task: string,
	policy: "single" | "ladder",
	solved: boolean,
	tokens: number,
	cost: number | null,
): RunRecord {
	return {
		task_id: task,
		repeat: 0,
		tier: "easy",
		policy,
		final_outcome: solved ? "solved" : "unsolved",
		solved,
		escalated: policy === "ladder" ? false : null,
		steps: [
			{
				rung: 0,
				role: "executor",
				model: "anthropic/test-model",
				reasoning_effort: null,
				verdict: solved ? "PASS" : "FAIL",
				run_status: "completed",
				ceiling_status: "within_verified",
				spent_lower_bound_usd: cost ?? 0,
				ledger_path: `ledger-${task}-${policy}.jsonl`,
				ledger_sha256: "0".repeat(64),
				metrics: {
					calls: 1,
					telemetry_complete: cost !== null,
					prompt_tokens: tokens,
					completion_tokens: 0,
					total_tokens: tokens,
					uncached_input_tokens: tokens,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					cost_usd: cost,
				},
				conformance_status: "PASS",
			},
		],
		conformance_status: "PASS",
		conformance_violations: [],
	};
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
		policies: ["single", "ladder"],
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
	};
}

function fixture(): BenchReport {
	return report([
		run("task-a", "single", true, 100, 1),
		run("task-a", "ladder", false, 150, 1.5),
		run("task-b", "single", false, 200, 2),
		run("task-b", "ladder", false, 180, 1.8),
		run("task-c", "single", true, 300, 3),
		run("task-c", "ladder", true, 360, 3.6),
	]);
}

test("bootstrap pareado: diferenças por tarefa e IC são determinísticos para o mesmo seed", () => {
	const input = fixture();
	const options = { policyA: "single", policyB: "ladder", seed: 7, resamples: 500 };
	const first = computePairedBootstrap([input], options);
	const second = computePairedBootstrap([input], options);
	assert.deepEqual(first, second);
	assert.equal(first.tasks, 3);
	assert.equal(first.repeats, 1);
	assert.equal(first.pass_rate_difference.estimate, -1 / 3);
	assert.equal(first.total_tokens_difference.estimate, 30);
	assert.ok(Math.abs((first.cost_usd_difference.estimate ?? 0) - 0.3) < 1e-12);
	assert.ok(first.pass_rate_difference.ci95?.[0] !== undefined);
	assert.ok(first.pass_rate_difference.ci95?.[1] !== undefined);
	assert.equal(first.pass_rate_difference.defined_resamples, 500);
	assert.ok(first.pass_rate_difference.ci95?.[0] !== undefined && first.pass_rate_difference.ci95[0] <= 0);
	assert.ok(first.pass_rate_difference.ci95?.[1] !== undefined && first.pass_rate_difference.ci95[1] >= 0);
	assert.equal(first.spent_lower_bound_usd_difference.units, 3);
});

test("bootstrap pareado: IC exclui zero quando todas as tarefas melhoram", () => {
	const input = report([
		run("task-a", "single", false, 100, 1),
		run("task-a", "ladder", true, 90, 0.9),
		run("task-b", "single", false, 100, 1),
		run("task-b", "ladder", true, 90, 0.9),
		run("task-c", "single", false, 100, 1),
		run("task-c", "ladder", true, 90, 0.9),
	]);
	const result = computePairedBootstrap([input], { policyA: "single", policyB: "ladder", seed: 5, resamples: 100 });
	assert.deepEqual(result.pass_rate_difference.ci95, [1, 1]);
	assert.deepEqual(result.total_tokens_difference.ci95, [-10, -10]);
	assert.match(renderPairedBootstrap(result), /IC exclui zero/);
	assert.match(renderPairedBootstrap(result), /\| solve_rate \| 1\.000000 \| \[1\.000000; 1\.000000\] \| 3 \| sim \|/);
});

test("bootstrap pareado: custo desconhecido fica fora da métrica, sem virar zero", () => {
	const input = report([
		run("task-a", "single", true, 100, null),
		run("task-a", "ladder", true, 110, null),
		run("task-b", "single", false, 120, 0.2),
		run("task-b", "ladder", true, 130, 0.3),
	]);
	const result = computePairedBootstrap([input], { policyA: "single", policyB: "ladder", seed: 1, resamples: 20 });
	assert.equal(result.cost_usd_difference.units, 1);
	assert.ok(Math.abs((result.cost_usd_difference.estimate ?? 0) - 0.1) < 1e-12);
	assert.equal(result.total_tokens_difference.units, 1);
});

test("bootstrap pareado: rejeita conjuntos task/repeat diferentes", () => {
	const input = report([run("task-a", "single", true, 100, 1), run("task-b", "ladder", true, 100, 1)]);
	assert.throws(
		() => computePairedBootstrap([input], { policyA: "single", policyB: "ladder" }),
		/different task\/repeat sets/,
	);
});

test("dv-bench-metrics: opção de bootstrap funciona offline em faux", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-paired-bootstrap-"));
	const input = join(dir, "summary.json");
	writeFileSync(input, JSON.stringify(fixture()), "utf8");
	const result = spawnSync(
		process.execPath,
		[
			"scripts/dv-bench-metrics.ts",
			"--baseline",
			"single",
			"--treatment",
			"ladder",
			"--seed",
			"7",
			"--resamples",
			"100",
			dir,
		],
		{ cwd: ROOT, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Bootstrap pareado por tarefa/);
	assert.match(result.stdout, /solve_rate/);
	assert.match(result.stdout, /total tokens/);
	assert.match(result.stdout, /custo USD/);
	assert.match(result.stdout, /spent_lower_bound_usd/);
	assert.match(
		renderPairedBootstrap(computePairedBootstrap([fixture()], { policyA: "single", policyB: "ladder" })),
		/IC 95%/,
	);
});
