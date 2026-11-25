// Métricas de roteamento (PGR, APGR, Pareto, AIQ), cruzamento de resumos e wiring da política preditiva.
// Offline e determinístico: valores calculados à mão nos comentários.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkLedgerConformance, PredictiveHarnessRouterPolicy, SingleModelPolicy } from "@dv-agent/core";
import { aiq, apgr, paretoFrontier, pgr, trapezoid } from "../src/bench/metrics.ts";
import type { BenchReport, RunRecord } from "../src/bench/report.ts";
import { computeRoutingMetrics, renderRoutingSection } from "../src/bench/routing_report.ts";
import { buildPolicy, type PolicyName, runSmoke, type SmokeOptions } from "../src/smoke/runner.ts";

const CORPUS = resolve(import.meta.dirname, "../corpus");
const PROBES = mkdtempSync(join(tmpdir(), "dv-routing-probes-"));
const HAIKU = "anthropic/claude-haiku-5-5";

/** Igualdade com tolerância para aritmética de ponto flutuante. */
function near(actual: number | null, expected: number): void {
	assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `esperado ${expected}, obtido ${actual}`);
}
const SONNET = "anthropic/claude-sonnet-4-6";

// ---------- PGR / APGR ----------

test("pgr: igual ao fraco = 0, igual ao forte = 1, intermediário pela fração", () => {
	assert.equal(pgr(0.2, 0.2, 0.8).value, 0);
	assert.equal(pgr(0.8, 0.2, 0.8).value, 1);
	// (0.5 - 0.2) / (0.8 - 0.2) = 0.5
	near(pgr(0.5, 0.2, 0.8).value, 0.5);
});

test("pgr: denominador zero (forte = fraco) devolve null com motivo, nunca NaN", () => {
	const result = pgr(0.5, 0.5, 0.5);
	assert.equal(result.value, null);
	assert.match(result.reason ?? "", /mesmo desempenho/);
});

test("trapezoid: regra do trapézio sobre pontos ordenados", () => {
	// (0,0)->(1,1): (0+1)/2 * 1 = 0.5 ; (1,1)->(2,1): 1 * 1 = 1.
	assert.equal(
		trapezoid([
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
			{ x: 2, y: 1 },
		]),
		1.5,
	);
});

test("apgr: curva plana no fraco = 0", () => {
	const curve = [
		{ x: 0, y: 0.4 },
		{ x: 0.5, y: 0.4 },
		{ x: 1, y: 0.4 },
	];
	assert.equal(apgr(curve, 0.4, 0.8).value, 0);
});

test("apgr: curva plana no forte = 1", () => {
	const curve = [
		{ x: 0, y: 0.8 },
		{ x: 0.5, y: 0.8 },
		{ x: 1, y: 0.8 },
	];
	assert.equal(apgr(curve, 0.4, 0.8).value, 1);
});

test("apgr: intermediário (fraco 0.4, roteador 0.6 a f=0.5, forte 0.8) = 0.5", () => {
	// AUC_r = (0.4+0.6)/2*0.5 + (0.6+0.8)/2*0.5 = 0.6 ; AUC_w = 0.4 ; AUC_s = 0.8 ; (0.6-0.4)/(0.8-0.4) = 0.5
	const curve = [
		{ x: 0, y: 0.4 },
		{ x: 0.5, y: 0.6 },
		{ x: 1, y: 0.8 },
	];
	near(apgr(curve, 0.4, 0.8).value, 0.5);
});

test("apgr: denominadores degenerados devolvem null com motivo", () => {
	const flat = [
		{ x: 0, y: 0.5 },
		{ x: 1, y: 0.5 },
	];
	assert.equal(apgr(flat, 0.5, 0.5).value, null);
	assert.match(apgr(flat, 0.5, 0.5).reason ?? "", /mesmo desempenho/);
	const single = [{ x: 0.5, y: 0.6 }];
	assert.equal(apgr(single, 0.4, 0.8).value, null);
	assert.match(apgr(single, 0.4, 0.8).reason ?? "", /menos de 2 pontos/);
	const noSpan = [
		{ x: 0.5, y: 0.6 },
		{ x: 0.5, y: 0.7 },
	];
	assert.match(apgr(noSpan, 0.4, 0.8).reason ?? "", /sem variação em x/);
});

// ---------- Pareto ----------

test("pareto: remove pontos dominados; empate exato fica", () => {
	const frontier = paretoFrontier([
		{ id: "A", cost: 1, quality: 0.5 },
		{ id: "B", cost: 2, quality: 0.5 }, // dominado por A (custa mais, mesma qualidade)
		{ id: "C", cost: 3, quality: 0.9 },
		{ id: "D", cost: 0.5, quality: 0.2 },
		{ id: "E", cost: 1, quality: 0.5 }, // empate exato com A: nenhum domina o outro
	]);
	assert.deepEqual(
		frontier.map((p) => p.id),
		["D", "A", "E", "C"],
	);
});

// ---------- AIQ ----------

test("aiq: pontos fora da fronteira não contribuem; área = 0.6 com xMax = 1", () => {
	// Fronteira: (0,0.2), (1,1). Área = (0.2+1)/2 * 1 = 0.6.
	const result = aiq([
		{ id: "a", cost: 0, quality: 0.2 },
		{ id: "b", cost: 0.5, quality: 0.2 },
		{ id: "c", cost: 1, quality: 1 },
	]);
	near(result.value, 0.6);
});

test("aiq: envoltória convexa superior remove o ponto abaixo da reta (0.5 e não 0.3)", () => {
	// (0.5, 0.1) fica abaixo de (0,0)-(1,1): a envoltória é a reta, área 0.5.
	const result = aiq([
		{ id: "a", cost: 0, quality: 0 },
		{ id: "b", cost: 0.5, quality: 0.1 },
		{ id: "c", cost: 1, quality: 1 },
	]);
	near(result.value, 0.5);
});

test("aiq: extensão horizontal até xMax comum (dois sistemas com o mesmo xMax)", () => {
	// Área de (0,0)-(1,1) = 0.5; estende (1,1)->(2,1) = 1; total 1.5; / 2 = 0.75.
	near(
		aiq(
			[
				{ id: "a", cost: 0, quality: 0 },
				{ id: "c", cost: 1, quality: 1 },
			],
			2,
		).value,
		0.75,
	);
});

test("aiq: ponto único no custo c integra de c até xMax (área = q * (xMax - c) / xMax)", () => {
	// c = 0.5, q = 0.8: área = 0.8 * (1 - 0.5) = 0.4 (estendido de c até xMax); / 1 = 0.4.
	near(aiq([{ id: "a", cost: 0.5, quality: 0.8 }], 1).value, 0.4);
});

test("aiq: degenerados devolvem null com motivo", () => {
	assert.match(aiq([]).reason ?? "", /sem pontos/);
	assert.match(aiq([{ id: "a", cost: 2, quality: 0.5 }], 1).reason ?? "", /menor que o maior custo/);
	assert.match(aiq([{ id: "a", cost: 0, quality: 0.5 }]).reason ?? "", /não positivo/);
});

// ---------- cruzamento de resumos ----------

function row(policy: PolicyName, solveRate: number, tokens: number) {
	return {
		policy,
		tier: "all",
		runs: 2,
		solved: Math.round(solveRate * 2),
		solve_rate: solveRate,
		escalation_rate: null,
		tokens_total: tokens,
		tokens_input: 0,
		tokens_cached_read: 0,
		tokens_cache_write: 0,
		tokens_output: 0,
		telemetry_status: "MEASURED",
		conformance_v4: "PASS",
	};
}

function run(policy: PolicyName, taskId: string, model: string, passed: boolean): RunRecord {
	return {
		task_id: taskId,
		tier: "easy",
		policy,
		repeat: 0,
		final_outcome: passed ? "solved" : "unsolved",
		solved: passed,
		escalated: null,
		steps: [
			{
				rung: 0,
				role: "rung_0",
				model,
				reasoning_effort: null,
				verdict: passed ? "PASS" : "FAIL",
				run_status: "completed",
				ceiling_status: "within_verified",
				spent_lower_bound_usd: 0,
				ledger_path: "x",
				ledger_sha256: "0".repeat(64),
				metrics: {} as RunRecord["steps"][number]["metrics"],
				conformance_status: "PASS",
			},
		],
		conformance_status: "PASS",
		conformance_violations: [],
	};
}

/** Resumo mínimo para o cruzamento. Só os campos lidos por computeRoutingMetrics são preenchidos. */
function report(
	model: string | null,
	policy: PolicyName,
	rate: number,
	tokens: number,
	runs: RunRecord[],
): BenchReport {
	return {
		schema: "dv-bench-summary-v2",
		model,
		policies: [policy],
		runs,
		rows: [row(policy, rate, tokens)],
	} as unknown as BenchReport;
}

test("cruzamento: Haiku single, Sonnet single e roteador no mesmo conjunto produzem PGR, APGR e Pareto", () => {
	// 4 execuções. Haiku passa 1/4; Sonnet passa 3/4; roteador passa 2/4 e envia 2/4 ao forte.
	const tasks = ["t1", "t2", "t3", "t4"];
	const haikuRuns = tasks.map((t, i) => run("single", t, HAIKU, i === 0));
	const sonnetRuns = tasks.map((t, i) => run("single", t, SONNET, i !== 3));
	const routerRuns = tasks.map((t, i) => {
		const usedStrong = i < 2;
		const passed = i === 0 || i === 2;
		return { ...run("predictive-harness-router", t, usedStrong ? SONNET : HAIKU, passed) };
	});
	const reports = [
		report(HAIKU, "single", 0.25, 1000, haikuRuns),
		report(SONNET, "single", 0.75, 4000, sonnetRuns),
		report(null, "predictive-harness-router", 0.5, 2500, routerRuns),
	];
	const m = computeRoutingMetrics(reports, { weakModel: HAIKU, strongModel: SONNET });
	assert.equal(m.weak.quality, 0.25);
	assert.equal(m.strong.quality, 0.75);
	assert.equal(m.router?.strong_fraction, 0.5);
	// PGR = (0.5 - 0.25) / (0.75 - 0.25) = 0.5
	near(m.pgr?.value ?? null, 0.5);
	// Curva (0,0.25),(0.5,0.5),(1,0.75): AUC_r = 0.1875 + 0.3125 = 0.5 ; AUC_w = 0.25 ; (0.5-0.25)/0.5 = 0.5
	near(m.apgr?.value ?? null, 0.5);
	assert.ok(m.pareto.includes("predictive-harness-router"));
	const section = renderRoutingSection(m);
	assert.match(section, /PGR do roteador \(ponto único\): 0\.500/);
	assert.match(section, /APGR \(curva fraco→roteador→forte\): 0\.500/);
});

test("cruzamento offline: fração forte usa requested_model (modelo real), não o roteiro faux do passo", () => {
	// Em offline, step.model é o roteiro faux (faux-strong); requested_model traz o modelo real. Sem o campo
	// ausente-de-uso, a fração forte seria 0 e a curva do roteador ficaria degenerada.
	const tasks = ["t1", "t2"];
	const asFaux = (r: RunRecord, real: string): RunRecord => ({
		...r,
		steps: r.steps.map((s) => ({ ...s, model: "anthropic/faux-strong", requested_model: real })),
	});
	const haikuRuns = tasks.map((t) => run("single", t, HAIKU, false));
	const sonnetRuns = tasks.map((t) => run("single", t, SONNET, true));
	const routerRuns = [
		asFaux(run("predictive-harness-router", "t1", SONNET, true), SONNET),
		asFaux(run("predictive-harness-router", "t2", HAIKU, false), HAIKU),
	];
	const reports = [
		report(HAIKU, "single", 0, 1000, haikuRuns),
		report(SONNET, "single", 1, 2000, sonnetRuns),
		report(null, "predictive-harness-router", 0.5, 1500, routerRuns),
	];
	const m = computeRoutingMetrics(reports, { weakModel: HAIKU, strongModel: SONNET });
	assert.equal(m.router?.strong_fraction, 0.5);
});

test("cruzamento: linhas por tier não viram pontos extras (só a linha agregada tier=all conta)", () => {
	const tasks = ["t1", "t2"];
	// Haiku: 0/2 (custo 100). Sonnet: 1/2 (custo 400). Roteador: 2/2 (custo 200). Sonnet fica dominado pelo roteador.
	const haiku = report(
		HAIKU,
		"single",
		0,
		100,
		tasks.map((t) => run("single", t, HAIKU, false)),
	);
	const sonnet = report(
		SONNET,
		"single",
		0.5,
		400,
		tasks.map((t, i) => run("single", t, SONNET, i === 0)),
	);
	const router = report(
		null,
		"predictive-harness-router",
		1,
		200,
		tasks.map((t) => run("predictive-harness-router", t, HAIKU, true)),
	);
	// Linhas por tier com valores que mudariam o resultado se entrassem.
	for (const r of [haiku, sonnet, router]) {
		r.rows = [...r.rows, { ...r.rows[0], tier: "easy", solve_rate: 0.123, tokens_total: 1 }] as typeof r.rows;
	}
	const m = computeRoutingMetrics([haiku, sonnet, router], { weakModel: HAIKU, strongModel: SONNET });
	assert.equal(m.others.length, 0, "nenhum ponto extra além de fraco, forte e roteador");
	assert.equal(m.weak.quality, 0);
	assert.equal(m.strong.quality, 0.5);
	assert.deepEqual(m.pareto, ["single:anthropic/claude-haiku-5-5", "predictive-harness-router"]);
});

test("cruzamento: sem o roteador, a seção declara que PGR e APGR não se aplicam", () => {
	const runs = [run("single", "t1", HAIKU, true)];
	const reports = [
		report(HAIKU, "single", 1, 100, runs),
		report(SONNET, "single", 1, 200, [run("single", "t1", SONNET, true)]),
	];
	const m = computeRoutingMetrics(reports, { weakModel: HAIKU, strongModel: SONNET });
	assert.equal(m.router, null);
	assert.match(renderRoutingSection(m), /não se aplicam/);
});

test("cruzamento: conjuntos de execuções diferentes são recusados", () => {
	const reports = [
		report(HAIKU, "single", 0.5, 100, [run("single", "t1", HAIKU, true)]),
		report(SONNET, "single", 0.5, 200, [run("single", "t2", SONNET, true)]),
	];
	assert.throws(
		() => computeRoutingMetrics(reports, { weakModel: HAIKU, strongModel: SONNET }),
		/conjuntos de execuções diferentes/,
	);
});

test("cruzamento: falta de baseline (sem campo model) é erro explícito", () => {
	const reports = [report(null, "single", 0.5, 100, [run("single", "t1", HAIKU, true)])];
	assert.throws(() => computeRoutingMetrics(reports, { weakModel: HAIKU, strongModel: SONNET }), /faltam baselines/);
});

// ---------- wiring do runner ----------

const baseOptions = (policy: SmokeOptions["policy"], extra: Partial<SmokeOptions> = {}): SmokeOptions => ({
	taskDir: join(CORPUS, "easy-01-calc"),
	policy,
	authMode: "offline-faux",
	outdir: mkdtempSync(join(tmpdir(), "dv-routing-out-")),
	maxCostUsd: 1,
	probesDir: PROBES,
	...extra,
});

test("wiring: buildPolicy('predictive-harness-router') começa no degrau 0 sem histórico", () => {
	const policy = buildPolicy(baseOptions("predictive-harness-router"));
	assert.ok(policy instanceof PredictiveHarnessRouterPolicy);
	assert.equal(policy.name, "predictive_harness_router");
	const first = policy.decide([]);
	assert.equal(first.kind === "run" && first.rung, 0);
	assert.match(policy.reason, /sem histórico aplicável/);
});

test("wiring: 'single' é parametrizado pelo modelo (Sonnet como baseline forte, sem chamada de rede)", () => {
	const policy = buildPolicy(baseOptions("single", { authMode: "api-key", model: SONNET }));
	assert.ok(policy instanceof SingleModelPolicy);
	const first = policy.decide([]);
	assert.equal(first.kind === "run" && first.model.provider, "anthropic");
	assert.equal(first.kind === "run" && first.model.modelId, "claude-sonnet-4-6");
});

test("wiring: execução offline do roteador grava route_decided no primeiro ledger, com motivo, e conformidade PASS", async () => {
	const options = baseOptions("predictive-harness-router");
	const summary = await runSmoke(options);
	const first = summary.steps[0];
	assert.ok(first !== undefined, "pelo menos um degrau executado");
	const lines = readFileSync(first.ledger_path, "utf8")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l) as { event: string; reason?: string });
	assert.equal(lines[1]?.event, "route_decided");
	assert.match(lines[1]?.reason ?? "", /sem histórico aplicável/);
	for (const step of summary.steps) {
		assert.equal(checkLedgerConformance(step.ledger_path).status, "PASS");
	}
});
