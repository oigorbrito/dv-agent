// Routing history: calibração explicitamente particionada, leakage guard e CLI faux de ponta a ponta.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertNoRoutingHistoryLeakage, loadRoutingHistory } from "../src/bench/routing_history.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORPUS = resolve(import.meta.dirname, "../corpus");

function report(taskId: string, verdicts: readonly ("PASS" | "FAIL")[], ledgerHashes?: readonly string[]) {
	return {
		schema: "dv-bench-summary-v2",
		contract_id: "p1-run-accounting-v4",
		tier: taskId.startsWith("easy-") ? "easy" : "frontier",
		runs: verdicts.map((verdict, repeat) => ({
			task_id: taskId,
			tier: taskId.startsWith("easy-") ? "easy" : "frontier",
			policy: "single",
			repeat,
			steps: [
				{
					rung: 0,
					model: "anthropic/faux-cheap",
					verdict,
					ledger_sha256:
						ledgerHashes?.[repeat] ?? createHash("sha256").update(`${taskId}:${repeat}:${verdict}`).digest("hex"),
				},
			],
		})),
	};
}

function saveSummary(dir: string, value: unknown): string {
	const path = join(dir, "summary.json");
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return path;
}

test("loader: aceita resumos somente de tarefas da partição calibration e registra path/hash", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-route-calibration-"));
	const path = saveSummary(dir, report("easy-01-calc", ["FAIL", "FAIL", "FAIL"]));
	const index = loadRoutingHistory([path], { corpusDir: CORPUS, partition: "calibration" });
	assert.equal(index.partition, "calibration");
	assert.equal(index.observations.length, 3);
	assert.equal(index.sources[0]?.path, resolve(path));
	assert.equal(index.sources[0]?.sha256, createHash("sha256").update(readFileSync(path)).digest("hex"));
});

test("loader: recusa task holdout no summary para evitar data leakage", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-route-holdout-"));
	const path = saveSummary(dir, report("easy-02-log-parser", ["FAIL", "FAIL", "FAIL"]));
	assert.throws(
		() => loadRoutingHistory([path], { corpusDir: CORPUS, partition: "calibration" }),
		/data leakage recusado: easy-02-log-parser não pertence à partição de calibração/,
	);
});

test("leakage guard: recusa ledger histórico repetido no outdir atual", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-route-overlap-"));
	const ledgerContent = "identical historical execution\n";
	const ledgerHash = createHash("sha256").update(ledgerContent).digest("hex");
	const historyPath = saveSummary(dir, report("easy-01-calc", ["FAIL"], [ledgerHash]));
	const index = loadRoutingHistory([historyPath], { corpusDir: CORPUS, partition: "train" });
	const outdir = join(dir, "current-out");
	mkdirSync(join(outdir, "step-0"), { recursive: true });
	writeFileSync(join(outdir, "step-0", "ledger.jsonl"), ledgerContent, "utf8");
	assert.throws(() => assertNoRoutingHistoryLeakage(index, outdir), /data leakage recusado/);
});

test("CLI faux: predictive router consome history repetido e ladder mista agy/Haiku/Sonnet, sem chamadas live", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-route-cli-"));
	const historyPath = saveSummary(dir, report("easy-01-calc", ["FAIL", "FAIL", "FAIL"]));
	const outdir = join(dir, "out");
	const result = spawnSync(
		process.execPath,
		[
			"scripts/dv-smoke.ts",
			"--policy",
			"predictive-harness-router",
			"--auth-mode",
			"faux",
			"--task",
			join(CORPUS, "easy-01-calc"),
			"--ladder-models",
			"agy/gemini-3.8-flash-high,anthropic/claude-haiku-5-5,anthropic/claude-sonnet-4-6",
			"--routing-history",
			historyPath,
			"--routing-history",
			historyPath,
			"--routing-history-partition",
			"calibration",
			"--outdir",
			outdir,
		],
		{ cwd: ROOT, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const summary = JSON.parse(readFileSync(join(outdir, "summary.json"), "utf8")) as {
		final_outcome: string;
		steps: { rung: number; model: string; ledger_path: string }[];
	};
	assert.equal(summary.final_outcome, "solved");
	assert.deepEqual(
		summary.steps.map((step) => step.rung),
		[1, 2],
	);
	const route = JSON.parse(readFileSync(summary.steps[0]!.ledger_path, "utf8").split("\n")[1]!) as {
		empirical_evidence: {
			partition: string;
			sources: { path: string; sha256: string }[];
			n: number;
			failure_rate: number;
			start_rung: number;
		};
	};
	assert.equal(route.empirical_evidence.partition, "calibration");
	assert.equal(route.empirical_evidence.sources[0]?.path, resolve(historyPath));
	assert.equal(route.empirical_evidence.n, 3, "summary repetido não duplica a amostra");
	assert.equal(route.empirical_evidence.failure_rate, 1);
	assert.equal(route.empirical_evidence.start_rung, 1);
});
