// Servidor ACP em memória para testes offline do adaptador agy. Não é o agy: reproduz o protocolo observado no probe de
// 2026-11-24 (initialize, session/new, session/prompt, session/update) e os modos de falha que precisam ser cobertos.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ProcessLike, SpawnFn } from "../providers/agy/acp_client.ts";
import { AGY_MODELS } from "../providers/agy/stream.ts";

export type AgyMockMode =
	| "normal"
	| "hang_on_prompt"
	| "crash_on_prompt"
	| "crash_on_init"
	| "garbage_on_prompt"
	| "wrong_model";

export interface AgyMockOptions {
	mode?: AgyMockMode;
	currentModelId?: string;
	chunks?: readonly string[];
	/** Objeto usage do resultado. Omitido = resultado sem usage. */
	usage?: Record<string, unknown>;
	stopReason?: string;
	/** Erro JSON-RPC no lugar do resultado do session/prompt. */
	promptError?: { code: number; message: string };
	usageUpdates?: number;
	/** Usage por turno, na ordem dos session/prompt. Vence `usage` quando presente. */
	usageSequence?: readonly Record<string, unknown>[];
	/** protocolVersion devolvido no initialize (padrão 1). */
	protocolVersion?: unknown;
	/**
	 * Resposta a session/set_model. `unsupported` (padrão) responde -32601; `empty` aceita sem modelo; `echo` devolve o
	 * modelo pedido; `mismatch` devolve outro modelo; `error` responde erro JSON-RPC.
	 */
	setModelReply?: "unsupported" | "empty" | "echo" | "mismatch" | "error";
}

export class FakeAgyChild extends EventEmitter implements ProcessLike {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid: number;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly killSignals: string[] = [];
	private exited = false;

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killSignals.push(signal);
		if (this.exited) return false;
		setImmediate(() => this.finish(null, signal));
		return true;
	}

	/** Encerramento do processo (queda, saída normal ou kill). Idempotente. */
	finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.emit("exit", code, signal);
	}

	get alive(): boolean {
		return !this.exited;
	}
}

/** Spawn falso: cada chamada cria um processo com o servidor ACP mock ligado a ele. */
export function createAgyMockSpawn(options: AgyMockOptions = {}): {
	spawn: SpawnFn;
	children: FakeAgyChild[];
	initializeParams: Record<string, unknown>[];
} {
	const children: FakeAgyChild[] = [];
	const initializeParams: Record<string, unknown>[] = [];
	const spawn: SpawnFn = () => {
		const child = new FakeAgyChild(40000 + children.length);
		children.push(child);
		serve(child, options, initializeParams);
		return child;
	};
	return { spawn, children, initializeParams };
}

function serve(child: FakeAgyChild, options: AgyMockOptions, initializeParams: Record<string, unknown>[]): void {
	const mode = options.mode ?? "normal";
	const currentModelId = options.currentModelId ?? AGY_MODELS[0]?.modelId ?? "gemini-3.8-flash-high";
	const sessionId = "mock-session-1";
	let buffer = "";
	let promptIndex = 0;
	const send = (message: object) => child.stdout.write(`${JSON.stringify(message)}\n`);
	const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });

	const handle = (msg: { id?: unknown; method?: string; params?: unknown }) => {
		if (msg.method === undefined) return;
		switch (msg.method) {
			case "initialize":
				initializeParams.push((msg.params ?? {}) as Record<string, unknown>);
				if (mode === "crash_on_init") {
					child.finish(1, null);
					return;
				}
				reply(msg.id, {
					protocolVersion: options.protocolVersion ?? 1,
					agentCapabilities: {},
					agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
					authMethods: [],
				});
				return;
			case "session/new":
				reply(msg.id, {
					sessionId,
					models: {
						currentModelId: mode === "wrong_model" ? "gemini-3.8-flash-low" : currentModelId,
						availableModels: AGY_MODELS.map((m) => ({ modelId: m.modelId, name: m.name })),
					},
					modes: {},
					configOptions: [],
					_meta: {},
				});
				return;
			case "session/prompt":
				onPrompt(msg.id);
				return;
			case "session/cancel":
				return;
			case "session/set_model": {
				const requested = (msg.params as { modelId?: unknown } | undefined)?.modelId;
				switch (options.setModelReply ?? "unsupported") {
					case "empty":
						reply(msg.id, {});
						break;
					case "echo":
						reply(msg.id, { currentModelId: requested });
						break;
					case "mismatch":
						reply(msg.id, { currentModelId: "modelo-diferente" });
						break;
					case "error":
						send({
							jsonrpc: "2.0",
							id: msg.id,
							error: { code: -32000, message: "modelo indisponível para esta conta" },
						});
						break;
					default:
						send({
							jsonrpc: "2.0",
							id: msg.id,
							error: { code: -32601, message: "método desconhecido: session/set_model" },
						});
				}
				return;
			}
			default:
				send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `método desconhecido: ${msg.method}` } });
		}
	};

	const onPrompt = (id: unknown) => {
		if (mode === "hang_on_prompt") return;
		if (mode === "crash_on_prompt") {
			child.finish(1, null);
			return;
		}
		if (mode === "garbage_on_prompt") {
			child.stdout.write("isto não é json\n");
			return;
		}
		if (options.promptError !== undefined) {
			send({ jsonrpc: "2.0", id, error: options.promptError });
			return;
		}
		const usage =
			options.usageSequence === undefined
				? options.usage
				: (options.usageSequence[promptIndex] ?? options.usageSequence.at(-1));
		promptIndex += 1;
		for (let i = 0; i < (options.usageUpdates ?? 1); i += 1) {
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId, update: { sessionUpdate: "usage_update", used: 13311, size: 1000000 } },
			});
		}
		for (const text of options.chunks ?? []) {
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
			});
		}
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: { sessionId, update: { sessionUpdate: "session_info_update" } },
		});
		const result: Record<string, unknown> = { stopReason: options.stopReason ?? "end_turn" };
		if (usage !== undefined) result.usage = usage;
		reply(id, result);
	};

	child.stdin.setEncoding("utf8");
	child.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line !== "") handle(JSON.parse(line) as { id?: unknown; method?: string; params?: unknown });
			nl = buffer.indexOf("\n");
		}
	});
	// Fechar stdin encerra o agente, como no processo real.
	child.stdin.on("finish", () => setImmediate(() => child.finish(0, null)));
	child.stdin.on("end", () => setImmediate(() => child.finish(0, null)));
}
