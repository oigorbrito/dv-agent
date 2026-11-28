// Catálogo local do pi-ai: openai-codex/gpt-6.1-luna resolve sem erro de modelo ausente e herda os metadados
// do gpt-6-luna (api, janela e preços). Offline: lê só os dados gerados localmente.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

interface CatalogModel {
	id: string;
	name: string;
	api: string;
	contextWindow: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function lookup(id: string): CatalogModel | undefined {
	// Mesmo padrão de live_session.ts: o catálogo é tipado por id; a entrada é validada logo abaixo.
	return getBuiltinModel("openai-codex" as never, id as never) as unknown as CatalogModel | undefined;
}

test("openai-codex/gpt-6.1-luna resolve pelo catálogo local sem erro de modelo ausente", () => {
	const model = lookup("gpt-6.1-luna");
	assert.ok(model, "modelo ausente no catálogo local");
	assert.equal(model.id, "gpt-6.1-luna");
	assert.equal(model.name, "GPT-6.1 Luna");
});

test("gpt-6.1-luna herda api, janela e preços do gpt-6-luna (metadados não publicados aqui)", () => {
	const model = lookup("gpt-6.1-luna");
	const reference = lookup("gpt-6-luna");
	assert.ok(model && reference, "referência ausente");
	// Valor real do catálogo: "openai-codex-responses" (o pedido citava "codex-responses").
	assert.equal(model.api, reference.api);
	assert.equal(model.api, "openai-codex-responses");
	assert.equal(model.contextWindow, reference.contextWindow);
	assert.deepEqual(model.cost, reference.cost);
});
