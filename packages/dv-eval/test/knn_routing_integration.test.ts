import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkLedgerConformance } from "@dv-agent/core";
import { discoverCorpus } from "../src/bench/corpus.ts";
import { partitionTaskIds } from "../src/bench/routing_calibration.ts";
import { loadRoutingHistory } from "../src/bench/routing_history.ts";
import { runSmoke } from "../src/smoke/runner.ts";

function buildCalibrationFixtureSummary(dir: string): string {
	const tasks = discoverCorpus("packages/dv-eval/corpus");
	const partition = partitionTaskIds(tasks.map((t) => t.id));
	const calIds = new Set(partition.calibration);
	const runs = tasks
		.filter((t) => calIds.has(t.id))
		.map((t, idx) => ({
			task_id: t.id,
			tier: t.tier,
			policy: "single",
			final_outcome: "solved",
			steps: [
				{
					rung: 0,
					role: "executor",
					model: "anthropic/claude-haiku-5-5",
					ledger_sha256: idx.toString(16).padStart(64, "0"),
					verdict: t.tier === "hard" || t.tier === "frontier" ? "FAIL" : "PASS",
					verification: { status: t.tier === "hard" || t.tier === "frontier" ? "fail" : "pass" },
				},
			],
		}));
	const summaryPath = join(dir, "summary.json");
	writeFileSync(summaryPath, JSON.stringify({ schema: "dv-bench-summary-v2", runs }, null, 2), "utf8");
	return summaryPath;
}

test("routing_history: reconstrói knnExamples apenas da partição calibration e bloqueia holdout", () => {
	const dir = join(tmpdir(), `dv-knn-hist-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	try {
		const summaryPath = buildCalibrationFixtureSummary(dir);
		const index = loadRoutingHistory([summaryPath], {
			corpusDir: "packages/dv-eval/corpus",
			partition: "calibration",
		});
		const examples = index.knnExamples ?? [];
		assert.equal(examples.length, 9);
		assert.ok(examples.every((e) => e.partition === "calibration"));
		assert.equal(index.knnHoldoutIds?.length, 9);
		for (const holdId of index.knnHoldoutIds ?? []) {
			assert.equal(
				examples.some((e) => e.taskId === holdId),
				false,
				`vazamento de holdout detectado: ${holdId}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSmoke: --auth-mode offline-faux com --routing-history grava route_decided.knn_evidence e passa v4", async () => {
	const dir = join(tmpdir(), `dv-knn-smoke-${Date.now()}`);
	const outdir = join(dir, "out");
	mkdirSync(dir, { recursive: true });
	try {
		const summaryPath = buildCalibrationFixtureSummary(dir);
		const summary = await runSmoke({
			taskDir: resolve("packages/dv-eval/corpus/easy-01-calc"),
			policy: "predictive-harness-router",
			authMode: "offline-faux",
			routingHistory: [summaryPath],
			routingHistoryPartition: "calibration",
			outdir,
			maxCostUsd: 1,
			probesDir: resolve("packages/dv-eval/probe-results"),
		});
		assert.equal(summary.final_outcome, "solved");
		assert.ok(summary.steps.length >= 1);
		const ledgerLines = readFileSync(summary.steps[0].ledger_path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const routeEvent = ledgerLines.find((ev) => ev.event === "route_decided");
		assert.ok(routeEvent !== undefined, "evento route_decided ausente no ledger");
		assert.ok(routeEvent.knn_evidence !== undefined, "knn_evidence ausente em route_decided");
		const audit = checkLedgerConformance(summary.steps[0].ledger_path);
		assert.equal(audit.ok, true, `falha v4: ${JSON.stringify(audit.violations)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
