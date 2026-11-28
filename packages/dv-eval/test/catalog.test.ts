// Catálogo local do pi-ai: openai-codex/gpt-6.1-luna não está no catálogo, porque o backend recusa o modelo
// com conta ChatGPT (probe live, 2026-11; ver BENCHMARK-REPORT.md, seção 7). gpt-6-luna segue resolvível.
// Offline: lê só os dados gerados localmente.
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

test("openai-codex/gpt-6.1-luna está ausente do catálogo local", () => {
	assert.equal(lookup("gpt-6.1-luna"), undefined);
});

test("openai-codex/gpt-6-luna segue resolvível com api e janela publicadas", () => {
	const reference = lookup("gpt-6-luna");
	assert.ok(reference, "gpt-6-luna ausente no catálogo local");
	assert.equal(reference.id, "gpt-6-luna");
	assert.equal(reference.api, "openai-codex-responses");
	assert.equal(reference.contextWindow, 272000);
});
