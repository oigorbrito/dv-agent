// Smoke end-to-end (offline): políticas single, ladder e architect-editor com oráculo externo por degrau,
// gate de capacidade no modo api-key, e escalonamento por doom_loop ponta a ponta.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	checkLedgerConformance,
	classifyVerification,
	createWorkspaceTools,
	ExecutionGuidedLadderPolicy,
	executeRung,
	fauxRuntime,
	textTurn,
	toolTurn,
	usage,
} from "@dv-agent/core";
import { runOracle } from "../src/oracle/verifier.ts";
import { buildPolicy, runSmoke, type SmokeOptions } from "../src/smoke/runner.ts";

const TASK = resolve(import.meta.dirname, "../tasks/calc-basic");
const PROBES = mkdtempSync(join(tmpdir(), "dv-smoke-probes-"));

function opts(policy: SmokeOptions["policy"], extra: Partial<SmokeOptions> = {}): SmokeOptions {
	return {
		taskDir: TASK,
		policy,
		authMode: "offline-faux",
		outdir: mkdtempSync(join(tmpdir(), `dv-smoke-${policy}-`)),
		maxCostUsd: 0.05,
		probesDir: PROBES,
		...extra,
	};
}

test("single: um modelo, roteiro errado, oráculo FAIL e parada unsolved", async () => {
	const summary = await runSmoke(opts("single"));
	assert.equal(summary.final_outcome, "unsolved");
	assert.equal(summary.steps.length, 1);
	assert.equal(summary.steps[0]?.oracle?.verdict, "FAIL");
	assert.deepEqual(checkLedgerConformance(summary.steps[0]?.ledger_path ?? "").violations, []);
});

test("ladder: FAIL no degrau 0 promove ao degrau 1; cada degrau tem ledger e result.json próprios", async () => {
	const options = opts("ladder");
	const summary = await runSmoke(options);
	assert.equal(summary.final_outcome, "solved");
	assert.deepEqual(
		summary.steps.map((s) => [s.rung, s.model, s.oracle?.verdict]),
		[
			[0, "anthropic/faux-cheap", "FAIL"],
			[1, "anthropic/faux-strong", "PASS"],
		],
	);
	for (const step of summary.steps) {
		assert.equal(createHash("sha256").update(readFileSync(step.ledger_path)).digest("hex"), step.ledger_sha256);
		assert.deepEqual(checkLedgerConformance(step.ledger_path).violations, []);
		assert.ok(existsSync(step.oracle?.result_path ?? ""));
	}
	assert.notEqual(summary.steps[0]?.ledger_path, summary.steps[1]?.ledger_path);
	const persisted = JSON.parse(readFileSync(join(options.outdir, "summary.json"), "utf8")) as { final_outcome: string };
	assert.equal(persisted.final_outcome, "solved");
});

test("buildPolicy: ladder aceita três degraus mistos começando em agy", () => {
	const policy = buildPolicy(
		opts("ladder", {
			authMode: "subscription",
			ladderModels: ["agy/gemini-3.8-flash-high", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"],
			model: "anthropic/claude-haiku-4-5",
			maxCostUsd: 10,
		}),
	);
	assert.deepEqual(
		[
			policy.decide([]),
			policy.decide([
				{
					rung: 0,
					role: "rung_0",
					model: { provider: "agy", modelId: "gemini-3.8-flash-high" },
					verification: { oracle_pass: false, status: "fail" },
					spent_lower_bound_usd: 0,
				},
			]),
		].map((decision) =>
			decision.kind === "run" ? `${decision.rung}:${decision.model.provider}/${decision.model.modelId}` : decision.kind,
		),
		["0:agy/gemini-3.8-flash-high", "1:anthropic/claude-haiku-4-5"],
	);
});

test("ladder com quatro modelos: faux percorre quatro degraus até o forte passar", async () => {
	const summary = await runSmoke(
		opts("ladder", {
			ladderModels: ["Haiku 5.5", "Fable 5.2", "Sonnet 5.5", "Opus 5.5"],
		}),
	);
	assert.equal(summary.final_outcome, "solved");
	assert.deepEqual(
		summary.steps.map((step) => [step.rung, step.model, step.oracle?.verdict]),
		[
			[0, "anthropic/faux-cheap", "FAIL"],
			[1, "anthropic/faux-cheap", "FAIL"],
			[2, "anthropic/faux-cheap", "FAIL"],
			[3, "anthropic/faux-strong", "PASS"],
		],
	);
});

test("ladder resolve os quatro nomes Anthropic para IDs cadastrados sem abrir sessão live", () => {
	const ladder = buildPolicy(
		opts("ladder", {
			authMode: "api-key",
			ladderModels: ["Haiku 5.5", "Fable 5.2", "Sonnet 5.5", "Opus 5.5"],
		}),
	);
	const models: string[] = [];
	let decision = ladder.decide([]);
	while (decision.kind === "run") {
		models.push(`${decision.model.provider}/${decision.model.modelId}`);
		decision = ladder.decide([
			{
				rung: decision.rung,
				role: decision.role,
				model: decision.model,
				verification: { oracle_pass: false, status: "fail" },
				spent_lower_bound_usd: 0,
			},
		]);
	}
	assert.deepEqual(models, [
		"anthropic/claude-haiku-5-5",
		"anthropic/claude-fable-5-2",
		"anthropic/claude-sonnet-5-5",
		"anthropic/claude-opus-5-5",
	]);
});

test("architect-editor: passo de plano sem oráculo, depois editor com oráculo PASS", async () => {
	const summary = await runSmoke(opts("architect-editor"));
	assert.equal(summary.final_outcome, "solved");
	assert.equal(summary.steps[0]?.role, "architect");
	assert.equal(summary.steps[0]?.oracle, null);
	assert.equal(summary.steps[1]?.role, "editor");
	assert.equal(summary.steps[1]?.plan_from_architect, true);
	assert.equal(summary.steps[1]?.oracle?.verdict, "PASS");
});

test("api-key sem --model: erro de configuração claro", async () => {
	await assert.rejects(runSmoke(opts("single", { authMode: "api-key" })), /--model é obrigatório/);
});

test("subscription sem sessão no auth.json: parada blocked com instrução de login, sem chamada", async () => {
	const emptyAuth = join(mkdtempSync(join(tmpdir(), "dv-smoke-noauth-")), "auth.json");
	const summary = await runSmoke(
		opts("single", { authMode: "subscription", model: "anthropic/claude-sonnet-4-5", authPath: emptyAuth }),
	);
	assert.equal(summary.final_outcome, "blocked");
	assert.match(summary.blocked_reason ?? "", /npx @earendil-works\/pi-ai@1\.6\.0 login anthropic/);
	assert.equal(summary.steps.length, 0);
});

test("api-key com provedor PROVISIONAL sem probe: parada blocked antes de qualquer chamada", async () => {
	const summary = await runSmoke(opts("single", { authMode: "api-key", model: "openai/gpt-4.1" }));
	assert.equal(summary.final_outcome, "blocked");
	assert.match(summary.blocked_reason ?? "", /PROVISIONAL sem probe aprovado/);
	assert.equal(summary.steps.length, 0);
});

test("doom_loop: repetição bloqueada, oráculo FAIL vira status doom_loop e o ladder promove", async () => {
	const work = mkdtempSync(join(tmpdir(), "dv-doom-ws-"));
	cpSync(join(TASK, "workspace"), work, { recursive: true });
	const runtime = fauxRuntime("anthropic", ["faux-cheap"]);
	const u = usage(500, 50, { reasoning: 0 });
	runtime.script([
		...Array.from({ length: 5 }, (_, i) =>
			toolTurn("edit_file", { path: "calc.py", old_text: "return a - b", new_text: "return a + b + 1" }, u, `d${i}`),
		),
		textTurn("desisti", u),
	]);
	const ledgerPath = join(mkdtempSync(join(tmpdir(), "dv-doom-led-")), "ledger.jsonl");
	const run = await executeRung({
		ledgerPath,
		runId: "doom-e2e",
		harnessVariant: "dv-smoke:doom-test",
		referenceProvenance: { test: "doom" },
		datasetSha256: "a".repeat(64),
		taskDefinitionSha256: "b".repeat(64),
		model: runtime.modelOf("faux-cheap"),
		tools: createWorkspaceTools({ workspaceRoot: work }),
		prompt: "corrija",
		streamFn: runtime.streamFn,
		priceBook: {
			kind: "metered",
			id: "t",
			source: "t",
			entries: { "anthropic/faux-cheap": { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } },
		},
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 2,
	});
	assert.equal(run.status, "completed");
	const oracle = await runOracle({
		taskDir: TASK,
		candidateDir: work,
		outdir: mkdtempSync(join(tmpdir(), "dv-doom-out-")),
		ledgerPath,
	});
	assert.equal(oracle.verdict, "FAIL");
	assert.ok((oracle.ledger?.summary.doom_loop_blocks ?? 0) > 0);
	assert.equal(oracle.verification.status, "doom_loop");

	const cheap = { provider: "anthropic", modelId: "faux-cheap" };
	const ladder = new ExecutionGuidedLadderPolicy({
		rungs: [
			{ model: cheap, costShareCap: 0.5 },
			{ model: { provider: "anthropic", modelId: "faux-strong" }, costShareCap: 1 },
		],
		globalMaxCostUsd: 1,
	});
	const next = ladder.decide([
		{
			rung: 0,
			role: "rung_0",
			model: cheap,
			verification: oracle.verification,
			spent_lower_bound_usd: run.spentLowerBoundUsd,
		},
	]);
	assert.equal(next.kind, "run");
	assert.equal(next.kind === "run" ? next.rung : -1, 1);
	assert.equal(
		classifyVerification({
			oracle: "FAIL",
			doomLoopBlocks: 0,
			budgetTripped: false,
			budgetUnverifiable: false,
			providerError: false,
		}).status,
		"fail",
	);
});
