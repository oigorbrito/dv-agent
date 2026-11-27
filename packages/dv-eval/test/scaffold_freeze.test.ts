// Congelamento de system prompt e ferramentas: impressão digital, verificação entre braços e registro no ledger (offline).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { scaffoldFingerprint } from "@dv-agent/core";
import { checkReportContracts } from "../src/bench/contract_labels.ts";
import type { BenchReport, RunRecord } from "../src/bench/report.ts";
import { frozenScaffoldProblems } from "../src/bench/scaffold_freeze.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const HEX64 = /^[0-9a-f]{64}$/;

const tool = (name: string, description = "d", extra: Record<string, unknown> = {}) => ({
	name,
	description,
	parameters: { type: "object", properties: { path: { type: "string" } } },
	execute: async () => ({ content: [], details: {} }),
	...extra,
});

test("impressão digital: determinística; muda com system prompt, descrição ou schema; ignora execute", () => {
	const base = scaffoldFingerprint("SYS", [tool("read_file")]);
	assert.match(base.system_prompt_sha256, HEX64);
	assert.match(base.tools_sha256, HEX64);
	assert.deepEqual(scaffoldFingerprint("SYS", [tool("read_file")]), base);
	assert.notEqual(scaffoldFingerprint("SYS2", [tool("read_file")]).system_prompt_sha256, base.system_prompt_sha256);
	assert.equal(scaffoldFingerprint("SYS2", [tool("read_file")]).tools_sha256, base.tools_sha256);
	assert.notEqual(scaffoldFingerprint("SYS", [tool("read_file", "outra")]).tools_sha256, base.tools_sha256);
	const otherExec = scaffoldFingerprint("SYS", [tool("read_file", "d", { execute: async () => ({}) })]);
	assert.equal(otherExec.tools_sha256, base.tools_sha256, "implementação de execute não entra na digital");
	assert.notEqual(scaffoldFingerprint("SYS", []).tools_sha256, base.tools_sha256, "architect (sem ferramentas) difere");
});

function step(role: string, system?: string, tools?: string): Record<string, unknown> {
	return {
		rung: 0,
		role,
		model: "m",
		reasoning_effort: null,
		verdict: "PASS",
		run_status: "completed",
		ceiling_status: "within_verified",
		spent_lower_bound_usd: 0,
		ledger_path: "l",
		ledger_sha256: "0".repeat(64),
		metrics: { calls: 1, telemetry_complete: true, total_tokens: 1, telemetry_status: "MEASURED" },
		conformance_status: "PASS",
		...(system === undefined ? {} : { system_prompt_sha256: system }),
		...(tools === undefined ? {} : { tools_sha256: tools }),
	};
}

function report(mode: "uniform" | "adaptive", steps: Record<string, unknown>[]): BenchReport {
	const run = { task_id: "t", repeat: 0, tier: "easy", policy: "single", solved: true, steps } as unknown as RunRecord;
	return {
		schema: "dv-bench-summary-v2",
		contract_id: "p1-run-accounting-v4",
		contract_sha256: "11b4d5453e0964a7eb88decb5cbf7d1c5f5eebf4fbbdd458fb4e38686baef486",
		scaffold_mode: mode,
		runs: [run],
		rows: [],
	} as unknown as BenchReport;
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const T1 = "1".repeat(64);
const T2 = "2".repeat(64);

test("uniform: mesmas digitais nos braços => sem problema", () => {
	const out = frozenScaffoldProblems([
		report("uniform", [step("executor", A, T1)]),
		report("uniform", [step("executor", A, T1)]),
	]);
	assert.deepEqual(out.problems, []);
});

test("uniform: ferramentas divergentes entre braços => problema (ablação inválida)", () => {
	const out = frozenScaffoldProblems([
		report("uniform", [step("executor", A, T1)]),
		report("uniform", [step("executor", A, T2)]),
	]);
	assert.ok(out.problems.some((p) => /ferramentas divergentes/.test(p)));
});

test("uniform: system prompt divergente => problema", () => {
	const out = frozenScaffoldProblems([
		report("uniform", [step("executor", A, T1)]),
		report("uniform", [step("executor", B, T1)]),
	]);
	assert.ok(out.problems.some((p) => /system prompt divergente em scaffold uniform/.test(p)));
});

test("adaptive: system prompt pode variar por porte (nota), ferramentas não", () => {
	const ok = frozenScaffoldProblems([
		report("adaptive", [step("executor", A, T1)]),
		report("adaptive", [step("executor", B, T1)]),
	]);
	assert.deepEqual(ok.problems, []);
	assert.ok(ok.notes.some((n) => /varia por porte em scaffold adaptive/.test(n)));
	const bad = frozenScaffoldProblems([
		report("adaptive", [step("executor", A, T1)]),
		report("adaptive", [step("executor", A, T2)]),
	]);
	assert.ok(bad.problems.length > 0);
});

test("architect fica fora da checagem de ferramentas; resumo antigo vira nota, nunca erro", () => {
	const withArchitect = frozenScaffoldProblems([
		report("uniform", [step("executor", A, T1), step("architect", A, "")]),
	]);
	assert.deepEqual(withArchitect.problems, []);
	const legacy = frozenScaffoldProblems([report("uniform", [step("executor")])]);
	assert.deepEqual(legacy.problems, []);
	assert.ok(legacy.notes.some((n) => /sem impressão digital/.test(n)));
});

test("contrato: checkReportContracts reprova ferramentas divergentes (dv-bench-metrics também)", () => {
	const r1 = report("uniform", [step("executor", A, T1)]);
	const r2 = report("uniform", [step("executor", A, T2)]);
	assert.equal(checkReportContracts([r1, r2]).ok, false);
	assert.equal(checkReportContracts([r1]).ok, true);
});

test("execução faux real: ledger e passo do resumo trazem a impressão digital do scaffold", () => {
	const out = join(mkdtempSync(join(tmpdir(), "dv-fp-")), "run");
	const r = spawnSync(
		process.execPath,
		[
			join(ROOT, "scripts/dv-bench.ts"),
			"--auth-mode",
			"faux",
			"--tasks",
			"easy-01-calc",
			"--policies",
			"single",
			"--outdir",
			out,
		],
		{ encoding: "utf8", cwd: ROOT },
	);
	assert.equal(r.status, 0, r.stderr);
	const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as {
		runs: { steps: { system_prompt_sha256: string; tools_sha256: string; ledger_path: string }[] }[];
	};
	const st = summary.runs[0]?.steps[0];
	assert.ok(st);
	assert.match(st.system_prompt_sha256, HEX64);
	assert.match(st.tools_sha256, HEX64);
	const started = JSON.parse(readFileSync(st.ledger_path, "utf8").split("\n")[0] as string) as {
		reference_provenance: Record<string, string>;
	};
	assert.equal(started.reference_provenance.system_prompt_sha256, st.system_prompt_sha256);
	assert.equal(started.reference_provenance.tools_sha256, st.tools_sha256);
	assert.ok(existsSync(out) && readdirSync(out).length > 0);
});
