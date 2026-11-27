// Adaptador agy (ACP sobre stdio) como StreamFn do executeRung. Um processo por chamada: abre, faz o turno, encerra.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type StopReason,
} from "@earendil-works/pi-ai";
import {
	AcpClient,
	type AcpPromptResult,
	type AgyToolActivity,
	type SpawnFn,
	sanitizeTransportMessage,
} from "./acp_client.ts";
import { TransportError } from "./jsonrpc.ts";
import { mapAgyUsage } from "./usage.ts";

export const AGY_PROVIDER = "agy";
export const AGY_API = "agy-acp";

/** Modelos anunciados pelo `session/new` no probe de 2026-11-24 (ids sem o prefixo `agy/`). */
export const AGY_MODELS: readonly { modelId: string; name: string }[] = [
	{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
	{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
	{ modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
	{ modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
	{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

export function isAgyModel(modelId: string): boolean {
	return AGY_MODELS.some((m) => m.modelId === modelId);
}

/** Modelo do catálogo local para o namespace agy/. Preço zero: a sessão é de login local, sem tarifa por token. */
export function agyModel(modelId: string): Model<string> {
	const entry = AGY_MODELS.find((m) => m.modelId === modelId);
	if (entry === undefined) throw new Error(`modelo agy desconhecido: ${modelId}`);
	return {
		id: entry.modelId,
		name: entry.name,
		api: AGY_API,
		provider: AGY_PROVIDER,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		// Janela e saída máxima não são informadas pelo agy no probe: 0 significa desconhecido.
		contextWindow: 0,
		maxTokens: 0,
	} as Model<string>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			const b = block as { type?: unknown; text?: unknown };
			return b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string";
		})
		.map((block) => block.text)
		.join("");
}

/** Prompt de texto a partir do contexto do agente. */
export function promptFromContext(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt !== undefined && context.systemPrompt !== "") {
		parts.push(`[sistema]\n${context.systemPrompt}`);
	}
	for (const message of context.messages) {
		parts.push(`[${message.role}]\n${textOf((message as { content: unknown }).content)}`);
	}
	return parts.join("\n\n");
}

/** Mapeia o stopReason do ACP para o do pi-ai. Desconhecido vira erro, nunca sucesso silencioso. */
export function mapStopReason(acp: string): { stopReason: StopReason; errorMessage?: string } {
	switch (acp) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
		case "max_turn_requests":
			return { stopReason: "length" };
		case "cancelled":
			return { stopReason: "aborted", errorMessage: "turno cancelado pelo agy" };
		case "refusal":
			return { stopReason: "error", errorMessage: "agy recusou o pedido (refusal)" };
		default:
			return { stopReason: "error", errorMessage: `stopReason do agy desconhecido: ${sanitizeTransportMessage(acp)}` };
	}
}

type AssistantDiagnostic = NonNullable<AssistantMessage["diagnostics"]>[number];

/**
 * Diagnóstico `agy_tool_activity`: chamadas de ferramenta que o próprio agy executou no turno (via fs/terminal do
 * cliente ACP). Não são blocos toolCall: o agent-loop não as reexecuta. execute_rung as grava no ledger.
 */
export function toolActivityDiagnostic(
	calls: readonly AgyToolActivity[],
	malformedUpdates: number,
): AssistantDiagnostic {
	return {
		type: "agy_tool_activity",
		timestamp: Date.now(),
		details: {
			calls: calls.map((call) => ({
				tool_call_id: call.toolCallId,
				tool_name: call.toolName,
				arguments: call.arguments,
				status: call.status,
				output: call.output,
			})),
			malformed_updates: malformedUpdates,
		} as unknown as AssistantDiagnostic["details"],
	};
}

/** Chamada de ferramenta do agy lida de um diagnóstico `agy_tool_activity` (forma gravada por toolActivityDiagnostic). */
export interface ObservedAgyToolCall {
	tool_call_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
	status: AgyToolActivity["status"];
	output: string;
}

/** Lê as chamadas observadas de uma mensagem do assistente. Diagnóstico malformado é ignorado (a origem é o próprio adaptador). */
export function observedAgyToolCalls(message: AssistantMessage): ObservedAgyToolCall[] {
	const calls: ObservedAgyToolCall[] = [];
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "agy_tool_activity") continue;
		const list = (diagnostic.details as { calls?: unknown } | undefined)?.calls;
		if (!Array.isArray(list)) continue;
		for (const item of list as ObservedAgyToolCall[]) calls.push(item);
	}
	return calls;
}

export interface AgyStreamOptions {
	cwd: string;
	timeoutMs: number;
	command?: readonly string[];
	spawn?: SpawnFn;
}

export function createAgyStreamFn(options: AgyStreamOptions): StreamFn {
	return (model, context, streamOptions) => {
		const stream = createAssistantMessageEventStream();
		void runTurn(stream, model, context, options, streamOptions?.signal);
		return stream;
	};
}

async function runTurn(
	stream: AssistantMessageEventStream,
	model: Model<string>,
	context: Context,
	options: AgyStreamOptions,
	signal: AbortSignal | undefined,
): Promise<void> {
	const base: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: base });

	// Limpeza ANTES do evento terminal: quem consome o stream já encontra o processo encerrado.
	const outcome = await executeTurn(base, model, context, options, signal);
	for (const event of outcome.events) stream.push(event);
	stream.end(outcome.message);
}

interface TurnOutcome {
	message: AssistantMessage;
	events: AssistantMessageEvent[];
}

async function executeTurn(
	base: AssistantMessage,
	model: Model<string>,
	context: Context,
	options: AgyStreamOptions,
	signal: AbortSignal | undefined,
): Promise<TurnOutcome> {
	const failed = (
		errorMessage: string,
		diagnostics: NonNullable<AssistantMessage["diagnostics"]> = [],
	): TurnOutcome => {
		const message: AssistantMessage = {
			...base,
			stopReason: "error",
			errorMessage: sanitizeTransportMessage(errorMessage),
			...(diagnostics.length === 0 ? {} : { diagnostics }),
		};
		return { message, events: [{ type: "error", reason: "error", error: message }] };
	};
	let client: AcpClient | undefined;
	try {
		client = await AcpClient.open({
			cwd: options.cwd,
			modelId: model.id,
			timeoutMs: options.timeoutMs,
			...(options.command === undefined ? {} : { command: options.command }),
			...(options.spawn === undefined ? {} : { spawn: options.spawn }),
		});
		const result: AcpPromptResult = await client.prompt(promptFromContext(context), {
			...(signal === undefined ? {} : { signal }),
		});
		const switchStatus = client.modelSwitch?.status;
		await client.close();
		client = undefined;
		const mapped = mapStopReason(result.stopReason);
		const usage = mapAgyUsage(result.usage);
		// Diagnósticos auditáveis: campo de usage ausente e troca de modelo não confirmada viram baldes ausentes na telemetria.
		const diagnostics: NonNullable<AssistantMessage["diagnostics"]> = [
			...(result.toolActivity.length === 0 && result.malformedToolUpdates === 0
				? []
				: [toolActivityDiagnostic(result.toolActivity, result.malformedToolUpdates)]),
			...(usage.missing.length === 0
				? []
				: [{ type: "usage_incomplete", timestamp: Date.now(), details: { missing: usage.missing } }]),
			...(switchStatus === "unconfirmed"
				? [{ type: "model_switch_unconfirmed", timestamp: Date.now(), details: { requested: model.id } }]
				: []),
		];
		const message: AssistantMessage = {
			...base,
			content: result.text === "" ? [] : [{ type: "text", text: result.text }],
			usage: usage.usage,
			stopReason: mapped.stopReason,
			...(mapped.errorMessage === undefined ? {} : { errorMessage: mapped.errorMessage }),
			...(diagnostics.length === 0 ? {} : { diagnostics }),
		};
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return { message, events: [{ type: "error", reason: message.stopReason, error: message }] };
		}
		const events: AssistantMessageEvent[] = [];
		if (result.text !== "") {
			events.push({ type: "text_start", contentIndex: 0, partial: base });
			events.push({ type: "text_delta", contentIndex: 0, delta: result.text, partial: base });
			events.push({ type: "text_end", contentIndex: 0, content: result.text, partial: message });
		}
		events.push({ type: "done", reason: "stop", message });
		return { message, events };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const suffix = client === undefined ? "" : ` | stderr: ${client.stderrTail()}`;
		// Chamadas observadas antes da falha ficam registradas: o efeito no workspace pode ter ocorrido.
		const observed = client?.toolActivitySnapshot() ?? [];
		const observedDiagnostics: AssistantDiagnostic[] =
			observed.length === 0 ? [] : [toolActivityDiagnostic(observed, 0)];
		if (error instanceof TransportError && error.kind === "spawn") {
			return failed(`falha de transporte do agy: ${detail}`, [
				{
					type: "provider_spawn_error",
					timestamp: Date.now(),
					details: {
						...(error.code === undefined ? {} : { code: error.code }),
						...(error.syscall === undefined ? {} : { syscall: error.syscall }),
						...(error.executable === undefined ? {} : { executable: error.executable }),
					},
				},
			]);
		}
		return failed(`falha de transporte do agy: ${detail}${suffix}`, observedDiagnostics);
	} finally {
		await client?.close();
	}
}
