// Sessão de assinatura no ledger: cost_usd null com cost_basis subscription_session. Não é "desconhecido" nem zero.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkLedgerConformance, executeRung } from "../src/index.ts";
import { fauxRuntime, tempDir, textTurn, usage } from "./support.ts";

test("run em sessão de assinatura: custo não aplicável, tokens medidos, teto não verificável, ledger conforme", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-sub"]);
	runtime.script([textTurn("ok", usage(1000, 50, { reasoning: 0 }))]);
	const ledgerPath = join(tempDir("sub-cost"), "ledger.jsonl");
	const result = await executeRung({
		ledgerPath,
		runId: "sub-1",
		harnessVariant: "subscription_test",
		referenceProvenance: { test: "subscription" },
		datasetSha256: "a".repeat(64),
		taskDefinitionSha256: "b".repeat(64),
		model: runtime.modelOf("dv-sub"),
		tools: [],
		prompt: "oi",
		streamFn: runtime.streamFn,
		priceBook: { kind: "subscription", id: "subscription-session", source: "teste" },
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.spentLowerBoundUsd, 0);
	assert.equal(result.ceilingStatus, "unverifiable");
	assert.deepEqual(checkLedgerConformance(ledgerPath).violations, []);

	const lines = readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const call = lines.find((ev) => ev.event === "call_finished") as { record: { telemetry: Record<string, unknown> } };
	assert.equal(call.record.telemetry.cost_usd, null);
	assert.equal(call.record.telemetry.cost_basis, "subscription_session");
	assert.deepEqual(call.record.telemetry.declared_not_applicable, ["cost_usd"]);
	assert.deepEqual(call.record.telemetry.missing_buckets, []);
	assert.equal(call.record.telemetry.cost_accounting_status, "MEASURED");
	const finished = lines.at(-1) as Record<string, unknown>;
	assert.equal(finished.non_metered_cost_calls, 1);
	assert.equal(finished.unknown_cost_calls, 0);
});

test("o verificador rejeita custo em USD numa sessão de assinatura", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-sub"]);
	runtime.script([textTurn("ok", usage(1000, 50, { reasoning: 0 }))]);
	const ledgerPath = join(tempDir("sub-neg"), "ledger.jsonl");
	await executeRung({
		ledgerPath,
		runId: "sub-2",
		harnessVariant: "subscription_test",
		referenceProvenance: { test: "subscription" },
		datasetSha256: "a".repeat(64),
		taskDefinitionSha256: "b".repeat(64),
		model: runtime.modelOf("dv-sub"),
		tools: [],
		prompt: "oi",
		streamFn: runtime.streamFn,
		priceBook: { kind: "subscription", id: "subscription-session", source: "teste" },
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	const tampered = readFileSync(ledgerPath, "utf8").replace(/"cost_usd":null/, '"cost_usd":0.5');
	const path = join(tempDir("sub-neg-file"), "tampered.jsonl");
	writeFileSync(path, tampered);
	assert.match(checkLedgerConformance(path).violations.join("|"), /sessão de assinatura não pode ter cost_usd/);
});
