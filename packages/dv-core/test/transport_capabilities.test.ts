// Tabela de transporte pi-ai: campos declarados não expostos não viram INCONCLUSIVE; campo exposto ausente continua falha.
// Também cobre a classificação de verificação e o escalonamento padrão do ExecutionGuidedLadderPolicy.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Attempt,
	buildCallTelemetry,
	checkLedgerConformance,
	classifyVerification,
	DEFAULT_ESCALATE_ON_STATUSES,
	ExecutionGuidedLadderPolicy,
	transportFor,
} from "../src/index.ts";
import { priceBookFor, textTurn, usage } from "./support.ts";

function msg(api: string, provider: string, u: AssistantMessage["usage"]): AssistantMessage {
	return { ...textTurn("ok", u).message, api, provider, model: "m", usage: u };
}

test("anthropic-messages: reasoning não exposto e cache_write não exposto são declarados, telemetria MEASURED", () => {
	const u = usage(1000, 50, { cacheRead: 200 }); // reasoning omitido, como no transporte padrão
	const t = buildCallTelemetry("anthropic", msg("anthropic-messages", "anthropic", u), priceBookFor(["anthropic/m"]));
	assert.equal(t.reasoning_tokens, null);
	assert.equal(t.cache_read_tokens, 200);
	assert.equal(t.cache_write_tokens, 0, "cache_write exposto pelo anthropic-messages: 0 é medição");
	assert.deepEqual(t.declared_not_exposed, ["reasoning_tokens"]);
	assert.deepEqual(t.missing_buckets, []);
	assert.equal(t.cost_accounting_status, "MEASURED");
});

test("openai-completions: reasoning exposto e ausente continua faltante (INCONCLUSIVE), cache_write declarado não exposto", () => {
	const u = usage(1000, 50, { cacheRead: 200 });
	const t = buildCallTelemetry("openai", msg("openai-completions", "openai", u), priceBookFor(["openai/m"]));
	// uncached não tem regra para openai (PROVISIONAL); reasoning é exposto por este transporte, então ausente falha.
	assert.deepEqual(t.missing_buckets, ["reasoning_tokens", "uncached_input_tokens"]);
	assert.equal(t.reasoning_tokens, null);
	assert.ok(!t.declared_not_exposed.includes("reasoning_tokens"));
	assert.equal(t.cache_write_tokens, null);
	assert.ok(t.declared_not_exposed.includes("cache_write_tokens"));
	assert.equal(t.telemetry_complete, false);
});

test("transporte desconhecido: sem linha, nada é declarado e reasoning faltante é falha", () => {
	assert.equal(transportFor("mistral-conversations"), undefined);
	const t = buildCallTelemetry(
		"mistral",
		msg("mistral-conversations", "mistral", usage(10, 5)),
		priceBookFor(["mistral/m"]),
	);
	assert.ok(t.missing_buckets.includes("reasoning_tokens"));
	assert.deepEqual(t.declared_not_exposed, []);
});

test("faux:* resolve para a linha de teste", () => {
	assert.equal(transportFor("faux:123:abc")?.test_only, true);
});

test("checker aceita nulo declarado e rejeita nulo sem declaração", async () => {
	const { writeFileSync, mkdtempSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { canonicalJson } = await import("../src/util/canonical.ts");
	const dir = mkdtempSync(join(tmpdir(), "dv-chk-"));
	const telemetry = (over: Record<string, unknown>): Record<string, unknown> => ({
		prompt_tokens: 10,
		completion_tokens: 5,
		total_tokens: 15,
		uncached_input_tokens: 10,
		cache_read_tokens: 0,
		cache_write_tokens: null,
		reasoning_tokens: null,
		cost_usd: 0.1,
		cost_basis: "price_book:x",
		declared_not_exposed: ["cache_write_tokens", "reasoning_tokens"],
		missing_buckets: [],
		telemetry_complete: true,
		cost_accounting_status: "MEASURED",
		...over,
	});
	const ledgerWith = (t: Record<string, unknown>): string => {
		const events = [
			{
				schema: "dv-run-ledger-v2",
				event: "run_started",
				run_id: "r",
				contract_id: "p1-run-accounting-v4",
				harness_variant: "t",
				reference_provenance: { h: "x" },
				dataset_sha256: "a".repeat(64),
				task_definition_sha256: "b".repeat(64),
				max_cost_usd: 1,
				model: { provider: "p", model_id: "m", api: "a" },
				guards: { doom_loop_max_identical_consecutive: 3 },
			},
			{ schema: "dv-run-ledger-v2", event: "call_started", call_index: 1, provider: "p", model_id: "m", api: "a" },
			{
				schema: "dv-run-ledger-v2",
				event: "call_finished",
				call_index: 1,
				record: {
					stop_reason: "stop",
					usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15 },
					telemetry: t,
					tool_calls: [],
				},
			},
			{
				schema: "dv-run-ledger-v2",
				event: "run_finished",
				status: "completed",
				calls_started: 1,
				calls_finished: 1,
				in_flight_call_indices: [],
				spent_lower_bound_usd: 0.1,
				unknown_cost_calls: 0,
				non_metered_cost_calls: 0,
				ceiling_status: "within_verified",
				guard_events: { doom_loop_blocks: 0, budget_blocked_tools: 0, limit_reason: null },
			},
		];
		return `${events.map((ev) => canonicalJson(ev)).join("\n")}\n`;
	};
	const ok = join(dir, "ok.jsonl");
	writeFileSync(ok, ledgerWith(telemetry({})));
	assert.deepEqual(checkLedgerConformance(ok).violations, []);
	const bad = join(dir, "bad.jsonl");
	writeFileSync(bad, ledgerWith(telemetry({ declared_not_exposed: ["reasoning_tokens"], missing_buckets: [] })));
	assert.match(checkLedgerConformance(bad).violations.join("|"), /cache_write_tokens nulo sem declaração/);
});

test("classifyVerification: oráculo é soberano; sinais de runtime só refinam FAIL", () => {
	assert.deepEqual(
		classifyVerification({
			oracle: "PASS",
			doomLoopBlocks: 3,
			budgetTripped: true,
			budgetUnverifiable: false,
			providerError: false,
		}),
		{ oracle_pass: true, status: "pass" },
	);
	assert.deepEqual(
		classifyVerification({
			oracle: "FAIL",
			doomLoopBlocks: 2,
			budgetTripped: false,
			budgetUnverifiable: false,
			providerError: false,
		}),
		{ oracle_pass: false, status: "doom_loop" },
	);
	assert.deepEqual(
		classifyVerification({
			oracle: "FAIL",
			doomLoopBlocks: 0,
			budgetTripped: true,
			budgetUnverifiable: false,
			providerError: false,
		}),
		{ oracle_pass: false, status: "budget_exceeded" },
	);
	assert.deepEqual(
		classifyVerification({
			oracle: "FAIL",
			doomLoopBlocks: 0,
			budgetTripped: false,
			budgetUnverifiable: false,
			providerError: false,
		}),
		{ oracle_pass: false, status: "fail" },
	);
	assert.deepEqual(
		classifyVerification({
			oracle: "NO_VERDICT",
			doomLoopBlocks: 0,
			budgetTripped: false,
			budgetUnverifiable: false,
			providerError: true,
		}),
		{ oracle_pass: null, status: "provider_error" },
	);
});

test("escalonamento padrão: doom_loop e budget_exceeded promovem; provider_error não", () => {
	assert.deepEqual([...DEFAULT_ESCALATE_ON_STATUSES], ["fail", "doom_loop", "budget_exceeded"]);
	const CHEAP = { provider: "anthropic", modelId: "a" };
	const policy = new ExecutionGuidedLadderPolicy({
		rungs: [
			{ model: CHEAP, costShareCap: 0.5 },
			{ model: { provider: "anthropic", modelId: "b" }, costShareCap: 1 },
		],
		globalMaxCostUsd: 2,
	});
	const attempt = (
		status: Attempt["verification"] extends infer V ? (V extends { status: infer S } ? S : never) : never,
		pass: null | false,
	): Attempt => ({
		rung: 0,
		role: "rung_0",
		model: CHEAP,
		spent_lower_bound_usd: 0.1,
		verification: { oracle_pass: pass, status },
	});
	for (const status of ["doom_loop", "budget_exceeded"] as const) {
		assert.equal(policy.decide([attempt(status, false)]).kind, "run", `${status} promove`);
	}
	assert.equal(policy.decide([attempt("provider_error", null)]).kind, "stop");
});

test("erro do provedor sem usage: zero não é medição, telemetria INCONCLUSIVE", () => {
	const failed = {
		...msg("anthropic-messages", "anthropic", usage(0, 0)),
		stopReason: "error" as const,
		errorMessage: "404 model not found",
	};
	const t = buildCallTelemetry("anthropic", failed, priceBookFor(["anthropic/m"]));
	assert.ok(t.missing_buckets.includes("usage_not_reported"));
	assert.equal(t.telemetry_complete, false);
	assert.equal(t.cost_accounting_status, "INCONCLUSIVE");
});
