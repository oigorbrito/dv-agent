// Contratos v4 (congelado) e v5 (ratificado): integridade dos arquivos, tabela de capacidades por versão e conformidade
// reagindo a versão errada. Offline; o agy é o mock em memória.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	agyModel,
	buildCallTelemetry,
	CONTRACT_ID,
	CONTRACT_V5_ID,
	checkLedgerConformance,
	createAgyMockSpawn,
	createAgyStreamFn,
	executeRung,
	SUPPORTED_CONTRACT_IDS,
} from "../src/index.ts";
import { tempDir } from "./support.ts";

const CONTRACTS = resolve(import.meta.dirname, "../../../contracts");
const V4_SHA = "11b4d5453e0964a7eb88decb5cbf7d1c5f5eebf4fbbdd458fb4e38686baef486";

function sha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("v4 congelado: SHA-256 inalterado e id p1-run-accounting-v4", () => {
	assert.equal(sha(join(CONTRACTS, "run-accounting-contract-v4.json")), V4_SHA);
	assert.equal(CONTRACT_ID, "p1-run-accounting-v4");
});

test("v5: arquivo derivado do v4, ratificado e PROVENANCE com o SHA real", () => {
	const v5Path = join(CONTRACTS, "run-accounting-contract-v5.json");
	const v5 = JSON.parse(readFileSync(v5Path, "utf8")) as {
		contract_id: string;
		status: string;
		supersedes: string;
		ratified_on: string;
	};
	assert.equal(v5.ratified_on, "2026-11-24");
	assert.equal(v5.contract_id, CONTRACT_V5_ID);
	assert.equal(v5.status, "RATIFIED", "v5 ratificado em 2026-11-24");
	assert.match(v5.supersedes, /p1-run-accounting-v4/);
	const prov = JSON.parse(readFileSync(join(CONTRACTS, "PROVENANCE-v5.json"), "utf8")) as {
		sha256: string;
		derived_from_sha256: string;
		status: string;
	};
	assert.equal(prov.status, "RATIFIED");
	assert.equal(prov.sha256, sha(v5Path));
	assert.equal(prov.derived_from_sha256, V4_SHA);
});

test("tabelas de capacidade: v4 não tem linha para o agy; v5 tem a regra condicional", () => {
	const v4 = JSON.parse(readFileSync(join(CONTRACTS, "run-accounting-contract-v4.json"), "utf8")) as {
		normative_rules: { b_uncached_and_lower_bound: { capability_table: Record<string, unknown> } };
	};
	const v5 = JSON.parse(readFileSync(join(CONTRACTS, "run-accounting-contract-v5.json"), "utf8")) as {
		normative_rules: { b_uncached_and_lower_bound: { capability_table: Record<string, { status: string }> } };
	};
	assert.equal("agy" in v4.normative_rules.b_uncached_and_lower_bound.capability_table, false);
	assert.equal(v5.normative_rules.b_uncached_and_lower_bound.capability_table.agy?.status, "CONDITIONAL_V5");
});

test("contratos aceitos: v4 e v5, nenhum outro", () => {
	assert.deepEqual([...SUPPORTED_CONTRACT_IDS], [CONTRACT_ID, CONTRACT_V5_ID]);
});

// ---------- telemetria por versão ----------

const usage = (
	o: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }>,
) => ({
	input: o.input ?? 13193,
	output: o.output ?? 132,
	cacheRead: o.cacheRead ?? 0,
	cacheWrite: o.cacheWrite ?? 0,
	totalTokens: o.totalTokens ?? 13325,
	reasoning: 131,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
});
const msg = (u: ReturnType<typeof usage>) =>
	({
		role: "assistant",
		api: "agy-acp",
		provider: "agy",
		model: "gemini-3.8-flash-high",
		content: [],
		usage: u,
		stopReason: "stop",
		timestamp: 0,
	}) as never;
const SUB = { kind: "subscription", id: "t", source: "t" } as const;

test("telemetria agy sob v5: cache zero e total = I + O -> MEASURED, uncached = inputTokens", () => {
	const t = buildCallTelemetry("agy", msg(usage({})), SUB, { contractId: CONTRACT_V5_ID });
	assert.equal(t.cost_accounting_status, "MEASURED");
	assert.equal(t.uncached_input_tokens, 13193);
	assert.equal(t.telemetry_complete, true);
});

test("telemetria agy sob v5: cache ativo -> UNVERIFIABLE, uncached null, motivo registrado", () => {
	const t = buildCallTelemetry("agy", msg(usage({ input: 1193, cacheRead: 12000, totalTokens: 13325 })), SUB, {
		contractId: CONTRACT_V5_ID,
	});
	assert.equal(t.cost_accounting_status, "UNVERIFIABLE");
	assert.equal(t.uncached_input_tokens, null);
	assert.ok(t.missing_buckets.includes("agy_cache_semantics_unverified"));
	assert.equal(t.telemetry_complete, false);
});

test("telemetria agy sob v5: total inconsistente -> INCONCLUSIVE (nunca MEASURED)", () => {
	const t = buildCallTelemetry("agy", msg(usage({ totalTokens: 99999 })), SUB, { contractId: CONTRACT_V5_ID });
	assert.equal(t.cost_accounting_status, "INCONCLUSIVE");
	assert.ok(t.missing_buckets.includes("agy_usage_inconsistent"));
});

test("telemetria agy sob v4 (sem contrato v5): sem regra, uncached null, INCONCLUSIVE", () => {
	const t = buildCallTelemetry("agy", msg(usage({})), SUB, { contractId: CONTRACT_ID });
	assert.equal(t.uncached_input_tokens, null);
	assert.equal(t.cost_accounting_status, "INCONCLUSIVE");
});

test("telemetria de outros provedores não muda com a versão do contrato", () => {
	const m = { ...(msg(usage({})) as object), api: "anthropic-messages", provider: "anthropic" } as never;
	const v4 = buildCallTelemetry("anthropic", m, SUB, { contractId: CONTRACT_ID });
	const v5 = buildCallTelemetry("anthropic", m, SUB, { contractId: CONTRACT_V5_ID });
	assert.deepEqual(v4, v5);
});

// ---------- conformidade reage à versão do ledger ----------

test("conformidade: ledger v5 com UNVERIFIABLE reescrito como v4 é FAIL (estado exige v5)", async () => {
	const warm = {
		inputTokens: 1193,
		outputTokens: 118,
		cachedReadTokens: 12000,
		cachedWriteTokens: 0,
		thoughtTokens: 117,
		totalTokens: 13311,
	};
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: warm });
	const ledgerPath = join(tempDir("contract-v5-tamper"), "ledger.jsonl");
	await executeRung({
		ledgerPath,
		runId: "tamper",
		harnessVariant: "dv-contract-test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: agyModel("gemini-3.8-flash-high"),
		tools: [],
		prompt: "responda ok",
		streamFn: createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn }),
		priceBook: { kind: "subscription", id: "agy-local", source: "login local" },
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
		approvedProbes: new Set(["agy"]),
		contractId: CONTRACT_V5_ID,
	});
	const original = readFileSync(ledgerPath, "utf8");
	assert.equal(checkLedgerConformance(ledgerPath).status === "FAIL", false);
	const tampered = join(tempDir("contract-v5-tamper-v4"), "ledger.jsonl");
	writeFileSync(tampered, original.replace(`"contract_id":"${CONTRACT_V5_ID}"`, `"contract_id":"${CONTRACT_ID}"`));
	const report = checkLedgerConformance(tampered);
	assert.equal(report.status, "FAIL");
	assert.ok(
		report.violations.some((v) => /exige contrato v5/.test(v)),
		report.violations.join("; "),
	);
});

test("conformidade: contract_id desconhecido é violação", async () => {
	const mock = createAgyMockSpawn({
		chunks: ["ok"],
		usage: {
			inputTokens: 13193,
			outputTokens: 132,
			cachedReadTokens: 0,
			cachedWriteTokens: 0,
			thoughtTokens: 131,
			totalTokens: 13325,
		},
	});
	const ledgerPath = join(tempDir("contract-unknown"), "ledger.jsonl");
	await executeRung({
		ledgerPath,
		runId: "unknown",
		harnessVariant: "dv-contract-test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: agyModel("gemini-3.8-flash-high"),
		tools: [],
		prompt: "responda ok",
		streamFn: createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn }),
		priceBook: { kind: "subscription", id: "agy-local", source: "login local" },
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
		approvedProbes: new Set(["agy"]),
		contractId: CONTRACT_V5_ID,
	});
	const bad = join(tempDir("contract-unknown-2"), "ledger.jsonl");
	writeFileSync(
		bad,
		readFileSync(ledgerPath, "utf8").replace(
			`"contract_id":"${CONTRACT_V5_ID}"`,
			'"contract_id":"p1-run-accounting-v9"',
		),
	);
	const report = checkLedgerConformance(bad);
	assert.equal(report.status, "FAIL");
	assert.ok(report.violations.some((v) => /não suportado/.test(v)));
});
