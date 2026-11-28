// Catálogo do dv-eval: o catálogo vendorizado do pi-ai não traz gpt-6.1-luna desde a 1.7.0; o overlay local
// (src/catalog/overlay.ts) o registra com metadados herdados de gpt-6-luna. Offline: sem rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getChatModel, overlayModelIds } from "../src/catalog/overlay.ts";

interface CatalogModel {
	id: string;
	name: string;
	api: string;
	contextWindow: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

test("catálogo vendorizado do pi-ai não contém gpt-6.1-luna (confirma a origem do overlay)", () => {
	assert.equal(getBuiltinModel("openai-codex" as never, "gpt-6.1-luna" as never), undefined);
});

test("overlay resolve openai-codex/gpt-6.1-luna sem erro de modelo ausente", () => {
	const model = getChatModel("openai-codex" as never, "gpt-6.1-luna") as unknown as CatalogModel | undefined;
	assert.ok(model, "modelo ausente no overlay");
	assert.equal(model.id, "gpt-6.1-luna");
	assert.equal(model.name, "GPT-6.1 Luna");
	assert.ok(overlayModelIds().includes("openai-codex/gpt-6.1-luna"));
});

test("gpt-6.1-luna herda api, janela e preços do gpt-6-luna", () => {
	const model = getChatModel("openai-codex" as never, "gpt-6.1-luna") as unknown as CatalogModel;
	const reference = getChatModel("openai-codex" as never, "gpt-6-luna") as unknown as CatalogModel;
	assert.ok(reference, "gpt-6-luna ausente no catálogo");
	assert.equal(model.api, reference.api);
	assert.equal(model.api, "openai-codex-responses");
	assert.equal(model.contextWindow, reference.contextWindow);
	assert.deepEqual(model.cost, reference.cost);
});

test("modelo fora do overlay e do catálogo continua indefinido", () => {
	assert.equal(getChatModel("openai-codex" as never, "modelo-inexistente" as never), undefined);
});
