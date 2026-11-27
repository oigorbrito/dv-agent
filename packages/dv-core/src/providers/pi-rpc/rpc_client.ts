// Cliente RPC sobre stdio para `@earendil-works/pi-coding-agent --mode rpc`.
// Dono do ciclo de vida do subprocesso: spawn, configuração inicial, turno, stats e encerramento.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { defaultSpawn, type ProcessLike, type SpawnFn, sanitizeTransportMessage } from "../agy/acp_client.ts";

export const PI_RPC_RELEASE_VERSION = "1.7.0";
const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const EXIT_GRACE_MS = 1_500;

export function defaultPiRpcEntry(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.DV_PI_RPC_ENTRY?.trim();
	if (explicit !== undefined && explicit !== "") return explicit;
	return join(
		homedir(),
		".pi",
		"agent",
		"install",
		"releases",
		PI_RPC_RELEASE_VERSION,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"rpc-entry.js",
	);
}

export function resolvePiRpcCommand(
	command?: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
	if (command !== undefined && command.length > 0) return command;
	const entry = defaultPiRpcEntry(env);
	if (!existsSync(entry)) {
		throw new Error(`pi-coding-agent rpc-entry não encontrado em: ${entry}`);
	}
	return [process.execPath, entry, "--mode", "rpc"];
}

export interface PiRpcUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

export interface PiRpcTurnOptions {
	cwd: string;
	provider: string;
	modelId: string;
	prompt: string;
	thinkingLevel?: string;
	timeoutMs?: number;
	command?: readonly string[];
	spawn?: SpawnFn;
	signal?: AbortSignal;
	onTextDelta?: (delta: string) => void;
}

export interface PiRpcTurnResult {
	text: string;
	stopReason: "stop" | "length" | "aborted" | "error";
	errorMessage?: string;
	usage: PiRpcUsage;
}

function emptyUsage(): PiRpcUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsage(raw: unknown): PiRpcUsage {
	if (raw === null || typeof raw !== "object") return emptyUsage();
	const u = raw as Record<string, unknown>;
	const cost = u.cost !== null && typeof u.cost === "object" ? (u.cost as Record<string, unknown>) : undefined;
	const input = num(u.input);
	const output = num(u.output);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	const totalTokens = num(u.totalTokens) || num(u.total) || input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, totalTokens, costTotal: num(cost?.total) };
}

function killProcessTree(child: ProcessLike): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (child.pid !== undefined && process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	try {
		child.kill("SIGTERM");
	} catch {
		// Ignora processo já encerrado.
	}
}

export class PiRpcClient {
	private readonly child: ProcessLike;
	private readonly pending = new Map<
		string,
		{ resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }
	>();
	private nextId = 1;
	private closed = false;
	private fatalError: Error | undefined;
	private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;

	constructor(child: ProcessLike, onEvent?: (event: Record<string, unknown>) => void) {
		this.child = child;
		this.onEvent = onEvent;
		const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("line", (line) => this.handleLine(line));
		child.once("error", (err) => {
			this.failAll(new Error(`falha no processo pi-rpc: ${sanitizeTransportMessage(err.message)}`));
		});
		child.once("exit", (code, signal) => {
			this.closed = true;
			this.failAll(new Error(`pi-rpc encerrou inesperadamente (code=${String(code)}, signal=${String(signal)})`));
		});
	}

	private failAll(error: Error): void {
		if (this.fatalError === undefined) this.fatalError = error;
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			entry.reject(error);
		}
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return;
		}
		if (msg.type === "response" && typeof msg.id === "string") {
			const waiter = this.pending.get(msg.id);
			if (waiter !== undefined) {
				this.pending.delete(msg.id);
				if (msg.success === false) {
					const errText = typeof msg.error === "string" ? msg.error : "erro desconhecido no pi-rpc";
					waiter.reject(new Error(sanitizeTransportMessage(errText)));
				} else {
					waiter.resolve(msg);
				}
			}
			return;
		}
		if (msg.type === "extension_ui_request" && typeof msg.id === "string") {
			this.sendRaw({ type: "extension_ui_response", id: msg.id, cancelled: true });
			return;
		}
		this.onEvent?.(msg);
	}

	private sendRaw(payload: Record<string, unknown>): void {
		if (this.closed || this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	sendCommand(command: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
		if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
		const id = `dv-rpc-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout aguardando resposta RPC para ${String(command.type)}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (val) => {
					clearTimeout(timer);
					resolve(val);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			this.sendRaw({ ...command, id });
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			this.child.stdin.end();
		} catch {
			// Ignora stdin já fechado.
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				killProcessTree(this.child);
				resolve();
			}, EXIT_GRACE_MS);
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

export async function runPiRpcTurn(options: PiRpcTurnOptions): Promise<PiRpcTurnResult> {
	const cmd = resolvePiRpcCommand(options.command);
	const [bin, ...args] = cmd;
	if (bin === undefined) throw new Error("comando pi-rpc vazio");
	const spawnFn = options.spawn ?? defaultSpawn;
	const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

	let text = "";
	let lastUsage = emptyUsage();
	let agentDoneResolve: (() => void) | undefined;
	let agentDoneReject: ((err: Error) => void) | undefined;
	const agentDone = new Promise<void>((resolve, reject) => {
		agentDoneResolve = resolve;
		agentDoneReject = reject;
	});

	const child = spawnFn(bin, args, options.cwd);
	const client = new PiRpcClient(child, (event) => {
		const type = event.type;
		if (type === "message_update") {
			const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (delta?.type === "text_delta" && typeof delta.delta === "string") {
				text += delta.delta;
				options.onTextDelta?.(delta.delta);
			}
		} else if (type === "message_end") {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant") {
				if (msg.usage !== undefined) lastUsage = parseUsage(msg.usage);
				if (text === "" && Array.isArray(msg.content)) {
					text = msg.content
						.filter(
							(b): b is { type: "text"; text: string } =>
								b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text",
						)
						.map((b) => b.text)
						.join("");
				}
			}
		} else if (type === "agent_end") {
			agentDoneResolve?.();
		}
	});

	const onAbort = (): void => {
		void client.sendCommand({ type: "abort" }, 2_000).catch(() => {});
		agentDoneReject?.(new Error("turno pi-rpc abortado"));
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const turnTimer = setTimeout(() => {
		agentDoneReject?.(new Error(`timeout de ${timeoutMs} ms no turno pi-rpc`));
	}, timeoutMs);

	try {
		await client.sendCommand({ type: "set_auto_compaction", enabled: false });
		await client.sendCommand({ type: "set_model", provider: options.provider, modelId: options.modelId });
		if (options.thinkingLevel !== undefined) {
			await client.sendCommand({ type: "set_thinking_level", level: options.thinkingLevel });
		}
		await client.sendCommand({ type: "prompt", message: options.prompt });
		await agentDone;

		const statsResp = await client.sendCommand({ type: "get_session_stats" }).catch(() => undefined);
		const statsData = statsResp?.data as Record<string, unknown> | undefined;
		if (statsData?.tokens !== undefined) {
			lastUsage = parseUsage({ ...(statsData.tokens as Record<string, unknown>), cost: { total: statsData.cost } });
		}

		return { text, stopReason: "stop", usage: lastUsage };
	} catch (error) {
		const msg = sanitizeTransportMessage((error as Error).message);
		if (options.signal?.aborted) {
			return { text, stopReason: "aborted", errorMessage: msg, usage: lastUsage };
		}
		return { text, stopReason: "error", errorMessage: msg, usage: lastUsage };
	} finally {
		clearTimeout(turnTimer);
		options.signal?.removeEventListener("abort", onAbort);
		await client.close();
	}
}
