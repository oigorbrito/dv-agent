// Probe live do agy, validado offline com o mock ACP. Nenhuma chamada ao agy real.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgyMockSpawn } from "@dv-agent/core";
import { AGY_PROBE_PROMPT, runAgyProbe } from "../src/probe/agy_probe.ts";
import { loadApprovedProbes, writeProbeResult } from "../src/probe/provider_probe.ts";

// Turno frio (sem cache): T = I + O nas duas leituras.
const COLD = {
	inputTokens: 13193,
	outputTokens: 118,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
};
// Turno quente com cache FORA de inputTokens: T = I + O + cache (1193 + 118 + 12000 = 13311).
const WARM_OUTSIDE = {
	inputTokens: 1193,
	outputTokens: 118,
	cachedReadTokens: 12000,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
};
// Turno quente com cache DENTRO de inputTokens: T = I + O (13193 + 118 = 13311), cache 12000 contido em I.
const WARM_INSIDE = {
	inputTokens: 13193,
	outputTokens: 118,
	cachedReadTokens: 12000,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
};

const base = { cwd: "/tmp", timeoutMs: 2000 };

test("probe: duas chamadas com cache fora de inputTokens -> VERIFIED, handshake e modelos registrados", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_OUTSIDE] });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.status, "VERIFIED", result.reasons.join("; "));
	assert.deepEqual(result.reasons, []);
	assert.equal(result.semantics?.status, "DETERMINED");
	assert.equal(result.semantics?.semantics, "cache_outside_input");
	assert.equal(result.semantics?.proposed_uncached_rule, "input");
	assert.equal(result.handshake?.protocol_version, 1);
	assert.equal(result.models?.current_model_id, "gemini-3.8-flash-high");
	assert.equal(result.models?.available_model_ids.length, 6);
	assert.equal(result.turns.length, 2);
	assert.ok(result.turns.every((t) => t.text_ok && t.usage_missing.length === 0));
	// Sondagem de troca: o mock não suporta set_model, então o erro é registrado como resposta, não como falha.
	assert.equal(result.set_model_probe?.status, "unsupported");
	assert.equal(result.set_model_probe?.code, -32601);
	assert.equal(result.contract_v4_uncached_rule, "ausente_na_tabela_v4");
	assert.equal(mock.children[0]?.alive, false, "processo encerrado");
});

test("probe: um turno só não decide a semântica (cache zero nas duas leituras) -> INCONCLUSIVE", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: COLD });
	const result = await runAgyProbe({ ...base, turns: 1, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.semantics?.status, "INDETERMINATE");
	assert.ok(result.reasons.some((r) => /semântica do usage indeterminada/.test(r)));
});

test("probe: cache dentro de inputTokens -> INCONCLUSIVE (adaptador ainda não mapeia essa semântica)", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_INSIDE] });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.semantics?.semantics, "cache_inside_input");
	assert.equal(result.semantics?.proposed_uncached_rule, "input_minus_cache");
	assert.ok(result.reasons.some((r) => /ajuste exigido antes de aprovar/.test(r)));
});

test("probe: turnos com cache que discordam sobre a semântica -> INCONSISTENT", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [WARM_OUTSIDE, WARM_INSIDE] });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.semantics?.status, "INCONSISTENT");
});

test("probe: total que não bate com nenhuma das fórmulas -> INCONSISTENT", async () => {
	const broken = { ...WARM_OUTSIDE, totalTokens: 99999 };
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, broken] });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.semantics?.status, "INCONSISTENT");
	assert.equal(result.status, "INCONCLUSIVE");
});

test("probe: campo de cache ausente no usage -> INCONCLUSIVE com o campo listado", async () => {
	const { cachedWriteTokens: _omitted, ...partial } = WARM_OUTSIDE;
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, partial] });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.ok(result.reasons.some((r) => /usage incompleto \(cachedWriteTokens\)/.test(r)));
});

test("probe: protocolVersion não numérico -> INCONCLUSIVE", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_OUTSIDE], protocolVersion: "1" });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.handshake?.protocol_version, null);
	assert.ok(result.reasons.some((r) => /protocolVersion/.test(r)));
});

test("probe: queda do agente no turno -> INCONCLUSIVE, erro redigido, processo encerrado", async () => {
	const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
	const mock = createAgyMockSpawn({ mode: "crash_on_prompt", promptError: { code: -32000, message: secret } });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.turns.length, 1, "para no primeiro turno com falha");
	assert.ok(result.turns[0]?.error !== undefined);
	assert.equal(mock.children[0]?.alive, false);
	assert.ok(!JSON.stringify(result).includes(secret), "segredo não pode aparecer no artefato");
});

test("probe: falha no handshake (agente cai no initialize) -> INCONCLUSIVE sem turnos", async () => {
	const mock = createAgyMockSpawn({ mode: "crash_on_init" });
	const result = await runAgyProbe({ ...base, turns: 1, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.turns.length, 0);
	assert.ok(result.reasons[0]?.startsWith("handshake/sessão:"));
	assert.equal(mock.children[0]?.alive, false);
});

test("probe: modelo diferente do padrão da sessão -> INCONCLUSIVE, sem prompt enviado", async () => {
	const mock = createAgyMockSpawn({ mode: "wrong_model" });
	const result = await runAgyProbe({ ...base, turns: 1, spawn: mock.spawn });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.equal(result.turns.length, 0);
	assert.ok(result.reasons[0]?.includes("troca para gemini-3.8-flash-high falhou"));
});

test("probe: set_model suportado é registrado como supported, sem prompt extra", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_OUTSIDE], setModelReply: "empty" });
	const result = await runAgyProbe({ ...base, turns: 2, spawn: mock.spawn });
	assert.equal(result.set_model_probe?.status, "supported");
	assert.equal(result.status, "VERIFIED");
});

test("probe: turnos fora da faixa são recusados antes de qualquer processo", async () => {
	const mock = createAgyMockSpawn();
	await assert.rejects(runAgyProbe({ ...base, turns: 0, spawn: mock.spawn }), /entre 1 e 3/);
	await assert.rejects(runAgyProbe({ ...base, turns: 4, spawn: mock.spawn }), /entre 1 e 3/);
	assert.equal(mock.children.length, 0);
});

test("artefato: VERIFIED aprova o agy no loader; INCONCLUSIVE não aprova", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-agy-probe-"));
	const ok = await runAgyProbe({
		...base,
		turns: 2,
		spawn: createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_OUTSIDE] }).spawn,
	});
	writeProbeResult(dir, "agy", ok);
	assert.ok(loadApprovedProbes(dir).has("agy"));

	const dir2 = mkdtempSync(join(tmpdir(), "dv-agy-probe-"));
	const bad = await runAgyProbe({
		...base,
		turns: 1,
		spawn: createAgyMockSpawn({ chunks: ["ok"], usage: COLD }).spawn,
	});
	writeProbeResult(dir2, "agy", bad);
	assert.equal(loadApprovedProbes(dir2).has("agy"), false);
	assert.ok(existsSync(join(dir2, "agy.json")), "o artefato INCONCLUSIVE fica registrado");
	const written = JSON.parse(readFileSync(join(dir2, "agy.json"), "utf8")) as { status: string; mode: string };
	assert.equal(written.status, "INCONCLUSIVE");
	assert.equal(written.mode, "live");
});

test("prompt do probe: texto fixo sem ferramentas, igual ao probe de 2026-11-24", () => {
	assert.equal(AGY_PROBE_PROMPT, 'Responda somente com "ok". Não use ferramentas.');
});

test("teto de tokens do probe: com teto menor que o primeiro turno, o segundo não é enviado", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_OUTSIDE] });
	const result = await runAgyProbe({ ...base, turns: 2, maxTokens: 10000, spawn: mock.spawn });
	assert.equal(result.turns.length, 1, "o segundo turno não foi enviado");
	assert.equal(result.status, "INCONCLUSIVE");
	assert.ok(result.reasons.some((r) => /teto de tokens do probe atingido/.test(r)));
	assert.equal(mock.children[0]?.alive, false);
});

test("probe: troca de modelo sem confirmação -> INCONCLUSIVE com motivo, e a troca fica registrada", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usageSequence: [COLD, WARM_OUTSIDE], setModelReply: "empty" });
	const result = await runAgyProbe({ ...base, modelId: "gemini-3.8-flash-medium", turns: 2, spawn: mock.spawn });
	assert.deepEqual(result.model_switch, { requested: "gemini-3.8-flash-medium", status: "unconfirmed" });
	assert.equal(result.status, "INCONCLUSIVE");
	assert.ok(result.reasons.some((r) => /troca de modelo não confirmada/.test(r)));
});
