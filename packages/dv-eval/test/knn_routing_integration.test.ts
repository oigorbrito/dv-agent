import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkLedgerConformance } from "@dv-agent/core";
import { loadRoutingHistory } from "../src/bench/routing_history.ts";
import { runSmoke } from "../src/smoke/runner.ts";

test("routing_history: reconstrói knnExamples apenas da partição calibration e bloqueia holdout", () => {
	const index = loadRoutingHistory(["runs/roadmap-m2-calibration/summary.json"], {
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
});

test("runSmoke: --auth-mode offline-faux com --routing-history grava route_decided.knn_evidence e passa v4", async () => {
	const outdir = join(tmpdir(), `dv-knn-smoke-${Date.now()}`);
	try {
		const summary = await runSmoke({
			taskDir: resolve("packages/dv-eval/corpus/easy-01-calc"),
			policy: "predictive-harness-router",
			authMode: "offline-faux",
			routingHistory: ["runs/roadmap-m2-calibration/summary.json"],
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
		rmSync(outdir, { recursive: true, force: true });
	}
});
