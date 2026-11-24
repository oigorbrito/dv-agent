// Adaptador agy como StreamFn: eventos, erros (redigidos), usage incompleto, processo real e integração com executeRung.
// Offline: o mock em memória e o fixture de processo local. Nenhuma chamada ao agy real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	agyModel,
	buildCallTelemetry,
	checkLedgerConformance,
	createAgyMockSpawn,
	createAgyStreamFn,
	defaultSpawn,
	executeRung,
	mapStopReason,
	promptFromContext,
	type SpawnFn,
} from "../src/index.ts";
import { assertProviderCanRun } from "../src/ledger/capabilities.ts";
import { tempDir } from "./support.ts";

const PROBE_USAGE = {
	inputTokens: 13193,
	outputTokens: 118,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
};
const MODEL = agyModel("gemini-3.8-flash-high");
const CONTEXT = {
	systemPrompt: "Você é um arquiteto.",
	messages: [{ role: "user" as const, content: "responda ok", timestamp: 0 }],
};
const FIXTURE = resolve(import.meta.dirname, "fixtures/agy_stdio_server.mjs");

type Event = { type: string; reason?: string; message?: unknown; delta?: string; error?: unknown };

/** Consome o stream do StreamFn (que pode vir como promessa). */
async function collect(source: unknown): Promise<Event[]> {
	const stream = (await source) as AsyncIterable<Event>;
	const events: Event[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("stream: sucesso emite start, text_start, text_delta, text_end e done com o texto e o usage mapeado", async () => {
	const mock = createAgyMockSpawn({ chunks: ["o", "k"], usage: PROBE_USAGE });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	assert.deepEqual(
		events.map((e) => e.type),
		["start", "text_start", "text_delta", "text_end", "done"],
	);
	const done = events.at(-1)?.message as {
		content: { text: string }[];
		usage: { input: number; reasoning?: number };
		stopReason: string;
	};
	assert.equal(done.content[0]?.text, "ok");
	assert.equal(done.usage.input, 13193);
	assert.equal(done.usage.reasoning, 117);
	assert.equal(done.stopReason, "stop");
	assert.equal(mock.children[0]?.alive, false, "processo encerrado ao fim do turno");
});

test("stop reasons: end_turn e max_tokens mapeiam; cancelled vira aborted; refusal e desconhecido viram erro", () => {
	assert.equal(mapStopReason("end_turn").stopReason, "stop");
	assert.equal(mapStopReason("max_tokens").stopReason, "length");
	assert.equal(mapStopReason("cancelled").stopReason, "aborted");
	assert.equal(mapStopReason("refusal").stopReason, "error");
	const unknown = mapStopReason("algo_novo");
	assert.equal(unknown.stopReason, "error", "desconhecido nunca vira sucesso silencioso");
	assert.match(unknown.errorMessage ?? "", /desconhecido/);
});

test("contexto com ferramentas do harness é recusado explicitamente, sem abrir processo", async () => {
	const mock = createAgyMockSpawn();
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ctx = { ...CONTEXT, tools: [{ name: "write_file", description: "x", parameters: {} }] };
	const events = await collect(streamFn(MODEL, ctx as never, {} as never));
	const last = events.at(-1) as unknown as { type: string; error: { errorMessage: string } };
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /^agy não recebe as ferramentas do workspace/);
	assert.equal(mock.children.length, 0, "nenhum processo aberto");
});

test("erro de transporte (queda do agente) vira stopReason error com mensagem de transporte, sem processo vivo", async () => {
	const mock = createAgyMockSpawn({ mode: "crash_on_prompt" });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	const last = events.at(-1) as { type: string; error: { stopReason: string; errorMessage: string } };
	assert.equal(last.type, "error");
	assert.equal(last.error.stopReason, "error");
	assert.match(last.error.errorMessage, /^falha de transporte do agy:/);
	assert.equal(mock.children[0]?.alive, false);
});

test("segredo ecoado pelo agente em erro JSON-RPC é redigido antes de chegar ao ledger", async () => {
	const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
	const mock = createAgyMockSpawn({ promptError: { code: -32000, message: `chave recusada ${secret}` } });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	const last = events.at(-1) as { error: { errorMessage: string } };
	assert.ok(!last.error.errorMessage.includes(secret), "segredo não pode aparecer na mensagem");
	assert.match(last.error.errorMessage, /\[REDACTED\]/);
	assert.ok(last.error.errorMessage.length <= 400, "mensagem limitada");
});

test("usage incompleto: campo ausente vira diagnóstico usage_incomplete e telemetria INCONCLUSIVE, nunca MEASURED", async () => {
	const { cachedWriteTokens: _omitted, ...partial } = PROBE_USAGE;
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: partial });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	const done = events.at(-1)?.message as {
		diagnostics?: { type: string; details: { missing: string[] } }[];
		usage: never;
	};
	assert.equal(done.diagnostics?.[0]?.type, "usage_incomplete");
	assert.deepEqual(done.diagnostics?.[0]?.details.missing, ["cachedWriteTokens"]);
	const telemetry = buildCallTelemetry("agy", done as never, { kind: "subscription", id: "t", source: "t" });
	assert.equal(telemetry.telemetry_complete, false);
	assert.ok(telemetry.missing_buckets.includes("usage_incomplete"));
	assert.equal(telemetry.cost_accounting_status, "INCONCLUSIVE");
});

test("promptFromContext: sistema e mensagens viram texto; blocos não-texto são ignorados", () => {
	const text = promptFromContext({
		systemPrompt: "sistema",
		messages: [
			{ role: "user", content: "oi", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "tudo bem" },
					{ type: "toolCall", id: "x" },
				],
				timestamp: 0,
			} as never,
		],
	} as never);
	assert.equal(text, "[sistema]\nsistema\n\n[user]\noi\n\n[assistant]\ntudo bem");
});

test("processo real: servidor ACP em stdio responde, e o processo termina sem órfão", async () => {
	const pids: number[] = [];
	const spawn: SpawnFn = (command, args, cwd) => {
		const child = defaultSpawn(command, args, cwd);
		if (child.pid !== undefined) pids.push(child.pid);
		return child;
	};
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 10000, command: [process.execPath, FIXTURE], spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	const done = events.at(-1)?.message as { content: { text: string }[]; usage: { reasoning?: number } };
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(done.content[0]?.text, "ok");
	assert.equal(done.usage.reasoning, 117);
	assert.equal(pids.length, 1);
	const pid = pids[0] as number;
	// Processo sem órfão: kill(pid, 0) lança ESRCH quando o processo já terminou.
	await new Promise((r) => setTimeout(r, 200));
	assert.throws(
		() => process.kill(pid, 0),
		(error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
	);
});

test("processo real: queda do agente no meio do turno é erro de transporte", async () => {
	process.env.AGY_FIXTURE_MODE = "crash_on_prompt";
	try {
		const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 10000, command: [process.execPath, FIXTURE] });
		const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
		const last = events.at(-1) as unknown as { type: string; error: { errorMessage: string } };
		assert.equal(last.type, "error");
		assert.match(last.error.errorMessage, /agy encerrou|falha de transporte/);
	} finally {
		delete process.env.AGY_FIXTURE_MODE;
	}
});

test("executeRung: agy como degrau; usage e conformidade registrados; gate PROVISIONAL bloqueia sem probe", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: PROBE_USAGE });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ledgerPath = join(tempDir("agy-rung"), "ledger.jsonl");
	const run = (approved: ReadonlySet<string>, contractId = "p1-run-accounting-v5") =>
		executeRung({
			ledgerPath,
			runId: "agy-1",
			contractId,
			harnessVariant: "dv-agy-test",
			referenceProvenance: { harness: "dv-core" },
			datasetSha256: "e".repeat(64),
			taskDefinitionSha256: "f".repeat(64),
			model: MODEL,
			tools: [],
			prompt: "responda ok",
			streamFn,
			priceBook: { kind: "subscription", id: "agy-local", source: "login local do agy" },
			maxCostUsd: 1,
			doomLoopMaxIdenticalConsecutive: 3,
			approvedProbes: approved,
		});

	assert.throws(() => assertProviderCanRun("agy", new Set()), /PROVISIONAL/);
	await assert.rejects(run(new Set()), /PROVISIONAL/);

	const result = await run(new Set(["agy"]));
	assert.equal(result.status, "completed");
	const lines = readFileSync(ledgerPath, "utf8")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const started = lines.find((l) => l.event === "run_started") as { contract_id: string };
	assert.equal(started.contract_id, "p1-run-accounting-v5");
	const finished = lines.find((l) => l.event === "call_finished") as { record: { telemetry: Record<string, unknown> } };
	assert.equal(finished.record.telemetry.reasoning_tokens, 117);
	assert.equal(finished.record.telemetry.cache_read_tokens, 0);
	assert.equal(finished.record.telemetry.cache_write_tokens, 0);
	// v5 com cache zero e total = I + O: MEASURED, uncached = inputTokens.
	assert.equal(finished.record.telemetry.cost_accounting_status, "MEASURED");
	assert.equal(finished.record.telemetry.uncached_input_tokens, 13193);
	// Em assinatura o teto em USD é não verificável (regra c): o run fica INCONCLUSIVE, nunca FAIL.
	const report = checkLedgerConformance(ledgerPath);
	assert.notEqual(report.status, "FAIL", report.violations.join("; "));
	assert.equal(mock.children.length, 1, "um processo para a execução aprovada");
});

test("executeRung: agy sob contrato v4 é recusado antes de qualquer processo (sem regra v4 para o agy)", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: PROBE_USAGE });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ledgerPath = join(tempDir("agy-v4"), "ledger.jsonl");
	await assert.rejects(
		executeRung({
			ledgerPath,
			runId: "agy-v4",
			harnessVariant: "dv-agy-test",
			referenceProvenance: { harness: "dv-core" },
			datasetSha256: "e".repeat(64),
			taskDefinitionSha256: "f".repeat(64),
			model: MODEL,
			tools: [],
			prompt: "responda ok",
			streamFn,
			priceBook: { kind: "subscription", id: "agy-local", source: "login local do agy" },
			maxCostUsd: 1,
			doomLoopMaxIdenticalConsecutive: 3,
			approvedProbes: new Set(["agy"]),
		}),
		/agy exige contrato p1-run-accounting-v5/,
	);
	assert.equal(mock.children.length, 0);
});

test("executeRung sob v5: cache ativo no turno vira UNVERIFIABLE, com conformidade sem FAIL", async () => {
	const warmUsage = {
		inputTokens: 1193,
		outputTokens: 118,
		cachedReadTokens: 12000,
		cachedWriteTokens: 0,
		thoughtTokens: 117,
		totalTokens: 13311,
	};
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: warmUsage });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ledgerPath = join(tempDir("agy-warm"), "ledger.jsonl");
	await executeRung({
		ledgerPath,
		runId: "agy-warm",
		harnessVariant: "dv-agy-test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: MODEL,
		tools: [],
		prompt: "responda ok",
		streamFn,
		priceBook: { kind: "subscription", id: "agy-local", source: "login local do agy" },
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
		approvedProbes: new Set(["agy"]),
		contractId: "p1-run-accounting-v5",
	});
	const lines = readFileSync(ledgerPath, "utf8")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const finished = lines.find((l) => l.event === "call_finished") as { record: { telemetry: Record<string, unknown> } };
	assert.equal(finished.record.telemetry.cost_accounting_status, "UNVERIFIABLE");
	assert.equal(finished.record.telemetry.uncached_input_tokens, null);
	assert.ok((finished.record.telemetry.missing_buckets as string[]).includes("agy_cache_semantics_unverified"));
	const report = checkLedgerConformance(ledgerPath);
	assert.notEqual(report.status, "FAIL", report.violations.join("; "));
});

test("troca de modelo não confirmada: diagnóstico model_switch_unconfirmed e telemetria INCONCLUSIVE, nunca MEASURED", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: PROBE_USAGE, setModelReply: "empty" });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const medium = agyModel("gemini-3.8-flash-medium");
	const events = await collect(streamFn(medium, CONTEXT as never, {} as never));
	const done = events.at(-1)?.message as { diagnostics?: { type: string }[]; usage: never };
	assert.equal(events.at(-1)?.type, "done");
	assert.ok(done.diagnostics?.some((d) => d.type === "model_switch_unconfirmed"));
	const telemetry = buildCallTelemetry("agy", done as never, { kind: "subscription", id: "t", source: "t" });
	assert.ok(telemetry.missing_buckets.includes("model_switch_unconfirmed"));
	assert.equal(telemetry.cost_accounting_status, "INCONCLUSIVE");
});

test("troca com erro do agente: stopReason error com mensagem de troca (vira provider_error no executeRung)", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: PROBE_USAGE, setModelReply: "error" });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(agyModel("gemini-3.8-flash-medium"), CONTEXT as never, {} as never));
	const last = events.at(-1) as unknown as { type: string; error: { stopReason: string; errorMessage: string } };
	assert.equal(last.type, "error");
	assert.equal(last.error.stopReason, "error");
	assert.match(last.error.errorMessage, /troca para gemini-3.8-flash-medium falhou/);
	assert.equal(mock.children[0]?.alive, false);
});
