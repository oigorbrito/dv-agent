// Roteamento pré-execução: extração de sinais, escolha do degrau, fallback e integridade do ledger (route_decided).
// Tudo offline e determinístico (faux runtime, sem chamadas ao provedor).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Attempt,
	checkLedgerConformance,
	ExecutionGuidedLadderPolicy,
	executeRung,
	extractPythonSignals,
	PredictiveHarnessRouterPolicy,
	type RouteDecidedPayload,
} from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, usage } from "./support.ts";

const RUNGS = [
	{ model: { provider: "anthropic", modelId: "economico" }, costShareCap: 0.5 },
	{ model: { provider: "anthropic", modelId: "forte" }, costShareCap: 1 },
];
const SIGNALS_SHALLOW = { source_files: 1, loc: 10, import_depth: 1 };
const SIGNALS_DEEP = { source_files: 3, loc: 40, import_depth: 3 };

function attempt(rung: number, oraclePass: boolean | null, status: "pass" | "fail" | "provider_error"): Attempt {
	return {
		rung,
		role: `rung_${rung}`,
		model: RUNGS[rung]?.model ?? RUNGS[0]!.model,
		verification: oraclePass === null ? null : { oracle_pass: oraclePass, status },
		spent_lower_bound_usd: 0.1,
	};
}

// ---------- sinais estáticos ----------

test("sinais: conta .py, ignora linhas vazias e comentários, e ignora arquivos não-Python", () => {
	const signals = extractPythonSignals([
		{ path: "a.py", content: "# c\n\nx = 1\n  \ny = 2\n" },
		{ path: "SPEC.md", content: "não conta\nnem isto\n" },
	]);
	assert.deepEqual(signals, { source_files: 1, loc: 2, import_depth: 1 });
});

test("sinais: cadeia de imports locais a->b->c dá profundidade 3, e import de terceiros não conta", () => {
	const signals = extractPythonSignals([
		{ path: "a.py", content: "from b import f\nimport json\n" },
		{ path: "b.py", content: "from c import g\n" },
		{ path: "c.py", content: "x = 1\n" },
	]);
	assert.equal(signals.import_depth, 3);
	assert.equal(signals.source_files, 3);
});

test("sinais: ciclo de imports não recursa sem fim e limita a profundidade", () => {
	const signals = extractPythonSignals([
		{ path: "a.py", content: "import b\n" },
		{ path: "b.py", content: "import a\n" },
	]);
	assert.equal(signals.import_depth, 2);
});

test("sinais: pacote resolve por __init__.py e por submódulo com import dotted", () => {
	const signals = extractPythonSignals([
		{ path: "pkg/__init__.py", content: "" },
		{ path: "pkg/codec.py", content: "from pkg.model import M\n" },
		{ path: "pkg/model.py", content: "class M: ...\n" },
		{ path: "main.py", content: "from pkg.codec import X\n" },
	]);
	// main -> pkg.codec -> pkg.model: três módulos encadeados.
	assert.equal(signals.import_depth, 3);
});

test("sinais: sem arquivos Python, tudo é zero", () => {
	assert.deepEqual(extractPythonSignals([{ path: "SPEC.md", content: "x" }]), {
		source_files: 0,
		loc: 0,
		import_depth: 0,
	});
});

// ---------- escolha do degrau e fallback ----------

test("escolha: sem limiar calibrado, começa no degrau 0 e o motivo diz isso", () => {
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: RUNGS,
		globalMaxCostUsd: 10,
		signals: SIGNALS_DEEP,
		strongFromDepth: null,
	});
	const first = policy.decide([]);
	assert.equal(first.kind, "run");
	assert.equal(first.kind === "run" && first.rung, 0);
	assert.match(first.kind === "run" ? (first.route_reason ?? "") : "", /sem limiar calibrado/);
});

test("escolha: profundidade >= limiar começa direto no modelo forte, sem gastar o degrau 0", () => {
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: RUNGS,
		globalMaxCostUsd: 10,
		signals: SIGNALS_DEEP,
		strongFromDepth: 3,
	});
	const first = policy.decide([]);
	assert.equal(first.kind === "run" && first.rung, 1);
	assert.equal(first.kind === "run" && first.model.modelId, "forte");
	assert.match(first.kind === "run" ? (first.route_reason ?? "") : "", /direto no modelo forte/);
});

test("escolha: profundidade abaixo do limiar começa no degrau econômico", () => {
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: RUNGS,
		globalMaxCostUsd: 10,
		signals: SIGNALS_SHALLOW,
		strongFromDepth: 3,
	});
	assert.equal(policy.startRung, 0);
	const first = policy.decide([]);
	assert.equal(first.kind === "run" && first.rung, 0);
	assert.match(first.kind === "run" ? (first.route_reason ?? "") : "", /começa no degrau econômico/);
});

test("fallback: o degrau econômico reprovado sobe ao forte via ExecutionGuidedLadderPolicy", () => {
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: RUNGS,
		globalMaxCostUsd: 10,
		signals: SIGNALS_SHALLOW,
		strongFromDepth: 3,
	});
	const next = policy.decide([attempt(0, false, "fail")]);
	assert.equal(next.kind === "run" && next.rung, 1);
	assert.equal(next.kind === "run" && next.route_reason, undefined, "motivo só vai na primeira decisão");
});

test("fallback: começando direto no forte, reprovação não volta ao degrau 0 (para no forte)", () => {
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: RUNGS,
		globalMaxCostUsd: 10,
		signals: SIGNALS_DEEP,
		strongFromDepth: 3,
	});
	const next = policy.decide([attempt(1, false, "fail")]);
	assert.equal(next.kind, "stop");
	assert.equal(next.kind === "stop" && next.outcome, "unsolved");
});

test("fallback: falha de provedor não promove (infraestrutura não é evidência sobre o modelo)", () => {
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: RUNGS,
		globalMaxCostUsd: 10,
		signals: SIGNALS_SHALLOW,
		strongFromDepth: 3,
	});
	const next = policy.decide([attempt(0, false, "provider_error")]);
	assert.equal(next.kind, "stop");
});

test("validação: limiar inválido e ladder com startRung fora da faixa são recusados", () => {
	assert.throws(
		() =>
			new PredictiveHarnessRouterPolicy({
				rungs: RUNGS,
				globalMaxCostUsd: 1,
				signals: SIGNALS_SHALLOW,
				strongFromDepth: 0,
			}),
		/strongFromDepth inválido/,
	);
	assert.throws(
		() =>
			new PredictiveHarnessRouterPolicy({
				rungs: [],
				globalMaxCostUsd: 1,
				signals: SIGNALS_SHALLOW,
				strongFromDepth: null,
			}),
		/sem degraus/,
	);
	assert.throws(
		() => new ExecutionGuidedLadderPolicy({ rungs: RUNGS, globalMaxCostUsd: 1, startRung: 2 }),
		/startRung 2 fora/,
	);
});

test("ladder sem startRung mantém o comportamento anterior (começa no degrau 0)", () => {
	const policy = new ExecutionGuidedLadderPolicy({ rungs: RUNGS, globalMaxCostUsd: 10 });
	const first = policy.decide([]);
	assert.equal(first.kind === "run" && first.rung, 0);
});

// ---------- integridade do ledger ----------

const ONE_CALL = usage(1_000, 500, { reasoning: 0 });

async function runOnce(withRoute: boolean, ledgerPath: string) {
	const runtime = fauxRuntime("anthropic", ["economico"]);
	runtime.script([textTurn("pronto", ONE_CALL)]);
	const route: RouteDecidedPayload = {
		policy: "predictive_harness_router",
		rung: 0,
		role: "rung_0",
		reason: "profundidade de import 1 < 3: começa no degrau econômico",
		signals: SIGNALS_SHALLOW,
	};
	return executeRung({
		ledgerPath,
		runId: "run-route-1",
		harnessVariant: "b0_test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: runtime.modelOf("economico"),
		tools: [],
		prompt: "responda",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/economico"]),
		maxCostUsd: 5,
		doomLoopMaxIdenticalConsecutive: 10,
		...(withRoute ? { routeDecision: route } : {}),
	});
}

test("ledger: route_decided vem logo após run_started, e o resto do ledger fica idêntico byte a byte", async () => {
	const withPath = join(tempDir("route-on"), "ledger.jsonl");
	const withoutPath = join(tempDir("route-off"), "ledger.jsonl");
	await runOnce(true, withPath);
	await runOnce(false, withoutPath);

	const lines = readFileSync(withPath, "utf8").trimEnd().split("\n");
	const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
	assert.equal(events[0], "run_started");
	assert.equal(events[1], "route_decided");
	assert.equal(events.filter((e) => e === "route_decided").length, 1);

	// O runtime faux põe um nonce (timestamp + sufixo) no campo api de cada instância. Normaliza só isso.
	const normalize = (line: string) => line.replace(/faux:\d+:[a-z0-9]+/g, "faux:NONCE");
	const without = readFileSync(withoutPath, "utf8").trimEnd().split("\n").map(normalize);
	const stripped = lines.filter((line) => !line.includes('"event":"route_decided"')).map(normalize);
	assert.deepEqual(stripped, without, "remover route_decided deve devolver o ledger original");
});

test("ledger: com route_decided a conformidade continua PASS e a telemetria é a mesma (MEASURED)", async () => {
	const withPath = join(tempDir("route-pass-on"), "ledger.jsonl");
	const withoutPath = join(tempDir("route-pass-off"), "ledger.jsonl");
	await runOnce(true, withPath);
	await runOnce(false, withoutPath);
	const on = checkLedgerConformance(withPath);
	const off = checkLedgerConformance(withoutPath);
	assert.equal(on.status, off.status);
	assert.equal(on.violations.length, 0, on.violations.join("; "));
});

test("ledger: route_decided duplicado ou fora da posição 1 é violação de conformidade", async () => {
	const path = join(tempDir("route-dup"), "ledger.jsonl");
	await runOnce(true, path);
	const lines = readFileSync(path, "utf8").trimEnd().split("\n");
	const routeLine = lines[1];
	assert.ok(routeLine?.includes('"event":"route_decided"'));

	const duplicated = join(tempDir("route-dup-2"), "ledger.jsonl");
	writeFileSync(duplicated, [...lines.slice(0, 2), routeLine, ...lines.slice(2)].join("\n") + "\n");
	const report = checkLedgerConformance(duplicated);
	assert.equal(report.status, "FAIL");
	assert.ok(report.violations.some((v) => v.includes("no máximo uma vez")));

	const misplaced = join(tempDir("route-misplaced"), "ledger.jsonl");
	writeFileSync(misplaced, [lines[0], lines[2], routeLine, ...lines.slice(3)].join("\n") + "\n");
	const report2 = checkLedgerConformance(misplaced);
	assert.equal(report2.status, "FAIL");
	assert.ok(report2.violations.some((v) => v.includes("seguir run_started")));
});
