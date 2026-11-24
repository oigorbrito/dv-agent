// Benchmark de ablação, 100% offline (provider faux): descoberta e filtro do corpus, ablação single x ladder x
// architect-editor, conformidade v4 de todos os ledgers, relatórios summary.json/summary.md e teto de tokens.
// Não usa rede nem lê ~/.pi/agent/auth.json (auth-mode offline-faux).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkLedgerConformance } from "@dv-agent/core";
import {
	type BenchOptions,
	CONTRACT_PATH,
	CONTRACT_SHA256,
	runBench,
	temperatureNotes,
} from "../src/bench/ablation.ts";
import { discoverCorpus, selectTasks } from "../src/bench/corpus.ts";
import {
	aggregate,
	type BenchReport,
	type GroupRow,
	groupConformance,
	passStats,
	type RunRecord,
	renderMarkdown,
	wilsonInterval,
} from "../src/bench/report.ts";
import { EDITOR_FINISH_HINT, EDITOR_LIMITS, runSmoke } from "../src/smoke/runner.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORPUS = resolve(import.meta.dirname, "../corpus");
const PROBES = mkdtempSync(join(tmpdir(), "dv-bench-probes-"));
const TASK_IDS = [
	"easy-01-calc",
	"easy-02-log-parser",
	"easy-03-csv-normalizer",
	"easy-04-rle-codec",
	"easy-05-slug-dedup",
	"medium-01-semver-resolver",
	"medium-02-interval-scheduler",
	"medium-03-topo-build-planner",
	"medium-04-lru-ttl-cache",
	"medium-05-rate-limiter-sliding",
	"hard-01-mini-ini-ast",
	"hard-02-wal-ledger-replay",
	"hard-03-mini-sql-engine",
	"hard-04-crdt-lww-map",
	"hard-05-bytecode-vm-gc",
	"frontier-01-ssa-dominator-opt",
	"frontier-02-raft-consensus-sim",
	"frontier-03-incremental-type-infer",
];
const NEGATIVE_ID = "negative-01-contradictory-spec";

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

test("corpus: 18 tarefas positivas (5 por tier, 3 em frontier) + 1 negativa, com filtros por tier e tarefa", () => {
	const tasks = discoverCorpus(CORPUS);
	assert.deepEqual(
		tasks.map((t) => t.id),
		[...TASK_IDS, NEGATIVE_ID],
	);
	const negative = tasks.find((t) => t.id === NEGATIVE_ID);
	assert.equal(negative?.tier, "negative");
	assert.equal(negative?.expectedOutcome, "unsolved");
	assert.equal(selectTasks(tasks, { tier: "all" }).length, 18, "all exclui o controle negativo");
	assert.deepEqual(
		selectTasks(tasks, { tier: "medium" }).map((t) => t.id),
		TASK_IDS.filter((id) => id.startsWith("medium-")),
	);
	assert.equal(selectTasks(tasks, { tier: "hard" }).length, 5);
	assert.deepEqual(
		selectTasks(tasks, { tier: "negative" }).map((t) => t.id),
		[NEGATIVE_ID],
	);
	assert.deepEqual(
		selectTasks(tasks, { tier: "all", task: "hard-01-mini-ini-ast" }).map((t) => t.id),
		["hard-01-mini-ini-ast"],
	);
	assert.deepEqual(
		selectTasks(tasks, { tier: "all", task: NEGATIVE_ID }).map((t) => t.id),
		[NEGATIVE_ID],
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
	assert.equal(report.rows.length, 3 * (1 + 4));

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
	assert.equal(persisted.schema, "dv-bench-summary-v2");
	assert.equal(persisted.runs.length, report.runs.length);
	const md = readFileSync(join(opts.outdir, "summary.md"), "utf8");
	assert.match(md, /\| ladder \| all \|/);
	assert.match(md, /AVISO: modo offline-faux/);
});

test("filtros --tier e --task restringem as execuções", async () => {
	const easy = await runBench(options({ tier: "easy", policies: ["ladder"] }));
	assert.deepEqual(easy.runs.map((r) => r.task_id).sort(), TASK_IDS.filter((id) => id.startsWith("easy-")).sort());
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

test("governança: subscription sem --max-tokens é recusada antes de qualquer execução", async () => {
	await assert.rejects(
		runBench(options({ authMode: "subscription", model: "anthropic/claude-haiku-5-5" })),
		/subscription exige --max-tokens/,
	);
});

test("governança: --outdir existente e não vazio é recusado; arquivo existente não é alterado", async () => {
	const outdir = mkdtempSync(join(tmpdir(), "dv-bench-occupied-"));
	const marker = join(outdir, "evidencia.txt");
	writeFileSync(marker, "run anterior\n");
	await assert.rejects(runBench(options({ outdir })), /não está vazio/);
	assert.equal(readFileSync(marker, "utf8"), "run anterior\n");
	assert.equal(existsSync(join(outdir, "summary.json")), false);
});

test("higiene: workspace temporário do degrau é removido ao fim (sem órfãos em TEMP)", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-bench-tmp-"));
	const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
	process.env.TEMP = tmp;
	process.env.TMP = tmp;
	process.env.TMPDIR = tmp;
	try {
		await runSmoke({
			taskDir: join(CORPUS, "easy-01-calc"),
			policy: "ladder",
			authMode: "offline-faux",
			outdir: mkdtempSync(join(tmpdir(), "dv-bench-tmp-out-")),
			maxCostUsd: 0.05,
			probesDir: PROBES,
		});
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.deepEqual(
		readdirSync(tmp).filter((name) => name.startsWith("dv-smoke-ws-")),
		[],
	);
});

test("agregado: linha tier 'all' só aparece quando os três tiers foram executados", async () => {
	const partial = await runBench(options({ tier: "easy", policies: ["single"] }));
	assert.deepEqual(partial.tiers, ["easy"]);
	assert.equal(
		partial.rows.some((r) => r.tier === "all"),
		false,
	);
	assert.deepEqual(
		partial.rows.map((r) => r.tier),
		["easy"],
	);
});

test("relatório: colunas de custo, teto e conformidade por linha", async () => {
	const opts = options({ tier: "easy", policies: ["ladder"] });
	await runBench(opts);
	const md = readFileSync(join(opts.outdir, "summary.md"), "utf8");
	assert.match(md, /\| cost_usd \| spent_lower_bound_usd \| ceiling_status \|/);
	assert.match(md, /\| ladder \| easy \|.*\| within_verified \| \d+ \|.*\| MEASURED \| PASS \|/);
});

test("editor: limite de turnos corta o degrau com motivo max_turns registrado no ledger", async () => {
	const summary = await runSmoke({
		taskDir: join(CORPUS, "easy-01-calc"),
		policy: "architect-editor",
		authMode: "offline-faux",
		outdir: mkdtempSync(join(tmpdir(), "dv-bench-editor-")),
		maxCostUsd: 0.05,
		probesDir: PROBES,
		editorLimits: { maxTurns: 1, maxOutputTokens: 8000 },
	});
	const editor = summary.steps.find((s) => s.role === "editor");
	assert.equal(editor?.run_status, "limit_exceeded");
	const finished =
		readFileSync(editor?.ledger_path ?? "", "utf8")
			.trim()
			.split("\n")
			.at(-1) ?? "";
	assert.match(finished, /"limit_reason":"max_turns"/);
	assert.deepEqual(checkLedgerConformance(editor?.ledger_path ?? "").violations, []);
});

test("conformidade agregada: qualquer FAIL domina; INCONCLUSIVE rebaixa o grupo; PASS só com todos PASS", () => {
	const run = (conformance_status: RunRecord["conformance_status"]): RunRecord => ({
		task_id: "t",
		repeat: 0,
		tier: "easy",
		policy: "single",
		final_outcome: "unsolved",
		solved: false,
		escalated: null,
		steps: [],
		conformance_status,
		conformance_violations: [],
	});
	assert.equal(groupConformance([run("PASS"), run("PASS")]), "PASS");
	assert.equal(groupConformance([run("PASS"), run("INCONCLUSIVE")]), "INCONCLUSIVE");
	assert.equal(groupConformance([run("INCONCLUSIVE"), run("FAIL")]), "FAIL");
	const rows: GroupRow[] = aggregate([run("INCONCLUSIVE")], ["single"], ["easy"]);
	assert.equal(rows[0]?.conformance_v4, "INCONCLUSIVE");
});

test("relatório: subscription mostra teto de custo n/a; budget_exceeded marca tokens_total com †", () => {
	const row = (budget: number): GroupRow => ({
		policy: "single",
		tier: "hard",
		runs: 1,
		solved: 0,
		solve_rate: 0,
		ci_95_low: 0,
		ci_95_high: 0.79,
		escalation_rate: null,
		tokens_total: 1000,
		tokens_input: 10,
		tokens_cached_read: 900,
		tokens_cache_write: 50,
		tokens_output: 40,
		cost_usd: null,
		spent_lower_bound_usd: 0,
		budget_exceeded_runs: budget,
		tasks: 1,
		pass_all: 0,
		ceiling_status: "unverifiable",
		telemetry_status: "MEASURED",
		conformance_v4: "INCONCLUSIVE",
	});
	const base = {
		schema: "dv-bench-summary-v2" as const,
		contract_id: "p1-run-accounting-v4",
		contract_sha256: "x",
		auth_mode: "subscription",
		tier: "hard" as const,
		tiers: ["hard" as const],
		task: null,
		tasks: null,
		policies: ["single" as const],
		model: null,
		escalation_model: null,
		max_cost_usd: 0.05,
		max_tokens: 600000,
		editor_limits: { maxTurns: 32, maxOutputTokens: 32000 },
		repeats: 1,
		temperature: null,
		temperature_notes: [],
		runs: [],
		conformance_violations: [],
	};
	const md = renderMarkdown({ ...base, rows: [row(0)] });
	assert.match(md, /teto de custo: n\/a \(subscription\)/);
	assert.doesNotMatch(md, /0\.05 USD/);
	assert.match(md, /tetos do editor: 32 turnos, 32000 tokens de saída/);
	assert.match(md, /\| 1000 \|/);
	const flagged = renderMarkdown({ ...base, rows: [row(1)] });
	assert.match(flagged, /\| 1000 † \|/);
});

test("repetições: --repeats 2 gera rep-0 e rep-1; md mostra solved por execução e pass^k por tarefa", async () => {
	const opts = options({ task: "easy-01-calc", policies: ["ladder"], repeats: 2 });
	const report = await runBench(opts);
	assert.equal(report.runs.length, 2);
	assert.deepEqual(report.runs.map((r) => r.repeat).sort(), [0, 1]);
	assert.equal(existsSync(join(opts.outdir, "easy-01-calc", "ladder", "rep-0", "summary.json")), true);
	assert.equal(existsSync(join(opts.outdir, "easy-01-calc", "ladder", "rep-1", "summary.json")), true);
	const md = readFileSync(join(opts.outdir, "summary.md"), "utf8");
	assert.match(md, /réplicas por célula: 2/);
	assert.match(md, /\| ladder \| easy \| 2 \| 2 \| 1 \|/);
	assert.match(md, /\| pass\^k \|/);
	assert.match(md, /\| 1\/1 \|$/m);
	const row = report.rows.find((r) => r.policy === "ladder" && r.tier === "easy");
	assert.equal(row?.tasks, 1);
	assert.equal(row?.pass_all, 1);
});

test("pass^k: tarefa conta uma vez e só passa se resolvida em todas as réplicas", () => {
	const rec = (task: string, solved: boolean, repeat: number): RunRecord => ({
		task_id: task,
		repeat,
		tier: "easy",
		policy: "single",
		final_outcome: solved ? "solved" : "unsolved",
		solved,
		escalated: null,
		steps: [],
		conformance_status: "PASS",
		conformance_violations: [],
	});
	const stats = passStats([rec("a", true, 0), rec("a", true, 1), rec("b", true, 0), rec("b", false, 1)]);
	assert.deepEqual(stats, { tasks: 2, pass_all: 1 });
});

test("temperatura: offline não se aplica; Haiku 5.5 não recebe temperatura (compat), Sonnet 4.6 recebe", () => {
	const base = {
		authMode: "offline-faux" as const,
		corpusDir: CORPUS,
		tier: "all" as const,
		policies: [],
		maxCostUsd: 1,
		outdir: "x",
		probesDir: PROBES,
		contractPath: "x",
	};
	assert.deepEqual(temperatureNotes({ ...base, temperature: 0 }), ["modelos faux: temperatura não se aplica"]);
	assert.deepEqual(temperatureNotes({ ...base, authMode: "subscription", temperature: 0 }), []);
	const live = temperatureNotes({
		...base,
		authMode: "subscription",
		temperature: 0,
		model: "anthropic/claude-haiku-5-5",
		escalationModel: "anthropic/claude-sonnet-4-6",
	});
	assert.equal(live.length, 2);
	assert.match(live[0] ?? "", /claude-haiku-5-5: NÃO aplicada/);
	assert.match(live[1] ?? "", /claude-sonnet-4-6: aplicada/);
});

test("editor: instrução de término e teto padrão de 32 turnos", () => {
	assert.match(
		EDITOR_FINISH_HINT,
		/Assim que os testes locais passarem, responda imediatamente sem chamar novas ferramentas\./,
	);
	assert.equal(EDITOR_LIMITS.maxTurns, 32);
});

const near = (actual: number | undefined, expected: number, tol = 1e-3): boolean =>
	actual !== undefined && Math.abs(actual - expected) <= tol;

test("Wilson 95%: extremos 0/n e n/n têm limite exato no lado não degenerado", () => {
	const z2 = 1.96 * 1.96;
	const zero = wilsonInterval(0, 10);
	assert.equal(zero?.low, 0);
	assert.ok(near(zero?.high, z2 / (10 + z2)), `0/10 high=${zero?.high}`);
	const all = wilsonInterval(10, 10);
	assert.equal(all?.high, 1);
	assert.ok(near(all?.low, 10 / (10 + z2)), `10/10 low=${all?.low}`);
	const two = wilsonInterval(2, 2);
	assert.ok(near(two?.low, 2 / (2 + z2)), `2/2 low=${two?.low}`);
});

test("Wilson 95%: casos intermediários (valores de referência)", () => {
	const half = wilsonInterval(5, 10);
	assert.ok(near(half?.low, 0.2366) && near(half?.high, 0.7634), `5/10 = [${half?.low}, ${half?.high}]`);
	const third = wilsonInterval(1, 3);
	assert.ok(near(third?.low, 0.0615) && near(third?.high, 0.7923), `1/3 = [${third?.low}, ${third?.high}]`);
});

test("Wilson 95%: n=0 é null e o intervalo estreita com mais observações", () => {
	assert.equal(wilsonInterval(0, 0), null);
	const small = wilsonInterval(5, 10);
	const large = wilsonInterval(50, 100);
	assert.ok((small?.high ?? 0) - (small?.low ?? 0) > (large?.high ?? 0) - (large?.low ?? 0));
});

test("Wilson 95%: renderiza [low%, high%] e a coluna ci_95 antes de pass^k no summary.md", () => {
	const rec = (task: string, repeat: number): RunRecord => ({
		task_id: task,
		repeat,
		tier: "easy",
		policy: "single",
		final_outcome: "solved",
		solved: true,
		escalated: null,
		steps: [],
		conformance_status: "PASS",
		conformance_violations: [],
	});
	const runs = [rec("a", 0), rec("a", 1)];
	const rows = aggregate(runs, ["single"], ["easy"]);
	const md = renderMarkdown({
		schema: "dv-bench-summary-v2",
		contract_id: "p1-run-accounting-v4",
		contract_sha256: "x",
		auth_mode: "subscription",
		tier: "easy",
		tiers: ["easy"],
		task: null,
		tasks: null,
		policies: ["single"],
		model: null,
		escalation_model: null,
		max_cost_usd: 0.05,
		max_tokens: 1000,
		editor_limits: { maxTurns: 32, maxOutputTokens: 32000 },
		repeats: 2,
		temperature: null,
		temperature_notes: [],
		runs,
		rows,
		conformance_violations: [],
	});
	assert.match(md, /\| 2 \| 2 \| 1 \| \[34\.2%, 100\.0%\] \|/);
	assert.match(md, /\| solve_rate \| ci_95 \|/);
	assert.ok(md.indexOf("| ci_95 |") < md.indexOf("| pass^k |"));
});
