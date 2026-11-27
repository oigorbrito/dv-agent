import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { createPiRpcStreamFn, type ProcessLike, runPiRpcTurn, type SpawnFn } from "../src/index.ts";

interface FakeRpcHarness {
	spawn: SpawnFn;
	commands: Record<string, unknown>[];
}

function createFakePiRpc(
	behavior: (cmd: Record<string, unknown>, emit: (obj: Record<string, unknown>) => void) => void,
): FakeRpcHarness {
	const commands: Record<string, unknown>[] = [];
	const spawn: SpawnFn = () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const emitter = new EventEmitter();
		let exitCode: number | null = null;
		let buf = "";

		const emit = (obj: Record<string, unknown>): void => {
			if (!stdout.destroyed) stdout.write(`${JSON.stringify(obj)}\n`);
		};

		stdin.on("data", (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line !== "") {
					const cmd = JSON.parse(line) as Record<string, unknown>;
					commands.push(cmd);
					behavior(cmd, emit);
				}
				nl = buf.indexOf("\n");
			}
		});

		stdin.on("end", () => {
			if (exitCode === null) {
				exitCode = 0;
				emitter.emit("exit", 0, null);
			}
		});

		const proc: ProcessLike = {
			stdin,
			stdout,
			stderr,
			get exitCode() {
				return exitCode;
			},
			signalCode: null,
			kill() {
				if (exitCode === null) {
					exitCode = 143;
					emitter.emit("exit", 143, "SIGTERM");
				}
				return true;
			},
			once(event, listener) {
				emitter.once(event, listener);
				return proc;
			},
		};
		return proc;
	};
	return { spawn, commands };
}

test("pi-rpc: desativa auto-compaction, seleciona modelo, transmite deltas e lê session stats", async () => {
	const fake = createFakePiRpc((cmd, emit) => {
		if (cmd.type === "set_auto_compaction" || cmd.type === "set_model") {
			emit({ id: cmd.id, type: "response", command: cmd.type, success: true });
		} else if (cmd.type === "prompt") {
			emit({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
			emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Confirmar?" });
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Olá, " } });
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "mundo!" } });
			emit({ type: "agent_end" });
		} else if (cmd.type === "get_session_stats") {
			emit({
				id: cmd.id,
				type: "response",
				command: "get_session_stats",
				success: true,
				data: {
					tokens: { input: 120, output: 30, cacheRead: 10, cacheWrite: 5, total: 165 },
					cost: 0.0012,
				},
			});
		}
	});

	const deltas: string[] = [];
	const result = await runPiRpcTurn({
		cwd: process.cwd(),
		provider: "anthropic",
		modelId: "claude-sonnet-4-6",
		prompt: "diga olá",
		command: ["node", "fake-rpc.js", "--mode", "rpc"],
		spawn: fake.spawn,
		onTextDelta: (d) => deltas.push(d),
	});

	assert.equal(result.stopReason, "stop");
	assert.equal(result.text, "Olá, mundo!");
	assert.deepEqual(deltas, ["Olá, ", "mundo!"]);
	assert.equal(result.usage.input, 120);
	assert.equal(result.usage.output, 30);
	assert.equal(result.usage.totalTokens, 165);
	assert.equal(result.usage.costTotal, 0.0012);
	assert.equal(fake.commands[0]?.type, "set_auto_compaction");
	assert.equal(fake.commands[0]?.enabled, false);
	assert.equal(fake.commands[1]?.type, "set_model");
});

test("pi-rpc StreamFn: redige credenciais em erro de transporte e devolve stopReason=error", async () => {
	const fake = createFakePiRpc((cmd, emit) => {
		if (cmd.type === "set_auto_compaction") {
			emit({ id: cmd.id, type: "response", command: "set_auto_compaction", success: true });
		} else if (cmd.type === "set_model") {
			emit({
				id: cmd.id,
				type: "response",
				command: "set_model",
				success: false,
				error: "falha auth sk-ant-secret1234567890",
			});
		}
	});

	const streamFn = createPiRpcStreamFn({
		cwd: process.cwd(),
		command: ["node", "fake-rpc.js", "--mode", "rpc"],
		spawn: fake.spawn,
	});

	const model = {
		id: "claude-sonnet-4-6",
		name: "Sonnet",
		api: "pi-rpc",
		provider: "anthropic",
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<string>;

	const stream = streamFn(model, { messages: [{ role: "user", content: "oi", timestamp: Date.now() }] });
	const msg = await stream.result();
	assert.equal(msg.stopReason, "error");
	assert.doesNotMatch(msg.errorMessage ?? "", /sk-ant-secret1234567890/);
});
