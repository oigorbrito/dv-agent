// Benchmark de ablação, 100% offline (provider faux): descoberta e filtro do corpus, ablação single x ladder x
// architect-editor, conformidade v4 de todos os ledgers, relatórios summary.json/summary.md e teto de tokens.
// Não usa rede nem lê ~/.pi/agent/auth.json (auth-mode offline-faux).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkLedgerConformance } from "@dv-agent/core";
import { type BenchOptions, CONTRACT_PATH, CONTRACT_SHA256, runBench } from "../src/bench/ablation.ts";
import { discoverCorpus, selectTasks } from "../src/bench/corpus.ts";
import type { BenchReport, GroupRow, RunRecord } from "../src/bench/report.ts";
import { runSmoke } from "../src/smoke/runner.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORPUS = resolve(import.meta.dirname, "../corpus");
const PROBES = mkdtempSync(join(tmpdir(), "dv-bench-probes-"));
const TASK_IDS = [
	"easy-01-calc",
	"easy-02-log-parser",
	"medium-01-semver-resolver",
	"medium-02-interval-scheduler",
	"hard-01-mini-ini-ast",
	"hard-02-wal-ledger-replay",
];

function options(extra: Partial<BenchOptions> = {}): BenchOptions {
	return {
		corpusDir: CORPUS,
		tier: "all",
		policies: ["single", "ladder", "architect-editor"],
		authMode: "offline-faux",
		maxCostUsd: 0.05,
		outdir: mkdtempSync(join(tmpdir(), "dv-bench-out-")),
		probesDir: PROBES,
		contractPath: join(ROOT, CONTRACT_PATH),
		...extra,
	};
}

function run(report: BenchReport, task: string, policy: string): RunRecord {
	const found = report.runs.find((r) => r.task_id === task && r.policy === policy);
	assert.ok(found, `run ausente: ${task}/${policy}`);
	return found;
}

function row(report: BenchReport, policy: string, tier: string): GroupRow {
	const found = report.rows.find((r) => r.policy === policy && r.tier === tier);
	assert.ok(found, `linha ausente: ${policy}/${tier}`);
	return found;
}

test("corpus: seis tarefas em três tiers, com descoberta e filtros por tier e tarefa", () => {
	const tasks = discoverCorpus(CORPUS);
	assert.deepEqual(
		tasks.map((t) => t.id),
		TASK_IDS,
	);
	assert.deepEqual(
		tasks.map((t) => t.tier),
		["easy", "easy", "medium", "medium", "hard", "hard"],
	);
	assert.equal(selectTasks(tasks, { tier: "all" }).length, 6);
	assert.deepEqual(
		selectTasks(tasks, { tier: "medium" }).map((t) => t.id),
		["medium-01-semver-resolver", "medium-02-interval-scheduler"],
	);
	assert.deepEqual(
		selectTasks(tasks, { tier: "all", task: "hard-01-mini-ini-ast" }).map((t) => t.id),
		["hard-01-mini-ini-ast"],
	);
	assert.throws(() => selectTasks(tasks, { tier: "all", task: "nao-existe" }), /inexistente/);
	assert.throws(() => selectTasks(tasks, { tier: "easy", task: "hard-01-mini-ini-ast" }), /é do tier hard/);
});

test("ablação offline: single falha, ladder promove ao degrau 1 e resolve, em todas as tarefas", async () => {
	const report = await runBench(options());
	assert.equal(report.runs.length, TASK_IDS.length * 3);
	for (const task of TASK_IDS) {
		const single = run(report, task, "single");
		assert.equal(single.final_outcome, "unsolved", task);
		assert.deepEqual(
			single.steps.map((s) => s.verdict),
			["FAIL"],
		);
		assert.equal(single.escalated, null);

		const ladder = run(report, task, "ladder");
		assert.equal(ladder.final_outcome, "solved", task);
		assert.deepEqual(
			ladder.steps.map((s) => [s.rung, s.verdict]),
			[
				[0, "FAIL"],
				[1, "PASS"],
			],
			task,
		);
		assert.equal(ladder.escalated, true);

		const architect = run(report, task, "architect-editor");
		assert.equal(architect.final_outcome, "solved", task);
		assert.equal(architect.steps[0]?.role, "architect");
		assert.equal(architect.steps[0]?.verdict, null);
	}
});

test("conformidade v4 de todos os ledgers, hashes e relatórios summary.json e summary.md válidos", async () => {
	const opts = options();
	const report = await runBench(opts);
	for (const r of report.runs) {
		assert.deepEqual(r.conformance_violations, [], `${r.task_id}/${r.policy}`);
		for (const step of r.steps) {
			assert.deepEqual(checkLedgerConformance(step.ledger_path).violations, [], step.ledger_path);
			const sha = createHash("sha256").update(readFileSync(step.ledger_path)).digest("hex");
			assert.equal(sha, step.ledger_sha256);
		}
	}
	assert.equal(report.contract_sha256, CONTRACT_SHA256);
	assert.equal(report.rows.length, 3 * (1 + 3));

	const ladderAll = row(report, "ladder", "all");
	assert.equal(ladderAll.solve_rate, 1);
	assert.equal(ladderAll.escalation_rate, 1);
	assert.equal(ladderAll.telemetry_status, "MEASURED");
	assert.equal(ladderAll.conformance_v4, "PASS");
	const singleAll = row(report, "single", "all");
	assert.equal(singleAll.solve_rate, 0);
	assert.equal(singleAll.escalation_rate, null);
	for (const r of report.rows) {
		assert.equal(
			r.tokens_total,
			r.tokens_input + r.tokens_cached_read + r.tokens_cache_write + r.tokens_output,
			`${r.policy}/${r.tier}`,
		);
	}

	const persisted = JSON.parse(readFileSync(join(opts.outdir, "summary.json"), "utf8")) as BenchReport;
	assert.equal(persisted.schema, "dv-bench-summary-v1");
	assert.equal(persisted.runs.length, report.runs.length);
	const md = readFileSync(join(opts.outdir, "summary.md"), "utf8");
	assert.match(md, /\| ladder \| all \|/);
	assert.match(md, /AVISO: modo offline-faux/);
});

test("filtros --tier e --task restringem as execuções", async () => {
	const easy = await runBench(options({ tier: "easy", policies: ["ladder"] }));
	assert.deepEqual(easy.runs.map((r) => r.task_id).sort(), ["easy-01-calc", "easy-02-log-parser"]);
	const one = await runBench(options({ task: "hard-02-wal-ledger-replay", policies: ["single", "ladder"] }));
	assert.equal(one.runs.length, 2);
	assert.ok(one.runs.every((r) => r.task_id === "hard-02-wal-ledger-replay"));
});

test("teto de tokens: o degrau para com budget_exceeded e a escalada encerra com budget_exhausted", async () => {
	const summary = await runSmoke({
		taskDir: join(CORPUS, "easy-01-calc"),
		policy: "ladder",
		authMode: "offline-faux",
		outdir: mkdtempSync(join(tmpdir(), "dv-bench-tokens-")),
		maxCostUsd: 0.05,
		maxTokens: 1,
		probesDir: PROBES,
	});
	assert.equal(summary.final_outcome, "budget_exhausted");
	assert.equal(summary.steps.length, 1);
	assert.equal(summary.steps[0]?.run_status, "budget_exceeded");
	assert.equal(summary.steps[0]?.ceiling_status, "within_verified");
	assert.deepEqual(checkLedgerConformance(summary.steps[0]?.ledger_path ?? "").violations, []);
});

test("contrato v4 alterado: o bench recusa executar", async () => {
	const altered = join(mkdtempSync(join(tmpdir(), "dv-bench-contract-")), "contract.json");
	writeFileSync(altered, "{}\n");
	await assert.rejects(runBench(options({ contractPath: altered })), /contrato v4 alterado/);
});
