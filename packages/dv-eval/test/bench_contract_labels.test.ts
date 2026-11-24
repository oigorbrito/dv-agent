// Rotulagem de contrato no resumo do bench (v4 sem agy, v5 com agy) e validação de resumos combinados.
// Offline: execuções com o runtime faux (zero tokens). Nenhuma chamada live.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CONTRACT_ID, CONTRACT_V5_FILE, CONTRACT_V5_ID } from "@dv-agent/core";
import { CONTRACT_PATH, runBench } from "../src/bench/ablation.ts";
import {
	benchContractId,
	CONTRACT_SHA_BY_ID,
	checkReportContracts,
	isAgyModelRef,
} from "../src/bench/contract_labels.ts";
import type { BenchReport } from "../src/bench/report.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORPUS = resolve(import.meta.dirname, "../corpus");
const PROBES = mkdtempSync(join(tmpdir(), "dv-contract-probes-"));

function sha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ledgersUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name === "ledger.jsonl") out.push(p);
		}
	};
	walk(dir);
	return out;
}

function runOptions(outdir: string, model?: string) {
	return {
		corpusDir: CORPUS,
		tier: "all" as const,
		task: "easy-01-calc",
		policies: ["single" as const],
		authMode: "offline-faux" as const,
		...(model === undefined ? {} : { model }),
		maxCostUsd: 0.05,
		outdir,
		probesDir: PROBES,
		contractPath: join(ROOT, CONTRACT_PATH),
	};
}

test("rótulo: sem agy o contrato é v4; com qualquer modelo agy/ é v5", () => {
	assert.equal(benchContractId([undefined, undefined]), CONTRACT_ID);
	assert.equal(benchContractId(["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-4-6"]), CONTRACT_ID);
	assert.equal(benchContractId(["agy/gemini-3.8-flash-high", undefined]), CONTRACT_V5_ID);
	assert.equal(benchContractId(["anthropic/claude-haiku-5-5", "agy/claude-sonnet-4-6"]), CONTRACT_V5_ID);
	// Só o namespace agy/ conta: texto parecido dentro de outro provedor não.
	assert.equal(isAgyModelRef("anthropic/agy/x"), false);
});

test("SHA-256 esperados batem com os arquivos (v4 congelado e v5 ratificado)", () => {
	assert.equal(CONTRACT_SHA_BY_ID[CONTRACT_ID], sha(join(ROOT, CONTRACT_PATH)));
	assert.equal(CONTRACT_SHA_BY_ID[CONTRACT_V5_ID], sha(join(ROOT, CONTRACT_V5_FILE)));
});

test("resumo com provedor Anthropic: contract_id v4, SHA do v4 e ledgers v4", async () => {
	const outdir = join(mkdtempSync(join(tmpdir(), "dv-contract-v4-")), randomUUID());
	const report = await runBench(runOptions(outdir, "anthropic/claude-haiku-5-5"));
	assert.equal(report.contract_id, CONTRACT_ID);
	assert.equal(report.contract_sha256, CONTRACT_SHA_BY_ID[CONTRACT_ID]);
	const summary = JSON.parse(readFileSync(join(outdir, "summary.json"), "utf8")) as BenchReport;
	assert.equal(summary.contract_id, CONTRACT_ID);
	assert.ok(summary.runs.every((r) => r.contract_id === CONTRACT_ID));
	const ledgers = ledgersUnder(outdir);
	assert.ok(ledgers.length > 0);
	for (const path of ledgers) {
		const started = JSON.parse(readFileSync(path, "utf8").split("\n")[0] as string) as { contract_id: string };
		assert.equal(started.contract_id, summary.contract_id, "ledger e resumo com o mesmo contrato");
	}
});

test("resumo com braço agy: contract_id v5, SHA do v5 e ledgers v5 (1-para-1)", async () => {
	const outdir = join(mkdtempSync(join(tmpdir(), "dv-contract-v5-")), randomUUID());
	const report = await runBench(runOptions(outdir, "agy/gemini-3.8-flash-high"));
	assert.equal(report.contract_id, CONTRACT_V5_ID);
	assert.equal(report.contract_sha256, CONTRACT_SHA_BY_ID[CONTRACT_V5_ID]);
	const summary = JSON.parse(readFileSync(join(outdir, "summary.json"), "utf8")) as BenchReport;
	assert.equal(summary.contract_id, CONTRACT_V5_ID);
	assert.ok(summary.runs.every((r) => r.contract_id === CONTRACT_V5_ID));
	for (const path of ledgersUnder(outdir)) {
		const started = JSON.parse(readFileSync(path, "utf8").split("\n")[0] as string) as { contract_id: string };
		assert.equal(started.contract_id, CONTRACT_V5_ID);
	}
	assert.equal(summary.conformance_violations.length, 0, JSON.stringify(summary.conformance_violations));
});

// ---------- validação de resumos combinados ----------

function fakeReport(contractId: string, sha: string, runContract?: string): BenchReport {
	return {
		schema: "dv-bench-summary-v2",
		contract_id: contractId,
		contract_sha256: sha,
		runs: [
			{
				task_id: "t1",
				policy: "single",
				repeat: 0,
				...(runContract === undefined ? {} : { contract_id: runContract }),
			},
		],
	} as unknown as BenchReport;
}

test("validação: v4 e v5 entre arms é compatível (nota, sem erro)", () => {
	const check = checkReportContracts([
		fakeReport(CONTRACT_ID, CONTRACT_SHA_BY_ID[CONTRACT_ID] as string),
		fakeReport(CONTRACT_V5_ID, CONTRACT_SHA_BY_ID[CONTRACT_V5_ID] as string),
	]);
	assert.equal(check.ok, true, check.problems.join("; "));
	assert.deepEqual(check.ids, [CONTRACT_ID, CONTRACT_V5_ID].sort());
	assert.equal(check.notes.length, 1);
});

test("validação: contract_id desconhecido e SHA que não confere são erro", () => {
	const unknown = checkReportContracts([fakeReport("p1-run-accounting-v9", "0".repeat(64))]);
	assert.equal(unknown.ok, false);
	assert.match(unknown.problems[0] ?? "", /desconhecido/);
	const wrongSha = checkReportContracts([fakeReport(CONTRACT_ID, "f".repeat(64))]);
	assert.equal(wrongSha.ok, false);
	assert.match(wrongSha.problems[0] ?? "", /não confere/);
});

test("validação: execução com contrato diferente do resumo é erro", () => {
	const check = checkReportContracts([
		fakeReport(CONTRACT_ID, CONTRACT_SHA_BY_ID[CONTRACT_ID] as string, CONTRACT_V5_ID),
	]);
	assert.equal(check.ok, false);
	assert.match(check.problems[0] ?? "", /dentro de um resumo/);
});

test("validação: execução sem contract_id (resumo antigo) não gera alarme", () => {
	const check = checkReportContracts([fakeReport(CONTRACT_ID, CONTRACT_SHA_BY_ID[CONTRACT_ID] as string)]);
	assert.equal(check.ok, true);
});
