// Integração offline: escada híbrida agy/gemini-3.8-flash-high -> anthropic/claude-haiku-5-5 -> anthropic/claude-sonnet-4-6.
// Usa a política de escada real e o executeRung real. O agy é o servidor ACP em memória; Haiku e Sonnet são o runtime faux.
// O oráculo é simulado (veredito por degrau). Nenhuma chamada live.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Attempt,
	agyModel,
	checkLedgerConformance,
	createAgyMockSpawn,
	createAgyStreamFn,
	ExecutionGuidedLadderPolicy,
	executeRung,
	fauxRuntime,
	type ModelRef,
	type PriceBook,
	type RouterDecision,
	textTurn,
	usage,
} from "@dv-agent/core";

const PROBE_USAGE = {
	inputTokens: 13193,
	outputTokens: 118,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
};

const AGY: ModelRef = { provider: "agy", modelId: "gemini-3.8-flash-high" };
const HAIKU: ModelRef = { provider: "anthropic", modelId: "claude-haiku-5-5" };
const SONNET: ModelRef = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

/** Veredito simulado por degrau: o agy e o Haiku reprovam, o Sonnet aprova. */
const ORACLE: Record<number, boolean> = { 0: false, 1: false, 2: true };

test("escada híbrida agy -> Haiku -> Sonnet: escalona por oráculo, todos os ledgers conformes, usage do agy registrado", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-agy-ladder-"));
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: PROBE_USAGE });
	const agyStream = createAgyStreamFn({ cwd: dir, timeoutMs: 5000, spawn: mock.spawn });
	const haikuRuntime = fauxRuntime("anthropic", ["claude-haiku-5-5"]);
	const sonnetRuntime = fauxRuntime("anthropic", ["claude-sonnet-4-6"]);
	const subscription: PriceBook = { kind: "subscription", id: "ladder-test", source: "teste offline" };

	const policy = new ExecutionGuidedLadderPolicy({
		rungs: [
			{ model: AGY, costShareCap: 0.2 },
			{ model: HAIKU, costShareCap: 0.5 },
			{ model: SONNET, costShareCap: 1 },
		],
		globalMaxCostUsd: 10,
	});

	const history: Attempt[] = [];
	const decisions: RouterDecision[] = [];
	const ledgers: string[] = [];
	let decision: RouterDecision = policy.decide(history);
	while (decision.kind === "run") {
		decisions.push(decision);
		const ledgerPath = join(dir, `step-${decision.rung}.jsonl`);
		ledgers.push(ledgerPath);
		const common = {
			ledgerPath,
			runId: `ladder-${decision.rung}`,
			harnessVariant: "dv-ladder-hybrid-test",
			referenceProvenance: { harness: "dv-eval" },
			datasetSha256: "e".repeat(64),
			taskDefinitionSha256: "f".repeat(64),
			tools: [],
			prompt: "responda ok",
			maxCostUsd: decision.cap_usd,
			doomLoopMaxIdenticalConsecutive: 3,
			approvedProbes: new Set(["agy"]),
		};
		let run: { status: string };
		if (decision.model.provider === "agy") {
			run = await executeRung({
				...common,
				model: agyModel(decision.model.modelId),
				streamFn: agyStream,
				priceBook: subscription,
			});
		} else {
			const runtime = decision.rung === 1 ? haikuRuntime : sonnetRuntime;
			runtime.script([textTurn("ok", usage(1000, 50))]);
			run = await executeRung({
				...common,
				model: runtime.modelOf(decision.model.modelId),
				streamFn: runtime.streamFn,
				priceBook: subscription,
			});
		}
		assert.equal(run.status, "completed", `degrau ${decision.rung} concluiu`);
		history.push({
			rung: decision.rung,
			role: decision.role,
			model: decision.model,
			verification: { oracle_pass: ORACLE[decision.rung] ?? false, status: ORACLE[decision.rung] ? "pass" : "fail" },
			spent_lower_bound_usd: 0,
		} as Attempt);
		decision = policy.decide(history);
	}

	assert.deepEqual(
		decisions.map((d) => (d.kind === "run" ? `${d.rung}:${d.model.provider}/${d.model.modelId}` : "stop")),
		["0:agy/gemini-3.8-flash-high", "1:anthropic/claude-haiku-5-5", "2:anthropic/claude-sonnet-4-6"],
	);
	assert.deepEqual(decision, { kind: "stop", outcome: "solved", reason: "oráculo aprovou" });

	// Cada degrau gravou o próprio ledger; nenhum tem violação estrutural (FAIL). O agy fica INCONCLUSIVE pela regra
	// de entrada não cacheada, que ainda não foi verificada por probe.
	for (const path of ledgers) assert.notEqual(checkLedgerConformance(path).status, "FAIL", path);
	const agyLines = readFileSync(ledgers[0] as string, "utf8")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const agyCall = agyLines.find((l) => l.event === "call_finished") as {
		record: { telemetry: Record<string, unknown> };
	};
	assert.equal(agyCall.record.telemetry.reasoning_tokens, 117);
	assert.equal(agyCall.record.telemetry.completion_tokens, 118);
	assert.equal(mock.children.length, 1, "um processo ACP para o único turno do agy");
	assert.equal(mock.children[0]?.alive, false, "processo do agy encerrado");
});

test("escada híbrida: sem probe aprovado para o agy, o primeiro degrau é bloqueado e nada é gasto", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-agy-ladder-gate-"));
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: PROBE_USAGE });
	const agyStream = createAgyStreamFn({ cwd: dir, timeoutMs: 5000, spawn: mock.spawn });
	await assert.rejects(
		executeRung({
			ledgerPath: join(dir, "blocked.jsonl"),
			runId: "blocked",
			harnessVariant: "dv-ladder-hybrid-test",
			referenceProvenance: { harness: "dv-eval" },
			datasetSha256: "e".repeat(64),
			taskDefinitionSha256: "f".repeat(64),
			model: agyModel("gemini-3.8-flash-high"),
			tools: [],
			prompt: "responda ok",
			streamFn: agyStream,
			priceBook: { kind: "subscription", id: "ladder-test", source: "teste offline" },
			maxCostUsd: 1,
			doomLoopMaxIdenticalConsecutive: 3,
			approvedProbes: new Set(),
		}),
		/PROVISIONAL/,
	);
	assert.equal(mock.children.length, 0, "nenhum processo aberto sem probe");
});

test("catálogo agy: os seis modelos do probe são aceitos e um id fora da lista é rejeitado", async () => {
	const { AGY_MODELS, isAgyModel } = await import("@dv-agent/core");
	const ids = AGY_MODELS.map((m) => m.modelId);
	assert.equal(ids.length, 6);
	for (const id of ids) assert.ok(isAgyModel(id), id);
	assert.equal(isAgyModel("gemini-inexistente"), false);
	assert.equal(agyModel("gemini-3.8-flash-high").provider, "agy");
	assert.throws(() => agyModel("gemini-inexistente"), /modelo agy desconhecido/);
});

test("openLiveSession para agy: só assinatura, só modelos do catálogo, preço de assinatura (sem tarifa por token)", async () => {
	const { openLiveSession } = await import("../src/auth/live_session.ts");
	const base = { provider: "agy", authPath: "/nao-usado.json" };
	await assert.rejects(
		openLiveSession({ ...base, authMode: "api-key", modelId: "gemini-3.8-flash-high" }),
		/use --auth-mode subscription/,
	);
	await assert.rejects(
		openLiveSession({ ...base, authMode: "subscription", modelId: "gemini-inexistente" }),
		/modelo agy desconhecido/,
	);
	const session = await openLiveSession({ ...base, authMode: "subscription", modelId: "gemini-3.8-flash-high" });
	assert.equal(session.model.provider, "agy");
	assert.equal(session.priceBook.kind, "subscription");
	assert.equal(typeof session.streamFn, "function");
});
