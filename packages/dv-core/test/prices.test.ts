// Custo por chamada: faixas de preço por tamanho de entrada (regra do pi-ai) e escrita de cache de 1h (2x entrada).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { costForMessage, type PriceBook } from "../src/ledger/prices.ts";

function message(usage: Partial<AssistantMessage["usage"]>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
			...usage,
		},
	} as AssistantMessage;
}

const book: PriceBook = {
	kind: "metered",
	id: "test",
	source: "test",
	entries: {
		"anthropic/m": {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 1000, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }],
		},
	},
};

test("custo usa a faixa de preço atingida pela entrada da requisição inteira", () => {
	// 2000 tokens de entrada passam do limite de 1000: a faixa de 3/4 vale para tudo.
	const cost = costForMessage(message({ input: 2000, output: 100 }), book);
	assert.ok(cost !== null && cost.usd !== null);
	assert.ok(Math.abs(cost.usd - (2000 * 3 + 100 * 4) / 1_000_000) < 1e-12);
});

test("custo usa a faixa base abaixo do limite", () => {
	const cost = costForMessage(message({ input: 500, output: 100 }), book);
	assert.ok(cost !== null && cost.usd !== null);
	assert.ok(Math.abs(cost.usd - (500 * 1 + 100 * 2) / 1_000_000) < 1e-12);
});

test("limite conta cache de leitura e de escrita na entrada", () => {
	// 600 + 500 de cache de leitura = 1100 > 1000: faixa alta.
	const cost = costForMessage(message({ input: 600, cacheRead: 500, output: 0 }), book);
	assert.ok(cost !== null && cost.usd !== null);
	assert.ok(Math.abs(cost.usd - (600 * 3) / 1_000_000) < 1e-12);
});

test("escrita de cache de 1h custa 2x a entrada, como no pi-ai", () => {
	const flat: PriceBook = {
		kind: "metered",
		id: "flat",
		source: "test",
		entries: { "anthropic/m": { input: 1, output: 0, cacheRead: 0, cacheWrite: 1.25 } },
	};
	const cost = costForMessage(message({ cacheWrite: 100, cacheWrite1h: 100 }), flat);
	assert.ok(cost !== null && cost.usd !== null);
	assert.ok(Math.abs(cost.usd - (100 * 2) / 1_000_000) < 1e-12);
});
