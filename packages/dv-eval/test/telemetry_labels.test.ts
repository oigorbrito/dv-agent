// Rótulos de telemetria MEASURED / UNVERIFIABLE / INCONCLUSIVE: ledger -> métricas -> linha do resumo -> contrato. Offline.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONTRACT_V4_SHA256,
	CONTRACT_V5_SHA256,
	checkReportContracts,
	telemetryLabelProblems,
} from "../src/bench/contract_labels.ts";
import type { BenchReport, RunRecord } from "../src/bench/report.ts";
import { aggregate, formatTokenCount } from "../src/bench/report.ts";
import {
	callTelemetryStatus,
	metricsTelemetryStatus,
	type TelemetryStatus,
	worstTelemetryStatus,
} from "../src/bench/telemetry_status.ts";
import { readLedgerMetrics } from "../src/smoke/ledger_metrics.ts";

function step(status: TelemetryStatus | undefined, complete: boolean) {
	return {
		rung: 0,
		role: "executor",
		model: "agy/test",
		reasoning_effort: null,
		verdict: "PASS",
		run_status: "completed",
		ceiling_status: "unverifiable",
		spent_lower_bound_usd: 0,
		ledger_path: "l.jsonl",
		ledger_sha256: "0".repeat(64),
		metrics: {
			calls: 1,
			telemetry_complete: complete,
			...(status === undefined ? {} : { telemetry_status: status }),
			prompt_tokens: 10,
			completion_tokens: 1,
			total_tokens: 11,
			uncached_input_tokens: 10,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_usd: null,
		},
		conformance_status: "INCONCLUSIVE",
	};
}

function run(policy: string, steps: ReturnType<typeof step>[]): RunRecord {
	return {
		task_id: "t1",
		repeat: 0,
		tier: "easy",
		policy,
		final_outcome: "solved",
		solved: true,
		escalated: null,
		steps,
		conformance_status: "INCONCLUSIVE",
		conformance_violations: [],
	} as unknown as RunRecord;
}

function report(contractId: string, runs: RunRecord[]): BenchReport {
	const v5 = contractId === "p1-run-accounting-v5";
	return {
		schema: "dv-bench-summary-v2",
		contract_id: contractId,
		contract_sha256: v5 ? CONTRACT_V5_SHA256 : CONTRACT_V4_SHA256,
		auth_mode: "subscription",
		tier: "all",
		tiers: ["easy"],
		task: null,
		tasks: null,
		policies: [...new Set(runs.map((r) => r.policy))],
		model: null,
		escalation_model: null,
		ladder_models: null,
		max_cost_usd: 1,
		max_tokens: null,
		editor_limits: { maxTurns: 1, maxOutputTokens: 1 },
		repeats: 1,
		temperature: null,
		temperature_notes: [],
		runs,
		rows: aggregate(runs, [...new Set(runs.map((r) => r.policy))] as never, ["easy"]),
		conformance_violations: [],
	} as unknown as BenchReport;
}

test("ordem de severidade: MEASURED < UNVERIFIABLE < INCONCLUSIVE; lista vazia é INCONCLUSIVE", () => {
	assert.equal(worstTelemetryStatus(["MEASURED", "MEASURED"]), "MEASURED");
	assert.equal(worstTelemetryStatus(["MEASURED", "UNVERIFIABLE"]), "UNVERIFIABLE");
	assert.equal(worstTelemetryStatus(["UNVERIFIABLE", "INCONCLUSIVE", "MEASURED"]), "INCONCLUSIVE");
	assert.equal(worstTelemetryStatus([]), "INCONCLUSIVE");
});

test("chamada: usa cost_accounting_status válido; ledger antigo cai em telemetry_complete (nunca UNVERIFIABLE sem prova)", () => {
	assert.equal(
		callTelemetryStatus({ cost_accounting_status: "UNVERIFIABLE", telemetry_complete: false }),
		"UNVERIFIABLE",
	);
	assert.equal(callTelemetryStatus({ cost_accounting_status: "MEASURED", telemetry_complete: true }), "MEASURED");
	assert.equal(callTelemetryStatus({ cost_accounting_status: "bogus", telemetry_complete: true }), "MEASURED");
	assert.equal(callTelemetryStatus({ telemetry_complete: false }), "INCONCLUSIVE");
	assert.equal(metricsTelemetryStatus({ telemetry_complete: true }), "MEASURED", "resumo antigo sem o campo");
});

test("ledger: métricas do passo carregam a pior etiqueta das chamadas", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-tel-"));
	const path = join(dir, "ledger.jsonl");
	const call = (status: string, complete: boolean) =>
		JSON.stringify({
			event: "call_finished",
			record: {
				telemetry: {
					telemetry_complete: complete,
					cost_accounting_status: status,
					prompt_tokens: 5,
					completion_tokens: 1,
					total_tokens: 6,
				},
			},
		});
	writeFileSync(path, `${call("MEASURED", true)}\n${call("UNVERIFIABLE", false)}\n`);
	const metrics = readLedgerMetrics(path);
	assert.equal(metrics.telemetry_status, "UNVERIFIABLE");
	assert.equal(metrics.telemetry_complete, false);
	writeFileSync(path, `${call("MEASURED", true)}\n`);
	assert.equal(readLedgerMetrics(path).telemetry_status, "MEASURED");
});

test("linha do resumo: UNVERIFIABLE preservado (antes colapsava em INCONCLUSIVE); tokens não são exibidos como 0", () => {
	const rows = aggregate([run("agy-arm", [step("UNVERIFIABLE", false)])], ["agy-arm"] as never, ["easy"]);
	const row = rows.find((r) => r.tier === "all") ?? rows[0];
	assert.equal(row?.telemetry_status, "UNVERIFIABLE");
	assert.equal(formatTokenCount(0, "UNVERIFIABLE"), "unverifiable");
	const measured = aggregate([run("p", [step("MEASURED", true)])], ["p"] as never, ["easy"])[0];
	assert.equal(measured?.telemetry_status, "MEASURED");
	const mixed = aggregate([run("p", [step("MEASURED", true), step("INCONCLUSIVE", false)])], ["p"] as never, [
		"easy",
	])[0];
	assert.equal(mixed?.telemetry_status, "INCONCLUSIVE", "a pior etiqueta do grupo vence");
});

test("contrato: UNVERIFIABLE só sob v5; sob v4 é problema de rotulagem (mesma regra do conformance)", () => {
	const unverifiable = [run("agy-arm", [step("UNVERIFIABLE", false)])];
	const v4 = report("p1-run-accounting-v4", unverifiable);
	assert.ok(telemetryLabelProblems(v4, "resumo 1").some((p) => /exige contrato v5/.test(p)));
	const check = checkReportContracts([v4]);
	assert.equal(check.ok, false);
	const v5 = report("p1-run-accounting-v5", unverifiable);
	assert.deepEqual(telemetryLabelProblems(v5, "resumo 1"), []);
	assert.equal(checkReportContracts([v5]).ok, true);
});

test("contrato: rótulo fora do vocabulário é erro; v4 com MEASURED/INCONCLUSIVE segue válido", () => {
	const bogus = report("p1-run-accounting-v4", [run("p", [step("OK" as never, true)])]);
	assert.ok(telemetryLabelProblems(bogus, "r").some((p) => /inválido/.test(p)));
	const ok = report("p1-run-accounting-v4", [run("p", [step("MEASURED", true), step("INCONCLUSIVE", false)])]);
	assert.deepEqual(telemetryLabelProblems(ok, "r"), []);
	assert.equal(checkReportContracts([ok]).ok, true);
});
