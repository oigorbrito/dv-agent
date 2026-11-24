// Testes da identidade de transporte e blindagem de User-Agent oficial.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DV_CLIENT_IDENTITY, DV_USER_AGENT, dvHttpHeaders, isCloudflareBlocked } from "../src/index.ts";

test("DV_USER_AGENT é explícito, documentado e não usa defaults genéricos", () => {
	assert.ok(DV_USER_AGENT.startsWith("dv-agent/"));
	assert.ok(DV_USER_AGENT.includes("github.com/oigorbrito/DV"));
	assert.ok(!DV_USER_AGENT.includes("Python-urllib"));
	assert.ok(!DV_USER_AGENT.includes("curl/"));
});

test("dvHttpHeaders embute User-Agent e aceita headers adicionais", () => {
	const headers = dvHttpHeaders({ Accept: "application/json" });
	assert.equal(headers["User-Agent"], DV_USER_AGENT);
	assert.equal(headers.Accept, "application/json");
});

test("DV_CLIENT_IDENTITY expõe userAgent customizado e atribuição", () => {
	assert.equal(DV_CLIENT_IDENTITY.userAgent.custom, DV_USER_AGENT);
	assert.equal(DV_CLIENT_IDENTITY.attribution.name, "dv-agent");
});

test("isCloudflareBlocked detecta bloqueio HTTP 403 com erro 1010", () => {
	assert.equal(isCloudflareBlocked(403, "error code: 1010"), true);
	assert.equal(isCloudflareBlocked(403, "Cloudflare Ray ID ... 1010"), true);
	assert.equal(isCloudflareBlocked(403, "Forbidden without cf code"), false);
	assert.equal(isCloudflareBlocked(503, "error code: 1010"), false);
	assert.equal(isCloudflareBlocked(403, undefined), false);
});
