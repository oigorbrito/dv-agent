// Probe de capacidade: forma do usage, consistência da tabela de transporte, e aprovação só por probe VERIFIED.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertProviderCanRun } from "@dv-agent/core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	checkTransportTable,
	checkUsageShape,
	type LiveProbeResult,
	loadApprovedProbes,
	runOfflineProbe,
	writeProbeResult,
} from "../src/probe/provider_probe.ts";

function withUsage(
	u: Partial<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		reasoning: number;
	}>,
) {
	const base = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return { ...fauxAssistantMessage("x"), usage: { ...base, ...u } };
}

test("offline: pi-ai real (faux) produz usage de forma válida, com cache contabilizado na segunda chamada", async () => {
	const report = await runOfflineProbe();
	assert.equal(report.status, "OFFLINE_SHAPE_CHECKED");
	assert.deepEqual(report.transport_table_violations, []);
	assert.deepEqual(report.usage_shape_violations, []);
	assert.deepEqual(report.cache_semantics.violations, []);
	assert.ok(report.cache_semantics.second.cacheRead > 0);
	assert.match(report.provider_statuses, /PROVISIONAL/);
});

test("checkUsageShape detecta total inconsistente e reasoning maior que output", () => {
	assert.deepEqual(checkUsageShape(withUsage({})), []);
	assert.match(checkUsageShape(withUsage({ totalTokens: 99 })).join("|"), /totalTokens/);
	assert.match(checkUsageShape(withUsage({ reasoning: 9 })).join("|"), /reasoning fora/);
	assert.match(checkUsageShape(withUsage({ input: -1, totalTokens: 4 })).join("|"), /input inválido/);
});

test("tabela de transporte: apis conhecidas, sem duplicata e com fonte", () => {
	assert.deepEqual(checkTransportTable(), []);
});

test("aprovação: só probe live VERIFIED aprova; offline e INCONCLUSIVE não", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-probes-"));
	const live = (provider: string, status: "VERIFIED" | "INCONCLUSIVE"): LiveProbeResult => ({
		schema: "dv-provider-probe-v1",
		mode: "live",
		provider,
		model_id: "m",
		api: "openai-completions",
		status,
		auth_mode: "api-key",
		reasons: [],
		calls: [],
	});
	writeProbeResult(dir, "openai", live("openai", "VERIFIED"));
	writeProbeResult(dir, "gemini", live("gemini", "INCONCLUSIVE"));
	writeProbeResult(dir, "offline-shape", {
		schema: "dv-provider-probe-v1",
		mode: "offline",
		status: "OFFLINE_SHAPE_CHECKED",
	} as never);
	const approved = loadApprovedProbes(dir);
	assert.deepEqual([...approved], ["openai"]);
	assert.doesNotThrow(() => assertProviderCanRun("openai", approved));
	assert.throws(() => assertProviderCanRun("gemini", approved), /PROVISIONAL sem probe aprovado/);
});

test("sem diretório de probes: nada aprovado", () => {
	assert.equal(loadApprovedProbes(join(tmpdir(), "dv-no-such-dir-xyz")).size, 0);
});
