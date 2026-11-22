// (a) O ledger.jsonl gerado por um run offline cumpre o contrato p1-run-accounting-v4 (regras a, c, d) e o schema dv-run-ledger-v2.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetGuard, CONTRACT_ID, checkLedgerConformance, executeRung, LEDGER_SCHEMA } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage, writeFileTool } from "./support.ts";

const PROVENANCE = {
	harness: "dv-core",
	dv_agent_commit: "uncommitted-test",
	pi_mono: "69a6993486acee850d14a4a1547daa4a167228ad",
};
const DATASET = "a".repeat(64);
const TASK = "b".repeat(64);
const SECRET = "sk-ant-api03-SEGREDOdeTESTE0123456789";

function parseLedger(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("run anthropic-capável gera ledger conforme ao contrato v4 com telemetria MEASURED", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	const workspace = new Map<string, string>();
	const ledgerPath = join(tempDir("ledger-conf"), "ledger.jsonl");
	runtime.script([
		toolTurn("write_file", { path: "out.txt", content: "41" }, usage(1000, 50, { cacheRead: 200, reasoning: 0 })),
		toolTurn(
			"write_file",
			{ path: "out.txt", content: `42 ${SECRET}` },
			usage(1100, 60, { cacheRead: 200, reasoning: 0 }),
		),
		textTurn("concluído", usage(1200, 10, { cacheRead: 200, reasoning: 0 })),
	]);

	const result = await executeRung({
		ledgerPath,
		runId: "run-a-1",
		harnessVariant: "b0_test",
		referenceProvenance: PROVENANCE,
		datasetSha256: DATASET,
		taskDefinitionSha256: TASK,
		model: runtime.modelOf("dv-cheap"),
		tools: [writeFileTool(workspace)],
		prompt: "grave 42 em out.txt",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/dv-cheap"]),
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});

	assert.equal(result.status, "completed");
	assert.equal(workspace.get("out.txt"), `42 ${SECRET}`);

	const report = checkLedgerConformance(ledgerPath);
	assert.deepEqual(report.violations, []);
	assert.equal(report.ok, true);

	const events = parseLedger(ledgerPath);
	assert.deepEqual(
		events.map((ev) => ev.event),
		[
			"run_started",
			"call_started",
			"call_finished",
			"tool_finished",
			"call_started",
			"call_finished",
			"tool_finished",
			"call_started",
			"call_finished",
			"run_finished",
		],
	);
	for (const ev of events) assert.equal(ev.schema, LEDGER_SCHEMA);

	const started = events[0] as Record<string, unknown>;
	assert.equal(started.contract_id, CONTRACT_ID);
	assert.equal(started.dataset_sha256, DATASET);
	assert.equal(started.task_definition_sha256, TASK);

	const calls = events.filter((ev) => ev.event === "call_finished");
	for (const call of calls) {
		const telemetry = (call.record as { telemetry: Record<string, unknown> }).telemetry;
		assert.equal(telemetry.telemetry_complete, true);
		assert.equal(telemetry.cost_accounting_status, "MEASURED");
		assert.equal(telemetry.cost_basis, "price_book:test-prices-v1");
		assert.equal(telemetry.uncached_input_tokens, (call.record as { usage: { input: number } }).usage.input);
	}
	// Primeira chamada: prompt = 1000 uncached + 200 cache_read; total = prompt + output.
	const firstTelemetry = (calls[0]?.record as { telemetry: Record<string, unknown> }).telemetry;
	assert.equal(firstTelemetry.prompt_tokens, 1200);
	assert.equal(firstTelemetry.total_tokens, 1250);
	// Custo: 1000*1 + 50*4 + 200*0.1 = 1220 por milhão -> 0.00122 USD.
	assert.ok(Math.abs((firstTelemetry.cost_usd as number) - 0.00122) < 1e-12);

	const finished = events.at(-1) as Record<string, unknown>;
	assert.equal(finished.status, "completed");
	assert.equal(finished.ceiling_status, "within_verified");
	assert.equal(finished.calls_started, 3);
	assert.equal(finished.calls_finished, 3);
});

test("ledger não contém segredo em claro e o digest final bate com os bytes do arquivo", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	const workspace = new Map<string, string>();
	const ledgerPath = join(tempDir("ledger-secret"), "ledger.jsonl");
	runtime.script([
		toolTurn("write_file", { path: "out.txt", content: `token ${SECRET}` }, usage(10, 5, { reasoning: 0 })),
		textTurn("ok", usage(10, 5, { reasoning: 0 })),
	]);
	const result = await executeRung({
		ledgerPath,
		runId: "run-a-2",
		harnessVariant: "b0_test",
		referenceProvenance: PROVENANCE,
		datasetSha256: DATASET,
		taskDefinitionSha256: TASK,
		model: runtime.modelOf("dv-cheap"),
		tools: [writeFileTool(workspace)],
		prompt: "grave",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/dv-cheap"]),
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	const raw = readFileSync(ledgerPath, "utf8");
	assert.equal(raw.includes("sk-ant-api03"), false);
	assert.ok(raw.includes("[REDACTED]"));
	assert.equal(result.ledgerSha256, createHash("sha256").update(readFileSync(ledgerPath)).digest("hex"));
	assert.deepEqual(checkLedgerConformance(ledgerPath).violations, []);
});

test("provedor sem regra de capacidade: telemetria INCONCLUSIVE e teto não verificado, sem falha silenciosa", async () => {
	const runtime = fauxRuntime("dv-unknown-provider", ["dv-model"]);
	const ledgerPath = join(tempDir("ledger-unknown"), "ledger.jsonl");
	runtime.script([textTurn("ok", usage(10, 5))]);
	const result = await executeRung({
		ledgerPath,
		runId: "run-a-3",
		harnessVariant: "b0_test",
		referenceProvenance: PROVENANCE,
		datasetSha256: DATASET,
		taskDefinitionSha256: TASK,
		model: runtime.modelOf("dv-model"),
		tools: [],
		prompt: "oi",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor([]),
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	assert.equal(result.ceilingStatus, "unverifiable");
	assert.equal(result.unknownCostCalls, 1);
	const call = parseLedger(ledgerPath).find((ev) => ev.event === "call_finished") as {
		record: { telemetry: Record<string, unknown> };
	};
	assert.equal(call.record.telemetry.telemetry_complete, false);
	assert.equal(call.record.telemetry.cost_accounting_status, "INCONCLUSIVE");
	assert.equal(call.record.telemetry.cost_usd, null);
	// reasoning é declarado não exposto pelo transporte faux, então não é faltante; uncached e custo faltam.
	assert.deepEqual(call.record.telemetry.missing_buckets, ["uncached_input_tokens", "cost_usd"]);
	assert.deepEqual(checkLedgerConformance(ledgerPath).violations, []);
});

test("o verificador rejeita ledgers adulterados (não é vacuamente verdadeiro)", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	const ledgerPath = join(tempDir("ledger-neg"), "ledger.jsonl");
	runtime.script([textTurn("ok", usage(10, 5, { reasoning: 0 }))]);
	await executeRung({
		ledgerPath,
		runId: "run-a-4",
		harnessVariant: "b0_test",
		referenceProvenance: PROVENANCE,
		datasetSha256: DATASET,
		taskDefinitionSha256: TASK,
		model: runtime.modelOf("dv-cheap"),
		tools: [],
		prompt: "oi",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/dv-cheap"]),
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	const original = readFileSync(ledgerPath, "utf8");
	const lines = original.split("\n").filter((line) => line.length > 0);

	const noCallFinished = join(tempDir("neg-1"), "l.jsonl");
	writeFileSync(noCallFinished, lines.filter((line) => !line.includes('"event":"call_finished"')).join("\n") + "\n");
	assert.match(checkLedgerConformance(noCallFinished).violations.join("|"), /em voo|run_finished com chamadas em voo/);

	const crlf = join(tempDir("neg-2"), "l.jsonl");
	writeFileSync(crlf, original.replaceAll("\n", "\r\n"));
	assert.match(checkLedgerConformance(crlf).violations.join("|"), /CR presentes/);

	const wrongSum = join(tempDir("neg-3"), "l.jsonl");
	writeFileSync(wrongSum, original.replace(/"spent_lower_bound_usd":[0-9.e-]+/, '"spent_lower_bound_usd":99'));
	assert.match(checkLedgerConformance(wrongSum).violations.join("|"), /spent_lower_bound_usd diverge/);

	const secretLeak = join(tempDir("neg-4"), "l.jsonl");
	writeFileSync(secretLeak, original.replace('"event":"run_started"', `"event":"run_started","leak":"${SECRET}"`));
	assert.match(checkLedgerConformance(secretLeak).violations.join("|"), /segredo/);
});

test("BudgetGuard sem custo conhecido não declara teto cumprido", () => {
	const guard = new BudgetGuard({ maxCostUsd: 1, priceBook: priceBookFor([]) });
	assert.equal(guard.ceilingStatus(), "within_verified");
	guard.onMessageEnd(textTurn("x", usage(1, 1)).message);
	assert.equal(guard.ceilingStatus(), "unverifiable");
	assert.equal(guard.spentLowerBoundUsd, 0);
});
