// Cliente ACP sobre stdio para `agy acp --stdio`. Dono do ciclo de vida do processo: spawn, handshake, turno, encerramento.
//
// Schema observado em docs/research/acp-probe-2026-11-24.json (agente "Antigravity ACP Server" 1.5.15):
//   initialize(params: protocolVersion, clientCapabilities, clientInfo)
//   session/new(params: cwd, mcpServers) -> sessionId, models{currentModelId, availableModels}
//   session/prompt(params: sessionId, prompt) -> stopReason, usage{inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens}
//   session/update (notificação) com sessionUpdate em {agent_message_chunk, usage_update, session_info_update, available_commands_update}
// NÃO observado pelo probe (assumido, a confirmar em probe live): o valor de protocolVersion, o formato do prompt
// (aqui: lista de blocos de texto, conforme o ACP) e a troca de modelo (não suportada aqui: falha explícita).
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { redactText } from "../../ledger/redact.ts";
import { registerAcpWorkspaceHandlers } from "./acp_workspace.ts";
import { JsonRpcConnection, JsonRpcError, TransportError } from "./jsonrpc.ts";

export const AGY_DEFAULT_COMMAND: readonly string[] = ["agy", "acp", "--stdio", "--disable-telemetry"];
/** Versão do protocolo enviada no initialize. Assumida (ACP usa inteiro); não capturada pelo probe. */
export const ACP_PROTOCOL_VERSION = 1;
const MAX_MESSAGE_CHARS = 300;
const EXIT_GRACE_MS = 2000;

/** Resolve o executável configurado e, em Linux/WSL, procura as extensões de interoperabilidade no PATH. */
export function resolveAgyCommand(
	command: readonly string[] = AGY_DEFAULT_COMMAND,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): readonly string[] {
	const [requested, ...args] = command;
	if (requested === undefined) return command;
	const explicit = env.DV_AGY_BIN?.trim();
	if (explicit !== undefined && explicit !== "" && requested === AGY_DEFAULT_COMMAND[0]) return [explicit, ...args];
	if (requested !== "agy" || platform !== "linux") return command;
	for (const name of ["agy", "agy.exe", "agy.cmd"]) {
		for (const directory of (env.PATH ?? "").split(delimiter)) {
			const candidate = join(directory || ".", name);
			try {
				accessSync(candidate, constants.X_OK);
				return [candidate, ...args];
			} catch {
				// Tenta o próximo nome/diretório do PATH.
			}
		}
	}
	// Deixa o spawn produzir ENOENT estruturado caso nenhum candidato exista.
	return command;
}

/** Subconjunto do processo filho usado pelo cliente. ChildProcess real e o fake de teste satisfazem. */
export interface ProcessLike {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly pid?: number;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export type SpawnFn = (command: string, args: readonly string[], cwd: string) => ProcessLike;

export const defaultSpawn: SpawnFn = (command, args, cwd) =>
	nodeSpawn(command, [...args], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	}) as unknown as ChildProcess & ProcessLike;

/** Mensagem de falha segura para registro: sem segredos conhecidos, sem quebras de linha, com limite de tamanho. */
export function sanitizeTransportMessage(text: string): string {
	const redacted = redactText(text).replace(/\s+/g, " ").trim();
	return redacted.length > MAX_MESSAGE_CHARS ? `${redacted.slice(0, MAX_MESSAGE_CHARS)}…` : redacted;
}

export type AgyToolStatus = "pending" | "in_progress" | "completed" | "failed";

const AGY_TOOL_STATUSES: readonly string[] = ["pending", "in_progress", "completed", "failed"];

/** Nome legível da ferramenta: title, depois kind, depois "unknown". */
function nameOf(update: Record<string, unknown>): string {
	if (typeof update.title === "string" && update.title !== "") return update.title;
	if (typeof update.kind === "string" && update.kind !== "") return update.kind;
	return "unknown";
}

/** Texto de saída: rawOutput (string) ou blocos {type:"content",content:{type:"text"}} concatenados. */
function outputOf(update: Record<string, unknown>): string {
	if (typeof update.rawOutput === "string") return update.rawOutput;
	if (!Array.isArray(update.content)) return "";
	return update.content
		.map((item) => {
			const block = item as { type?: unknown; content?: { type?: unknown; text?: unknown } } | null;
			const text = block?.content;
			return block?.type === "content" && text?.type === "text" && typeof text.text === "string" ? text.text : "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

/** Chamada de ferramenta executada pelo próprio agy, observada por session/update (tool_call / tool_call_update). */
export interface AgyToolActivity {
	toolCallId: string;
	toolName: string;
	/** rawInput do tool_call (objeto); {} quando ausente ou inválido. */
	arguments: Record<string, unknown>;
	status: AgyToolStatus;
	/** Saída textual acumulada (rawOutput ou blocos de texto em content). */
	output: string;
}

export interface AcpPromptResult {
	text: string;
	stopReason: string;
	/** Objeto `usage` cru do session/prompt (validado por usage.ts). */
	usage: unknown;
	usageUpdates: number;
	updateTypes: string[];
	/** Chamadas de ferramenta observadas no turno, na ordem da primeira aparição. */
	toolActivity: AgyToolActivity[];
	/** Updates de ferramenta sem id, duplicados, com status inválido ou órfãos. Não interrompem o turno. */
	malformedToolUpdates: number;
}

/** O que o agente anunciou no initialize (sem texto livre). */
export interface AcpHandshake {
	/** protocolVersion devolvido pelo agente; null se ausente ou não numérico. */
	protocolVersion: number | null;
	agentName: string | null;
	authMethods: number;
}

/** Modelos anunciados em session/new. */
export interface AcpModels {
	currentModelId: string | null;
	availableModelIds: string[];
}

/** Resultado de sondar session/set_model sem enviar prompt (não consome tokens). */
export interface AcpSetModelProbe {
	/** `supported` = o agente aceitou; `unsupported` = erro JSON-RPC (ex.: método inexistente); `transport` = falha de transporte. */
	status: "supported" | "unsupported" | "transport";
	code?: number;
	message?: string;
}

export interface AcpModelSwitch {
	requested: string;
	status: "confirmed" | "unconfirmed";
}

export interface AcpOpenOptions {
	command?: readonly string[];
	spawn?: SpawnFn;
	cwd: string;
	modelId: string;
	timeoutMs: number;
}

export class AcpClient {
	private readonly proc: ProcessLike;
	private readonly conn: JsonRpcConnection;
	private readonly timeoutMs: number;
	private readonly stderrChunks: string[] = [];
	private sessionId = "";
	private chunks: string[] = [];
	private updateTypes: string[] = [];
	private usageUpdates = 0;
	private tools = new Map<string, AgyToolActivity>();
	private malformedToolUpdates = 0;
	private closed = false;
	private processError: TransportError | undefined;
	private handshakeInfo: AcpHandshake = { protocolVersion: null, agentName: null, authMethods: 0 };
	private modelInfo: AcpModels = { currentModelId: null, availableModelIds: [] };
	private switchInfo: AcpModelSwitch | null = null;
	private workspaceHandlers: { close(): Promise<void> } | undefined;

	private constructor(proc: ProcessLike, timeoutMs: number) {
		this.proc = proc;
		this.timeoutMs = timeoutMs;
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			this.stderrChunks.push(chunk);
			// Só a cauda interessa para diagnóstico; limita a memória.
			if (this.stderrChunks.length > 64) this.stderrChunks.splice(0, this.stderrChunks.length - 64);
		});
		this.conn = new JsonRpcConnection(proc.stdout, proc.stdin);
		this.conn.on("session/update", (params) => this.onUpdate(params));
		proc.once("error", (error) => {
			const code = typeof error.code === "string" ? error.code : undefined;
			const syscall = typeof error.syscall === "string" ? error.syscall : undefined;
			const executable = typeof error.path === "string" ? error.path : undefined;
			this.processError = new TransportError(
				"spawn",
				`não foi possível iniciar ${executable ?? "agy"}${code === undefined ? "" : ` (${code})`}`,
				{ code, syscall, executable },
			);
			this.conn.failAll(this.processError);
		});
		proc.once("exit", (code, signal) => {
			this.conn.failAll(
				new TransportError("closed", `agy encerrou (código ${code ?? "null"}, sinal ${signal ?? "null"})`),
			);
		});
	}

	/** Abre o processo, faz o handshake e cria a sessão. Em qualquer falha, o processo é encerrado antes de lançar. */
	static async open(options: AcpOpenOptions): Promise<AcpClient> {
		const [command, ...args] = options.command ?? resolveAgyCommand();
		if (command === undefined) throw new TransportError("protocol", "comando do agy vazio");
		const proc = (options.spawn ?? defaultSpawn)(command, args, options.cwd);
		const client = new AcpClient(proc, options.timeoutMs);
		try {
			const init = (await client.conn.request(
				"initialize",
				{
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
					clientInfo: { name: "dv-agent", version: "0.1.0" },
				},
				{ timeoutMs: options.timeoutMs },
			)) as { protocolVersion?: unknown; agentInfo?: { name?: unknown }; authMethods?: unknown } | null;
			client.handshakeInfo = {
				protocolVersion: typeof init?.protocolVersion === "number" ? init.protocolVersion : null,
				agentName: typeof init?.agentInfo?.name === "string" ? init.agentInfo.name : null,
				authMethods: Array.isArray(init?.authMethods) ? init.authMethods.length : 0,
			};
			const created = (await client.conn.request(
				"session/new",
				{ cwd: options.cwd, mcpServers: [] },
				{ timeoutMs: options.timeoutMs },
			)) as { sessionId?: unknown; models?: { currentModelId?: unknown } } | null;
			const sessionId = created?.sessionId;
			const currentModelId = created?.models?.currentModelId;
			if (typeof sessionId !== "string" || sessionId === "") {
				throw new TransportError("protocol", "session/new sem sessionId");
			}
			client.sessionId = sessionId;
			client.workspaceHandlers = registerAcpWorkspaceHandlers(client.conn, options.cwd, sessionId);
			const available = (created?.models as { availableModels?: unknown } | undefined)?.availableModels;
			client.modelInfo = {
				currentModelId: typeof currentModelId === "string" ? currentModelId : null,
				availableModelIds: Array.isArray(available)
					? available
							.map((m) => (m as { modelId?: unknown }).modelId)
							.filter((id): id is string => typeof id === "string")
					: [],
			};
			if (currentModelId !== options.modelId) {
				// Modelo pedido diferente do padrão da sessão: só troca se o agente anunciou o modelo.
				if (!client.modelInfo.availableModelIds.includes(options.modelId)) {
					throw new TransportError(
						"protocol",
						`modelo ${options.modelId} não anunciado pelo agy (disponíveis: ${client.modelInfo.availableModelIds.join(", ")})`,
					);
				}
				await client.switchModel(options.modelId);
			}
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	}

	get handshake(): AcpHandshake {
		return { ...this.handshakeInfo };
	}

	get models(): AcpModels {
		return { currentModelId: this.modelInfo.currentModelId, availableModelIds: [...this.modelInfo.availableModelIds] };
	}

	/** Troca de modelo feita na abertura: `confirmed` se o agente devolveu o modelo, `unconfirmed` se a resposta veio sem ele. */
	get modelSwitch(): AcpModelSwitch | null {
		return this.switchInfo === null ? null : { ...this.switchInfo };
	}

	/**
	 * session/set_model. Erro de troca é TransportError (vira provider_error no adaptador). Resposta com modelo diferente
	 * do pedido também é erro. Resposta sem modelo é aceita, mas fica `unconfirmed`: não se sabe se a troca aconteceu.
	 */
	private async switchModel(modelId: string): Promise<void> {
		let result: unknown;
		try {
			result = await this.conn.request(
				"session/set_model",
				{ sessionId: this.sessionId, modelId },
				{ timeoutMs: this.timeoutMs },
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new TransportError("protocol", `troca para ${modelId} falhou: ${sanitizeTransportMessage(detail)}`);
		}
		if (result !== null && result !== undefined && typeof result !== "object") {
			throw new TransportError("protocol", "resposta de session/set_model inválida");
		}
		const body = (result ?? {}) as { currentModelId?: unknown; modelId?: unknown };
		const reported =
			typeof body.currentModelId === "string"
				? body.currentModelId
				: typeof body.modelId === "string"
					? body.modelId
					: undefined;
		if (reported !== undefined && reported !== modelId) {
			throw new TransportError("protocol", `troca reportou ${sanitizeTransportMessage(reported)}, esperado ${modelId}`);
		}
		this.switchInfo = { requested: modelId, status: reported === undefined ? "unconfirmed" : "confirmed" };
	}

	get pid(): number | undefined {
		return this.proc.pid;
	}

	/** Um turno. Texto vem dos chunks de agent_message_chunk; usage do resultado do session/prompt. */
	async prompt(text: string, options: { signal?: AbortSignal }): Promise<AcpPromptResult> {
		this.chunks = [];
		this.updateTypes = [];
		this.usageUpdates = 0;
		this.tools = new Map();
		this.malformedToolUpdates = 0;
		const result = (await this.conn.request(
			"session/prompt",
			{ sessionId: this.sessionId, prompt: [{ type: "text", text }] },
			{ timeoutMs: this.timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) },
		)) as { stopReason?: unknown; usage?: unknown } | null;
		if (result === null || typeof result !== "object" || typeof result.stopReason !== "string") {
			throw new TransportError("protocol", "session/prompt sem stopReason");
		}
		return {
			text: this.chunks.join(""),
			stopReason: result.stopReason,
			usage: result.usage,
			usageUpdates: this.usageUpdates,
			updateTypes: [...this.updateTypes],
			toolActivity: this.toolActivitySnapshot(),
			malformedToolUpdates: this.malformedToolUpdates,
		};
	}

	/** Cópia das chamadas de ferramenta observadas até agora (também usada no caminho de erro, sem resultado do prompt). */
	toolActivitySnapshot(): AgyToolActivity[] {
		return [...this.tools.values()].map((tool) => ({ ...tool, arguments: { ...tool.arguments } }));
	}

	/**
	 * Sonda session/set_model sem prompt: não consome tokens. Erro JSON-RPC é resposta válida (`unsupported`);
	 * só falha de transporte é `transport`.
	 */
	async probeSetModel(modelId: string): Promise<AcpSetModelProbe> {
		try {
			await this.conn.request(
				"session/set_model",
				{ sessionId: this.sessionId, modelId },
				{ timeoutMs: this.timeoutMs },
			);
			return { status: "supported" };
		} catch (error) {
			if (error instanceof JsonRpcError) {
				return { status: "unsupported", code: error.code, message: sanitizeTransportMessage(error.message) };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { status: "transport", message: sanitizeTransportMessage(message) };
		}
	}

	/** Diagnóstico redigido da cauda de stderr, para anexar a mensagens de falha. */
	stderrTail(): string {
		return sanitizeTransportMessage(this.stderrChunks.join("").slice(-1000));
	}

	/**
	 * Encerra a sessão sem deixar processo órfão: rejeita pendências, fecha stdin, espera a saída e mata se preciso.
	 * Idempotente.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.conn.failAll(new TransportError("closed", "sessão encerrada"));
		await this.workspaceHandlers?.close();
		if (this.processError !== undefined) return;
		try {
			this.proc.stdin.end();
		} catch {
			// stdin já fechado: segue para a espera e o kill.
		}
		if (!(await this.waitExit(EXIT_GRACE_MS))) {
			try {
				this.proc.kill("SIGKILL");
			} catch {
				// processo já inexistente
			}
			await this.waitExit(EXIT_GRACE_MS);
		}
	}

	private onUpdate(params: unknown): void {
		if (params === null || typeof params !== "object") return;
		const p = params as {
			sessionId?: unknown;
			update?: { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } };
		};
		if (p.sessionId !== this.sessionId || p.update === undefined) return;
		const kind = typeof p.update.sessionUpdate === "string" ? p.update.sessionUpdate : "desconhecido";
		this.updateTypes.push(kind);
		if (kind === "tool_call" || kind === "tool_call_update") {
			this.onToolUpdate(kind, p.update as Record<string, unknown>);
		}
		if (
			kind === "agent_message_chunk" &&
			p.update.content?.type === "text" &&
			typeof p.update.content.text === "string"
		) {
			this.chunks.push(p.update.content.text);
		}
		if (kind === "usage_update") this.usageUpdates += 1;
	}

	/**
	 * tool_call declara a chamada; tool_call_update atualiza status e saída. Entradas inválidas são contadas, nunca
	 * lançadas: um update malformado não pode derrubar um turno que o agy concluiu.
	 */
	private onToolUpdate(kind: "tool_call" | "tool_call_update", update: Record<string, unknown>): void {
		const id = typeof update.toolCallId === "string" && update.toolCallId !== "" ? update.toolCallId : undefined;
		if (id === undefined) {
			this.malformedToolUpdates += 1;
			return;
		}
		const rawStatus = update.status;
		const statusValid =
			rawStatus === undefined || (typeof rawStatus === "string" && AGY_TOOL_STATUSES.includes(rawStatus));
		if (!statusValid) this.malformedToolUpdates += 1;
		const status = statusValid && typeof rawStatus === "string" ? (rawStatus as AgyToolStatus) : undefined;
		const existing = this.tools.get(id);
		if (kind === "tool_call") {
			if (existing !== undefined) {
				this.malformedToolUpdates += 1;
				return;
			}
			this.tools.set(id, {
				toolCallId: id,
				toolName: nameOf(update),
				arguments: this.argumentsFrom(update),
				status: status ?? "pending",
				output: outputOf(update),
			});
			return;
		}
		// tool_call_update: órfão (sem tool_call anterior) também é registrado, para não perder a execução.
		if (existing === undefined) this.malformedToolUpdates += 1;
		const entry: AgyToolActivity = existing ?? {
			toolCallId: id,
			toolName: nameOf(update),
			arguments: this.argumentsFrom(update),
			status: "pending",
			output: "",
		};
		if (status !== undefined) entry.status = status;
		const out = outputOf(update);
		if (out !== "") entry.output = entry.output === "" ? out : `${entry.output}\n${out}`;
		this.tools.set(id, entry);
	}

	/** rawInput objeto -> argumentos; ausente -> {}; presente e não objeto -> {} e conta como malformado. */
	private argumentsFrom(update: Record<string, unknown>): Record<string, unknown> {
		const raw = update.rawInput;
		if (raw === undefined) return {};
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			this.malformedToolUpdates += 1;
			return {};
		}
		return { ...(raw as Record<string, unknown>) };
	}

	private waitExit(ms: number): Promise<boolean> {
		if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			this.proc.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
}
