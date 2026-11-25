// Protocolo ACP do agy: framing JSON-RPC, mapeamento de usage e cliente contra o servidor mock (offline, sem processo real).
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
	AcpClient,
	AGY_DEFAULT_COMMAND,
	createAgyMockSpawn,
	FakeAgyChild,
	JsonRpcConnection,
	JsonRpcError,
	mapAgyUsage,
	resolveAgyCommand,
	type SpawnFn,
	TransportError,
} from "../src/index.ts";

const PROBE_USAGE = {
	inputTokens: 13193,
	outputTokens: 118,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
};

// ---------- usage ----------

test("usage: payload completo do probe mapeia para os baldes; thoughtTokens é subconjunto de output", () => {
	const mapped = mapAgyUsage(PROBE_USAGE);
	assert.deepEqual(mapped.missing, []);
	assert.equal(mapped.usage.input, 13193);
	assert.equal(mapped.usage.output, 118);
	assert.equal(mapped.usage.cacheRead, 0);
	assert.equal(mapped.usage.cacheWrite, 0);
	assert.equal(mapped.usage.reasoning, 117);
	assert.equal(mapped.usage.totalTokens, 13311);
	assert.equal(mapped.usage.input + mapped.usage.output, mapped.usage.totalTokens);
});

test("usage: campo obrigatório ausente vira 0 e entra em missing (nunca medição implícita)", () => {
	const { cachedWriteTokens: _omitted, ...partial } = PROBE_USAGE;
	const mapped = mapAgyUsage(partial);
	assert.deepEqual(mapped.missing, ["cachedWriteTokens"]);
	assert.equal(mapped.usage.cacheWrite, 0);
	assert.equal(mapped.usage.reasoning, 117, "os demais campos continuam medidos");
});

test("usage: sem thoughtTokens, reasoning não é declarado (undefined, não 0)", () => {
	const { thoughtTokens: _omitted, ...partial } = PROBE_USAGE;
	const mapped = mapAgyUsage(partial);
	assert.deepEqual(mapped.missing, ["thoughtTokens"]);
	assert.equal(mapped.usage.reasoning, undefined);
});

test("usage: valores inválidos (negativo, fracionário, texto) e objeto ausente contam como ausentes", () => {
	const mapped = mapAgyUsage({ inputTokens: -1, outputTokens: 1.5, cachedReadTokens: "3" });
	assert.equal(mapped.missing.length, 6);
	assert.deepEqual(mapAgyUsage(undefined).missing.length, 6);
	assert.deepEqual(mapAgyUsage(null).missing.length, 6);
});

// ---------- JSON-RPC ----------

test("jsonrpc: requisição de método não implementado pelo cliente recebe -32601 com o mesmo id", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	output.setEncoding("utf8");
	const conn = new JsonRpcConnection(input, output);
	void conn;
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: {} })}\n`);
	const line = await new Promise<string>((resolve) => output.once("data", (chunk: string) => resolve(chunk)));
	const reply = JSON.parse(line.trim()) as { id: number; error: { code: number } };
	assert.equal(reply.id, 7);
	assert.equal(reply.error.code, -32601);
});

test("jsonrpc: quadro que não é JSON derruba a conexão e rejeita as pendências", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const conn = new JsonRpcConnection(input, output);
	const pending = conn.request("initialize", {}, { timeoutMs: 1000 });
	input.write("lixo não json\n");
	await assert.rejects(pending, (error: unknown) => error instanceof TransportError && error.kind === "protocol");
});

test("jsonrpc: erro de resposta vira JsonRpcError com código e mensagem", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	output.setEncoding("utf8");
	const conn = new JsonRpcConnection(input, output);
	const pending = conn.request("session/prompt", {}, { timeoutMs: 1000 });
	const sent = JSON.parse((await new Promise<string>((r) => output.once("data", (c: string) => r(c)))).trim()) as {
		id: number;
	};
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent.id, error: { code: -32000, message: "bad request" } })}\n`);
	await assert.rejects(pending, (error: unknown) => error instanceof JsonRpcError && error.code === -32000);
});

// ---------- cliente contra o mock ----------

test("resolução do executável: DV_AGY_BIN substitui o binário mantendo os argumentos ACP", () => {
	assert.deepEqual(
		resolveAgyCommand(AGY_DEFAULT_COMMAND, { DV_AGY_BIN: "/mnt/c/Users/test/AppData/agy.exe" }, "linux"),
		["/mnt/c/Users/test/AppData/agy.exe", "acp", "--stdio", "--disable-telemetry"],
	);
});

test("spawn ENOENT é convertido em erro estruturado sem evento error não tratado", async () => {
	const child = new FakeAgyChild(0);
	const spawn: SpawnFn = () => {
		queueMicrotask(() => {
			const error = Object.assign(new Error("not found"), {
				code: "ENOENT",
				syscall: "spawn agy",
				path: "agy.exe",
			});
			child.emit("error", error);
		});
		return child;
	};
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: "gemini-3.8-flash-high", timeoutMs: 1000, spawn }),
		(error: unknown) =>
			error instanceof TransportError &&
			error.kind === "spawn" &&
			error.code === "ENOENT" &&
			error.syscall === "spawn agy" &&
			error.executable === "agy.exe",
	);
	assert.deepEqual(child.killSignals, [], "falha antes de criar o processo não aciona encerramento por timeout");
});

function recordingSpawn(inner: SpawnFn): { spawn: SpawnFn; commands: string[][] } {
	const commands: string[][] = [];
	const spawn: SpawnFn = (command, args, cwd) => {
		commands.push([command, ...args]);
		return inner(command, args, cwd);
	};
	return { spawn, commands };
}

test("cliente: handshake e turno com chunks de texto, usage e contagem de usage_update", async () => {
	const mock = createAgyMockSpawn({
		chunks: ["o", "k"],
		usage: PROBE_USAGE,
		usageUpdates: 2,
	});
	const { spawn, commands } = recordingSpawn(mock.spawn);
	const client = await AcpClient.open({ cwd: "/tmp", modelId: "gemini-3.8-flash-high", timeoutMs: 2000, spawn });
	const result = await client.prompt("responda ok", {});
	assert.equal(result.text, "ok");
	assert.equal(result.stopReason, "end_turn");
	assert.deepEqual(result.usage, PROBE_USAGE);
	assert.equal(result.usageUpdates, 2);
	assert.ok(result.updateTypes.includes("agent_message_chunk"));
	assert.deepEqual(mock.initializeParams[0]?.clientCapabilities, {
		fs: { readTextFile: true, writeTextFile: true },
		terminal: true,
	});
	await client.close();
	assert.equal(commands[0]?.length, AGY_DEFAULT_COMMAND.length);
	assert.ok(
		commands[0]?.[0] === AGY_DEFAULT_COMMAND[0] || commands[0]?.[0]?.endsWith("agy.exe"),
		`executável inesperado: ${commands[0]?.[0]}`,
	);
	assert.deepEqual(commands[0]?.slice(1), AGY_DEFAULT_COMMAND.slice(1));
	assert.equal(mock.children[0]?.alive, false, "processo encerrado ao fechar");
});

test("cliente: modelo diferente do que a sessão abriu é recusado e o processo é encerrado (sem órfão)", async () => {
	const mock = createAgyMockSpawn({ mode: "wrong_model" });
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: "gemini-3.8-flash-high", timeoutMs: 2000, spawn: mock.spawn }),
		(error: unknown) =>
			error instanceof TransportError && /troca para gemini-3.8-flash-high falhou/.test(error.message),
	);
	assert.equal(mock.children[0]?.alive, false);
});

test("cliente: queda do agente no meio do turno é TransportError closed", async () => {
	const mock = createAgyMockSpawn({ mode: "crash_on_prompt" });
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 2000,
		spawn: mock.spawn,
	});
	await assert.rejects(
		client.prompt("x", {}),
		(error: unknown) => error instanceof TransportError && error.kind === "closed",
	);
	await client.close();
	assert.equal(mock.children[0]?.alive, false);
});

test("cliente: falha de inicialização (agente cai no initialize) não deixa processo vivo", async () => {
	const mock = createAgyMockSpawn({ mode: "crash_on_init" });
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: "gemini-3.8-flash-high", timeoutMs: 2000, spawn: mock.spawn }),
	);
	assert.equal(mock.children[0]?.alive, false);
});

test("cliente: sem resposta dentro do timeout vira TransportError timeout, e o close mata o processo", async () => {
	const mock = createAgyMockSpawn({ mode: "hang_on_prompt" });
	// Mesmo prazo para open e prompt: prazo curto deixa o handshake rápido e o prompt estourar cedo.
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 300,
		spawn: mock.spawn,
	});
	const started = Date.now();
	await assert.rejects(
		client.prompt("x", {}),
		(error: unknown) =>
			error instanceof TransportError && error.kind === "timeout" && error.message.includes("session/prompt"),
	);
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 250 && elapsed < 1500, `timeout cumpre o prazo (${elapsed} ms)`);
	await client.close();
	assert.equal(mock.children[0]?.alive, false);
});

test("cliente: cancelamento por AbortSignal rejeita com aborted e não deixa processo vivo", async () => {
	const mock = createAgyMockSpawn({ mode: "hang_on_prompt" });
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 5000,
		spawn: mock.spawn,
	});
	const controller = new AbortController();
	const pending = client.prompt("x", { signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(pending, (error: unknown) => error instanceof TransportError && error.kind === "aborted");
	await client.close();
	assert.equal(mock.children[0]?.alive, false);
});

test("cliente: erro JSON-RPC do agente chega como JsonRpcError (o redator fica no adaptador)", async () => {
	const mock = createAgyMockSpawn({
		promptError: { code: -32000, message: "chave inválida sk-ant-api03-ABCDEFGHIJKLMNOP" },
	});
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 2000,
		spawn: mock.spawn,
	});
	await assert.rejects(
		client.prompt("x", {}),
		(error: unknown) => error instanceof JsonRpcError && error.code === -32000,
	);
	await client.close();
});

test("cliente: quadro inválido no meio do turno é protocolo, não resposta", async () => {
	const mock = createAgyMockSpawn({ mode: "garbage_on_prompt" });
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 2000,
		spawn: mock.spawn,
	});
	await assert.rejects(
		client.prompt("x", {}),
		(error: unknown) => error instanceof TransportError && error.kind === "protocol",
	);
	await client.close();
});

test("cliente: close é idempotente", async () => {
	const mock = createAgyMockSpawn();
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 2000,
		spawn: mock.spawn,
	});
	await client.close();
	await client.close();
	assert.equal(mock.children[0]?.alive, false);
});

// ---------- troca de modelo (session/set_model) ----------

const OTHER = "gemini-3.8-flash-medium";

test("troca: modelo pedido diferente do padrão, sem suporte do agente -> erro de troca e processo encerrado", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "unsupported" });
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: OTHER, timeoutMs: 2000, spawn: mock.spawn }),
		(error: unknown) =>
			error instanceof TransportError && /troca para gemini-3.8-flash-medium falhou/.test(error.message),
	);
	assert.equal(mock.children[0]?.alive, false);
});

test("troca: agente devolve o modelo pedido -> confirmed", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "echo" });
	const client = await AcpClient.open({ cwd: "/tmp", modelId: OTHER, timeoutMs: 2000, spawn: mock.spawn });
	assert.deepEqual(client.modelSwitch, { requested: OTHER, status: "confirmed" });
	await client.close();
});

test("troca: resposta sem modelo -> unconfirmed (aceita, mas não confirmada)", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "empty" });
	const client = await AcpClient.open({ cwd: "/tmp", modelId: OTHER, timeoutMs: 2000, spawn: mock.spawn });
	assert.deepEqual(client.modelSwitch, { requested: OTHER, status: "unconfirmed" });
	await client.close();
});

test("troca: agente devolve outro modelo -> erro de protocolo", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "mismatch" });
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: OTHER, timeoutMs: 2000, spawn: mock.spawn }),
		(error: unknown) =>
			error instanceof TransportError && /troca reportou modelo-diferente, esperado/.test(error.message),
	);
	assert.equal(mock.children[0]?.alive, false);
});

test("troca: erro JSON-RPC do agente -> erro de troca com mensagem redigida", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "error" });
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: OTHER, timeoutMs: 2000, spawn: mock.spawn }),
		(error: unknown) =>
			error instanceof TransportError &&
			/troca para gemini-3.8-flash-medium falhou: .*indisponível/.test(error.message),
	);
});

test("troca: modelo fora da lista anunciada -> recusado sem tentar a troca", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "echo" });
	await assert.rejects(
		AcpClient.open({ cwd: "/tmp", modelId: "modelo-inexistente", timeoutMs: 2000, spawn: mock.spawn }),
		(error: unknown) => error instanceof TransportError && /não anunciado pelo agy/.test(error.message),
	);
});

test("troca: sem troca pedida (modelo igual ao padrão), não há set_model e modelSwitch é null", async () => {
	const mock = createAgyMockSpawn({ setModelReply: "unsupported" });
	const client = await AcpClient.open({
		cwd: "/tmp",
		modelId: "gemini-3.8-flash-high",
		timeoutMs: 2000,
		spawn: mock.spawn,
	});
	assert.equal(client.modelSwitch, null);
	await client.close();
});
