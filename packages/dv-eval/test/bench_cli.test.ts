// Seleção por --tasks, parser estrito e CLI do dv-bench. Offline: os casos de erro falham antes de qualquer execução,
// e o caso positivo usa só o modo faux (roteiro local, zero tokens).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { discoverCorpus, selectTasks } from "../src/bench/corpus.ts";
import { parseArgs } from "../src/cli/args.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORPUS_DIR = resolve(import.meta.dirname, "../corpus");
const CORPUS = discoverCorpus(CORPUS_DIR);
const ALLOWED = ["tier", "task", "tasks", "outdir", "ladder-models", "routing-history", "routing-history-partition"];

// ---------- parser estrito ----------

test("parser: flags aceitas são lidas e a lista vira um único valor", () => {
	const args = parseArgs(["--tasks", "a,b", "--tier", "hard"], ALLOWED);
	assert.equal(args.get("tasks"), "a,b");
	assert.equal(args.get("tier"), "hard");
});

test("parser: --routing-history pode ser repetida sem relaxar as demais flags", () => {
	const args = parseArgs(["--routing-history", "a/summary.json", "--routing-history", "b/summary.json"], ALLOWED, [
		"routing-history",
	]);
	assert.deepEqual(args.get("routing-history"), `a/summary.json\u0000b/summary.json`);
	assert.throws(
		() => parseArgs(["--tier", "easy", "--tier", "hard"], ALLOWED, ["routing-history"]),
		/flag repetida: --tier/,
	);
});

test("parser: flag desconhecida (typo) é erro, com a lista das aceitas", () => {
	assert.throws(() => parseArgs(["--taks", "x"], ALLOWED), /flag desconhecida: --taks \(aceitas: --tier/);
});

test("parser: forma --chave=valor não é aceita em silêncio", () => {
	assert.throws(() => parseArgs(["--tasks=a,b"], ALLOWED), /flag desconhecida: --tasks=a,b/);
});

test("parser: flag repetida é erro (última não sobrescreve a primeira em silêncio)", () => {
	assert.throws(() => parseArgs(["--tier", "easy", "--tier", "hard"], ALLOWED), /flag repetida: --tier/);
});

test("parser: token posicional continua sendo erro", () => {
	assert.throws(() => parseArgs(["hard"], ALLOWED), /argumento inesperado: hard/);
});

test("parser: sem lista de permitidas, mantém o comportamento permissivo das CLIs antigas", () => {
	assert.equal(parseArgs(["--qualquer-coisa", "v"]).get("qualquer-coisa"), "v");
});

// ---------- seleção por lista ----------

test("seleção: lista retorna o subconjunto na ordem do corpus, não na ordem pedida", () => {
	const selected = selectTasks(CORPUS, {
		tier: "all",
		tasks: ["hard-02-wal-ledger-replay", "easy-01-calc"],
	});
	assert.deepEqual(
		selected.map((t) => t.id),
		["easy-01-calc", "hard-02-wal-ledger-replay"],
	);
});

test("seleção: IDs inexistentes são listados todos de uma vez", () => {
	assert.throws(
		() => selectTasks(CORPUS, { tier: "all", tasks: ["easy-01-calc", "nao-existe", "tambem-nao"] }),
		/tarefas inexistentes no corpus: nao-existe, tambem-nao/,
	);
});

test("seleção: ID repetido e ID vazio são erro", () => {
	assert.throws(() => selectTasks(CORPUS, { tier: "all", tasks: ["easy-01-calc", "easy-01-calc"] }), /ID repetido/);
	assert.throws(() => selectTasks(CORPUS, { tier: "all", tasks: ["easy-01-calc", ""] }), /ID vazio/);
	assert.throws(() => selectTasks(CORPUS, { tier: "all", tasks: [] }), /sem IDs/);
});

test("seleção: tier explícito diferente de alguma tarefa da lista é erro", () => {
	assert.throws(
		() => selectTasks(CORPUS, { tier: "easy", tasks: ["easy-01-calc", "hard-01-mini-ini-ast"] }),
		/hard-01-mini-ini-ast é do tier hard, não easy/,
	);
});

test("seleção: --task e --tasks juntos são recusados", () => {
	assert.throws(
		() => selectTasks(CORPUS, { tier: "all", task: "easy-01-calc", tasks: ["easy-01-calc"] }),
		/não os dois/,
	);
});

test("seleção: tarefa negativa nomeada explicitamente entra (o tier all só a exclui implicitamente)", () => {
	const selected = selectTasks(CORPUS, { tier: "all", tasks: ["negative-01-contradictory-spec"] });
	assert.deepEqual(
		selected.map((t) => t.id),
		["negative-01-contradictory-spec"],
	);
});

test("seleção: a lista do holdout (9 tarefas) resolve para exatamente essas 9", () => {
	const holdout = [
		"easy-02-log-parser",
		"easy-04-rle-codec",
		"frontier-01-ssa-dominator-opt",
		"frontier-03-incremental-type-infer",
		"hard-02-wal-ledger-replay",
		"hard-04-crdt-lww-map",
		"medium-01-semver-resolver",
		"medium-03-topo-build-planner",
		"medium-05-rate-limiter-sliding",
	];
	const selected = selectTasks(CORPUS, { tier: "all", tasks: holdout });
	assert.equal(selected.length, 9);
	assert.deepEqual(selected.map((t) => t.id).sort(), [...holdout].sort());
});

// ---------- CLI do dv-bench (sem chamada live: erros antes de executar; sucesso só em faux) ----------

function bench(args: string[]) {
	return spawnSync(process.execPath, ["scripts/dv-bench.ts", ...args], { cwd: ROOT, encoding: "utf8" });
}

test("CLI: --tasks com ID inexistente sai com código 1, antes de criar o outdir", () => {
	const outdir = join(mkdtempSync(join(tmpdir(), "dv-cli-")), "out");
	const result = bench(["--tasks", "nao-existe", "--auth-mode", "faux", "--outdir", outdir]);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /tarefas inexistentes no corpus: nao-existe/);
	assert.equal(existsSync(outdir), false);
});

test("CLI: --tasks sem valor é erro (antes, viraria seleção vazia ou tier all)", () => {
	const result = bench(["--tasks", "--auth-mode", "faux"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--tasks exige um valor/);
});

test("CLI: flag com typo é erro com nome da flag, sem stack trace", () => {
	const result = bench(["--taks", "easy-01-calc", "--auth-mode", "faux"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /flag desconhecida: --taks/);
	assert.doesNotMatch(result.stderr, /at /);
});

test("CLI: --task e --tasks juntos são recusados", () => {
	const result = bench(["--task", "easy-01-calc", "--tasks", "easy-01-calc", "--auth-mode", "faux"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /use --task ou --tasks/);
});

test("CLI: --tasks em faux roda só as tarefas pedidas e grava a lista no resumo", () => {
	const outdir = join(mkdtempSync(join(tmpdir(), "dv-cli-ok-")), "out");
	const result = bench([
		"--tasks",
		"hard-02-wal-ledger-replay,easy-01-calc",
		"--policies",
		"single",
		"--repeats",
		"1",
		"--auth-mode",
		"faux",
		"--outdir",
		outdir,
	]);
	assert.equal(result.status, 0, result.stderr);
	const summary = JSON.parse(readFileSync(join(outdir, "summary.json"), "utf8")) as {
		tasks: string[];
		runs: { task_id: string }[];
	};
	assert.deepEqual(summary.tasks, ["hard-02-wal-ledger-replay", "easy-01-calc"]);
	assert.deepEqual([...new Set(summary.runs.map((r) => r.task_id))].sort(), [
		"easy-01-calc",
		"hard-02-wal-ledger-replay",
	]);
});

test("CLI: --ladder-models aceita escada de três degraus e grava os refs no resumo", () => {
	const outdir = join(mkdtempSync(join(tmpdir(), "dv-cli-ladder-")), "out");
	const result = bench([
		"--task",
		"easy-01-calc",
		"--policies",
		"ladder",
		"--ladder-models",
		"agy/gemini-3.8-flash-high,anthropic/claude-haiku-4-5,anthropic/claude-sonnet-4-6",
		"--auth-mode",
		"faux",
		"--outdir",
		outdir,
	]);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(readFileSync(join(outdir, "summary.json"), "utf8")) as {
		contract_id: string;
		ladder_models: string[];
		runs: { final_outcome: string }[];
	};
	assert.equal(report.contract_id, "p1-run-accounting-v5");
	assert.deepEqual(report.ladder_models, [
		"agy/gemini-3.8-flash-high",
		"anthropic/claude-haiku-4-5",
		"anthropic/claude-sonnet-4-6",
	]);
	assert.equal(report.runs[0]?.final_outcome, "solved");
});
