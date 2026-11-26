// Atividade de ferramentas do agy (tool_call / tool_call_update): cliente ACP, stream, ledger e updates malformados.
// Offline: servidor ACP em memória (agy_mock). Nenhuma chamada ao agy real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	AcpClient,
	agyModel,
	checkLedgerConformance,
	createAgyMockSpawn,
	createAgyStreamFn,
	executeRung,
	type SpawnFn,
} from "../src/index.ts";
import { observedAgyToolCalls } from "../src/providers/agy/stream.ts";
import { tempDir } from "./support.ts";

const MODEL = agyModel("gemini-3.8-flash-high");
const CONTEXT = {
	systemPrompt: "Você é um arquiteto.",
	messages: [{ role: "user" as const, content: "leia a.txt", timestamp: 0 }],
};
const USAGE = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 110 };

const toolCall = (id: string, extra: Record<string, unknown> = {}) => ({
	sessionUpdate: "tool_call",
	toolCallId: id,
	title: "read",
	kind: "read",
	status: "pending",
	rawInput: { path: "a.txt" },
	...extra,
});
const toolDone = (id: string, text: string) => ({
	sessionUpdate: "tool_call_update",
	toolCallId: id,
	status: "completed",
	content: [{ type: "content", content: { type: "text", text } }],
});

async function openClient(spawn: SpawnFn): Promise<AcpClient> {
	return AcpClient.open({ cwd: "/tmp", modelId: MODEL.id, timeoutMs: 2000, spawn });
}

type Event = { type: string; message?: { diagnostics?: unknown[] }; error?: { diagnostics?: unknown[] } };
async function collect(source: unknown): Promise<Event[]> {
	const stream = (await source) as AsyncIterable<Event>;
	const events: Event[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

// ---------- cliente ACP ----------

test("cliente: tool_call + tool_call_update completed viram AgyToolActivity com argumentos e saída", async () => {
	const mock = createAgyMockSpawn({
		chunks: ["pronto"],
		usage: USAGE,
		toolUpdates: [toolCall("t1"), toolDone("t1", "conteúdo de a.txt")],
	});
	const client = await openClient(mock.spawn);
	const result = await client.prompt("leia a.txt", {});
	await client.close();
	assert.deepEqual(result.toolActivity, [
		{
			toolCallId: "t1",
			toolName: "read",
			arguments: { path: "a.txt" },
			status: "completed",
			output: "conteúdo de a.txt",
		},
	]);
	assert.equal(result.malformedToolUpdates, 0);
	assert.equal(result.text, "pronto");
});

test("cliente: updates inesperados não interrompem o turno e são contados como malformados", async () => {
	const mock = createAgyMockSpawn({
		chunks: ["fim"],
		usage: USAGE,
		toolUpdates: [
			toolCall("t1"),
			{ sessionUpdate: "tool_call", title: "sem id" }, // U2: sem toolCallId
			{ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "weird", content: [] }, // U3: status inválido
			toolCall("t1"), // U4: declaração duplicada
			toolDone("orfao", "saída sem declaração"), // U5: órfão (sem tool_call anterior)
			toolCall("t2", { rawInput: "não é objeto" }), // U6: rawInput inválido
			{ sessionUpdate: "tipo_desconhecido_xyz", anything: 1 }, // U7: tipo desconhecido, ignorado
		],
	});
	const client = await openClient(mock.spawn);
	const result = await client.prompt("x", {});
	await client.close();
	assert.equal(result.stopReason, "end_turn");
	assert.equal(result.text, "fim");
	assert.equal(result.malformedToolUpdates, 5, "U2, U3, U4, U5 e U6");
	assert.deepEqual(
		result.toolActivity.map((t) => [t.toolCallId, t.toolName, t.status, t.output]),
		[
			["t1", "read", "pending", ""], // status inválido ignorado; t1 permanece pendente
			["orfao", "unknown", "completed", "saída sem declaração"],
			["t2", "read", "pending", ""],
		],
	);
	assert.deepEqual(result.toolActivity[2]?.arguments, {}, "rawInput inválido vira {}");
});

test("cliente: tool_call_update failed (erro da ferramenta) fica como failed com a mensagem", async () => {
	const mock = createAgyMockSpawn({
		chunks: ["ok"],
		usage: USAGE,
		toolUpdates: [
			toolCall("t9", { title: "terminal" }),
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "t9",
				status: "failed",
				content: [{ type: "content", content: { type: "text", text: "permissão negada" } }],
			},
		],
	});
	const client = await openClient(mock.spawn);
	const result = await client.prompt("x", {});
	await client.close();
	assert.equal(result.toolActivity[0]?.status, "failed");
	assert.equal(result.toolActivity[0]?.output, "permissão negada");
	assert.equal(result.toolActivity[0]?.toolName, "terminal");
});

test("cliente: snapshot de atividade é cópia (alterar o retorno não altera o cliente)", async () => {
	const mock = createAgyMockSpawn({ usage: USAGE, toolUpdates: [toolCall("t1")] });
	const client = await openClient(mock.spawn);
	await client.prompt("x", {});
	const snap = client.toolActivitySnapshot();
	(snap[0] as { status: string }).status = "failed";
	(snap[0]?.arguments as Record<string, unknown>).path = "outro";
	assert.equal(client.toolActivitySnapshot()[0]?.status, "pending");
	assert.deepEqual(client.toolActivitySnapshot()[0]?.arguments, { path: "a.txt" });
	await client.close();
});

// ---------- stream (StreamFn) ----------

test("stream: chamadas observadas vão para o diagnóstico agy_tool_activity da mensagem final", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: USAGE, toolUpdates: [toolCall("t1"), toolDone("t1", "x")] });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	const done = events.at(-1) as unknown as { type: string; message: { content: unknown[]; diagnostics?: unknown[] } };
	assert.equal(done.type, "done");
	const observed = observedAgyToolCalls(done.message as never);
	assert.equal(observed.length, 1);
	assert.equal(observed[0]?.tool_name, "read");
	assert.equal(observed[0]?.status, "completed");
	assert.equal(observed[0]?.output, "x");
	// Atividade observada não vira bloco de conteúdo executável: o agent-loop não a reexecuta.
	assert.ok(done.message.content.every((block) => (block as { type: string }).type !== "toolCall"));
});

test("stream: erro de transporte depois de tool_call preserva a atividade observada (pendente)", async () => {
	const mock = createAgyMockSpawn({
		usage: USAGE,
		toolUpdates: [toolCall("t5")],
		promptError: { code: -32000, message: "falha no meio do turno" },
	});
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const events = await collect(streamFn(MODEL, CONTEXT as never, {} as never));
	const last = events.at(-1) as unknown as { type: string; error: { stopReason: string; diagnostics?: unknown[] } };
	assert.equal(last.type, "error");
	const observed = observedAgyToolCalls(last.error as never);
	assert.equal(observed.length, 1);
	assert.equal(observed[0]?.tool_call_id, "t5");
	assert.equal(observed[0]?.status, "pending", "sem desfecho: fica pendente, não vira completed");
});

// ---------- ledger (executeRung) ----------

function readLedger(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RUN_BASE = {
	runId: "agy-tools",
	contractId: "p1-run-accounting-v5",
	harnessVariant: "dv-agy-tools-test",
	referenceProvenance: { harness: "dv-core" },
	datasetSha256: "e".repeat(64),
	taskDefinitionSha256: "f".repeat(64),
	model: MODEL,
	tools: [],
	prompt: "leia a.txt",
	priceBook: { kind: "subscription" as const, id: "agy-local", source: "login local do agy" },
	maxCostUsd: 1,
	doomLoopMaxIdenticalConsecutive: 3,
	approvedProbes: new Set(["agy"]),
} as const;

test("ledger: tool_call do agy vira declaração em call_finished e desfecho ok em tool_finished (sem reexecução)", async () => {
	const mock = createAgyMockSpawn({
		chunks: ["ok"],
		usage: USAGE,
		toolUpdates: [toolCall("t1"), toolDone("t1", "conteúdo de a.txt")],
	});
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ledgerPath = join(tempDir("agy-tools-ok"), "ledger.jsonl");
	await executeRung({ ...RUN_BASE, ledgerPath, streamFn } as never);
	const lines = readLedger(ledgerPath);
	const call = lines.find((l) => l.event === "call_finished") as { record: { tool_calls: { tool_call_id: string }[] } };
	assert.deepEqual(
		call.record.tool_calls.map((c) => c.tool_call_id),
		["t1"],
	);
	const finished = lines.find((l) => l.event === "tool_finished") as Record<string, unknown>;
	assert.equal(finished.tool_call_id, "t1");
	assert.equal(finished.status, "ok");
	assert.equal(finished.raw_output, "conteúdo de a.txt");
	const runFinished = lines.find((l) => l.event === "run_finished") as { calls_finished: number };
	assert.equal(runFinished.calls_finished, 1, "uma chamada ao modelo: nenhum turno extra por ferramenta");
	const report = checkLedgerConformance(ledgerPath);
	assert.deepEqual(
		report.violations.filter((v) => /tool/.test(v)),
		[],
		report.violations.join("; "),
	);
});

test("ledger: tool_call sem desfecho no fim do turno vira error com a causa explícita", async () => {
	const mock = createAgyMockSpawn({ chunks: ["ok"], usage: USAGE, toolUpdates: [toolCall("t3")] });
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ledgerPath = join(tempDir("agy-tools-pend"), "ledger.jsonl");
	await executeRung({ ...RUN_BASE, ledgerPath, streamFn } as never);
	const finished = readLedger(ledgerPath).find((l) => l.event === "tool_finished") as Record<string, unknown>;
	assert.equal(finished.status, "error");
	assert.match(String(finished.raw_output), /^\[agy\] desfecho indefinido: status 'pending'/);
	const report = checkLedgerConformance(ledgerPath);
	assert.deepEqual(
		report.violations.filter((v) => /tool/.test(v)),
		[],
		report.violations.join("; "),
	);
});

test("ledger: erro de transporte após tool_call grava a chamada observada e fecha o ledger", async () => {
	const mock = createAgyMockSpawn({
		usage: USAGE,
		toolUpdates: [toolCall("t7"), toolDone("t7", "parcial")],
		promptError: { code: -32000, message: "queda do agy" },
	});
	const streamFn = createAgyStreamFn({ cwd: "/tmp", timeoutMs: 2000, spawn: mock.spawn });
	const ledgerPath = join(tempDir("agy-tools-err"), "ledger.jsonl");
	await executeRung({ ...RUN_BASE, ledgerPath, streamFn } as never).catch(() => undefined);
	const lines = readLedger(ledgerPath);
	const finished = lines.find((l) => l.event === "tool_finished") as Record<string, unknown>;
	assert.equal(finished.tool_call_id, "t7");
	assert.equal(finished.status, "ok", "tool_call_update completed antes da falha permanece completed");
	assert.equal(finished.raw_output, "parcial");
	assert.ok(lines.some((l) => l.event === "run_finished"));
});
