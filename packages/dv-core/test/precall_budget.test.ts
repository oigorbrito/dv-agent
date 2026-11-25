// Gate pré-chamada do orçamento: nenhuma chamada cujo custo máximo passe do saldo do teto chega ao provedor.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { PriceBook, PriceEntry } from "../src/index.ts";
import { BudgetGuard, executeRung } from "../src/index.ts";
import { fauxRuntime, priceBookFor, TEST_PRICE, tempDir, textTurn, usage } from "./support.ts";

const CONTEXT = { systemPrompt: "sys", messages: [], tools: [] } as const;

function fakeModel(maxTokens: number) {
	return {
		id: "m",
		provider: "anthropic",
		api: "anthropic-messages",
		maxTokens,
	} as never;
}

test("gate: assinatura não tem teto em USD e devolve o pedido intacto", () => {
	const guard = new BudgetGuard({
		maxCostUsd: 0.01,
		priceBook: { kind: "subscription", id: "sub", source: "test" },
	});
	const allowance = guard.preCallAllowance(fakeModel(4096), CONTEXT as never, 1000);
	assert.deepEqual(allowance, { ok: true, maxTokens: 1000 });
});

test("gate: saída é limitada ao saldo restante (floor(saldo / preço de saída))", () => {
	// saldo 1 USD, saída a 4 USD/M: no máximo 250.000 tokens (menos a parcela de entrada, desprezível aqui).
	const guard = new BudgetGuard({ maxCostUsd: 1, priceBook: priceBookFor(["anthropic/m"]) });
	const allowance = guard.preCallAllowance(fakeModel(10_000_000), CONTEXT as never);
	assert.equal(allowance.ok, true);
	if (allowance.ok) {
		assert.ok(allowance.maxTokens <= 250_000, `maxTokens ${allowance.maxTokens} excede o saldo`);
		assert.ok(
			allowance.maxTokens > 240_000,
			"o limite é o saldo (menos o overhead de entrada), não um valor arbitrário",
		);
	}
});

test("gate: o teto de saída nunca passa do maxTokens do modelo", () => {
	const guard = new BudgetGuard({ maxCostUsd: 1, priceBook: priceBookFor(["anthropic/m"]) });
	const allowance = guard.preCallAllowance(fakeModel(1234), CONTEXT as never);
	assert.deepEqual(allowance, { ok: true, maxTokens: 1234 });
});

test("gate: entrada projetada pela maior faixa de preço; bloqueia quando o pior caso excede o saldo", () => {
	const tiered: PriceEntry = {
		...TEST_PRICE,
		tiers: [{ inputTokensAbove: 0, input: 1000, output: 4, cacheRead: 0.1, cacheWrite: 1.25 }],
	};
	const book: PriceBook = { kind: "metered", id: "t", source: "t", entries: { "anthropic/m": tiered } };
	const guard = new BudgetGuard({ maxCostUsd: 0.5, priceBook: book });
	const allowance = guard.preCallAllowance(fakeModel(4096), CONTEXT as never);
	assert.equal(allowance.ok, false, "a faixa de 1000 USD/M torna a entrada projetada maior que o teto");
});

test("gate: sem preço conhecido não há projeção em USD (contract v4, regra b): a chamada segue", () => {
	const guard = new BudgetGuard({ maxCostUsd: 0.01, priceBook: priceBookFor([]) });
	assert.deepEqual(guard.preCallAllowance(fakeModel(64), CONTEXT as never), { ok: true, maxTokens: 64 });
});

test("guard: gasto conservador usa a faixa do pi-ai quando ela excede a tabela; ledger (spent) não muda", () => {
	const guard = new BudgetGuard({ maxCostUsd: 10, priceBook: priceBookFor(["anthropic/m"]) });
	const message = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			...usage(1_000_000, 0, { reasoning: 0 }),
			cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3, totalFromProvider: false },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	guard.onMessageEnd(message as never);
	assert.equal(guard.spentLowerBoundUsd, 1, "custo de tabela (ledger) preservado");
	assert.equal(guard.conservativeSpentUsd, 3, "gasto conservador considera a faixa");
});

test("run: chamada cujo pior caso excede o saldo não chega ao provedor (budget_exceeded, zero chamadas)", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	runtime.script([textTurn("nunca enviado", usage(10, 10))]);
	const ledgerPath = join(tempDir("precall"), "ledger.jsonl");
	const expensive: PriceBook = {
		kind: "metered",
		id: "expensive",
		source: "test",
		entries: { "anthropic/dv-cheap": { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } },
	};
	const result = await executeRung({
		ledgerPath,
		runId: "precall-1",
		harnessVariant: "b0_test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: runtime.modelOf("dv-cheap"),
		tools: [],
		prompt: "oi",
		streamFn: runtime.streamFn,
		priceBook: expensive,
		maxCostUsd: 0.5,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	assert.equal(result.status, "budget_exceeded");
	assert.equal(runtime.faux.getPendingResponseCount(), 1, "o provedor não foi chamado");
	assert.equal(result.spentLowerBoundUsd, 0);
	const events = (await import("node:fs")).readFileSync(ledgerPath, "utf8");
	assert.equal(events.includes('"call_started"'), false, "nenhuma chamada iniciada");
});

test("run: chamadas recebem maxTokens pelo saldo e maxRetries 0 (sem retries ocultos do SDK)", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	runtime.script([textTurn("ok", usage(10, 10))]);
	const seen: Record<string, unknown>[] = [];
	const ledgerPath = join(tempDir("precall-opts"), "ledger.jsonl");
	await executeRung({
		ledgerPath,
		runId: "precall-2",
		harnessVariant: "b0_test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: runtime.modelOf("dv-cheap"),
		tools: [],
		prompt: "oi",
		streamFn: (m, c, o) => {
			seen.push({ ...(o as object) });
			return runtime.streamFn(m, c, o);
		},
		priceBook: priceBookFor(["anthropic/dv-cheap"]),
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.maxRetries, 0);
	assert.ok(typeof seen[0]?.maxTokens === "number" && (seen[0].maxTokens as number) <= 250_000);
});

test("gate: a partir da 2ª chamada a entrada é o prefixo medido + cauda nova (não o contexto inteiro em bytes)", () => {
	const guard = new BudgetGuard({ maxCostUsd: 0.05, priceBook: priceBookFor(["anthropic/m"]) });
	// Contexto grande (≈ 200 KB de texto): em bytes projetaria 0,2 USD só de entrada, acima do teto.
	const big = "x".repeat(200_000);
	const ctx = { systemPrompt: "s", messages: [{ role: "user", content: big, timestamp: 0 }], tools: [] };
	assert.equal(
		guard.preCallAllowance(fakeModel(64), ctx as never, 64).ok,
		false,
		"1ª chamada: bytes inteiros bloqueiam",
	);
	// Depois de uma chamada medida com 1.000 tokens de entrada e 100 de saída, a cauda é pequena.
	guard.beginRequest({ ...ctx, messages: [ctx.messages[0]] } as never);
	guard.onMessageEnd({
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: usage(1000, 100, { reasoning: 0 }),
		stopReason: "toolUse",
		timestamp: 0,
	} as never);
	const next = { ...ctx, messages: [ctx.messages[0], { role: "user", content: "ok", timestamp: 1 }] };
	assert.equal(guard.preCallAllowance(fakeModel(64), next as never, 64).ok, true);
});
