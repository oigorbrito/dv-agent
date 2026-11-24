// Executa um degrau (um run com ledger próprio) ligando o Agent do pi-agent-core ao ledger e aos guards.
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type TextContent,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { CONTRACT_ID, CONTRACT_V5_ID } from "../contract.ts";
import { BudgetGuard, type CeilingStatus } from "../guards/budget.ts";
import { composeBeforeToolCall } from "../guards/compose.ts";
import { DoomLoopDetector } from "../guards/doom_loop.ts";
import { argumentsSha256 } from "../guards/tool_signature.ts";
import { assertProviderCanRun } from "../ledger/capabilities.ts";
import type { LimitReason, RouteDecidedPayload, RunStatus } from "../ledger/events.ts";
import type { PriceBook } from "../ledger/prices.ts";
import { sanitizeProviderErrorMessage } from "../ledger/redact.ts";
import { buildCallTelemetry } from "../ledger/telemetry.ts";
import { ToolOutcomeTracker } from "../ledger/tool_outcomes.ts";
import { ledgerSha256, RunLedger } from "../ledger/writer.ts";
import type { ReasoningEffort } from "../router/policy.ts";
import { sha256Hex } from "../util/canonical.ts";

export interface RungRunOptions {
	ledgerPath: string;
	runId: string;
	harnessVariant: string;
	referenceProvenance: Record<string, string>;
	datasetSha256: string;
	taskDefinitionSha256: string;
	model: Model<Api>;
	systemPrompt?: string;
	tools: AgentTool[];
	prompt: string;
	streamFn: StreamFn;
	priceBook: PriceBook;
	maxCostUsd: number;
	/** Teto de tokens do degrau (prompt + completion). Opcional; ao excedê-lo o degrau termina com budget_exceeded. */
	maxTotalTokens?: number;
	/** Teto de turnos (chamadas ao provedor) do degrau. Corta só quando o turno pediria mais ferramentas. */
	maxTurns?: number;
	/** Teto de output acumulado (tokens de saída) do degrau. */
	maxOutputTokens?: number;
	doomLoopMaxIdenticalConsecutive: number;
	approvedProbes?: ReadonlySet<string>;
	/** Nível de esforço de raciocínio (reasoning effort). */
	reasoningEffort?: ReasoningEffort;
	/** Versão do contrato do run. Padrão v4. Provedor agy exige v5. */
	contractId?: string;
	/** Decisão de roteamento que originou este degrau. Gravada como `route_decided` logo após `run_started`. */
	routeDecision?: RouteDecidedPayload;
}

export interface RungRunResult {
	status: RunStatus;
	ceilingStatus: CeilingStatus;
	spentLowerBoundUsd: number;
	unknownCostCalls: number;
	ledgerPath: string;
	ledgerSha256: string;
	messages: AgentMessage[];
}

/** Um degrau: abre o ledger, roda o agente com guards e fecha com run_finished. Workspace limpo é responsabilidade do chamador. */
export async function executeRung(options: RungRunOptions): Promise<RungRunResult> {
	const contractId = options.contractId ?? CONTRACT_ID;
	if (options.model.provider === "agy" && contractId !== CONTRACT_V5_ID) {
		throw new Error(`agy exige contrato ${CONTRACT_V5_ID}: o ${CONTRACT_ID} não tem regra para o agy`);
	}
	assertProviderCanRun(options.model.provider, options.approvedProbes ?? new Set());
	const ledger = new RunLedger(options.ledgerPath);
	const doom = new DoomLoopDetector({ maxIdenticalConsecutive: options.doomLoopMaxIdenticalConsecutive });
	const budget = new BudgetGuard({
		maxCostUsd: options.maxCostUsd,
		priceBook: options.priceBook,
		...(options.maxTotalTokens === undefined ? {} : { maxTotalTokens: options.maxTotalTokens }),
	});
	const pendingCalls: number[] = [];
	const toolArgumentDigests = new Map<string, string>();
	const tools = new ToolOutcomeTracker();
	const blockedToolCalls = new Map<string, string>();
	// Ferramentas que chegaram ao hook (antes da execução). Pendentes após a parada nunca chegam.
	const hookSeen = new Set<string>();
	let callCount = 0;
	let callsFinished = 0;
	let thrown: unknown;
	let outputTokens = 0;
	// Motivo de corte por limite (contrato v4 não fixa; registrado no ledger para auditoria).
	let limitReason = undefined as LimitReason | undefined;
	// Parada após guard (budget, limite de turno/output ou doom loop encerrado). Depois de fixada, nenhuma chamada
	// nova chega ao provedor e as ferramentas pendentes da resposta são bloqueadas como not_executed.
	let haltReason = undefined as string | undefined;

	ledger.appendRunStarted({
		run_id: options.runId,
		contract_id: contractId,
		harness_variant: options.harnessVariant,
		reference_provenance: options.referenceProvenance,
		dataset_sha256: options.datasetSha256,
		task_definition_sha256: options.taskDefinitionSha256,
		model: { provider: options.model.provider, model_id: options.model.id, api: options.model.api },
		max_cost_usd: options.maxCostUsd,
		guards: { doom_loop_max_identical_consecutive: options.doomLoopMaxIdenticalConsecutive },
	});
	if (options.routeDecision !== undefined) ledger.appendRouteDecided(options.routeDecision);

	// Registra call_started antes de qualquer tentativa do provedor (I1: chamada iniciada sem fim fica em voo).
	const streamFn: StreamFn = (model, context, streamOptions) => {
		if (haltReason !== undefined) return haltedStream(model, haltReason);
		callCount += 1;
		ledger.appendCallStarted({ call_index: callCount, provider: model.provider, model_id: model.id, api: model.api });
		pendingCalls.push(callCount);
		return options.streamFn(model, context, streamOptions);
	};

	const beforeToolCall = composeBeforeToolCall([budget.beforeToolCall.bind(budget), doom.beforeToolCall.bind(doom)]);
	const recordingHook = async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		hookSeen.add(context.toolCall.id);
		if (haltReason !== undefined) {
			const reason = `not_executed: ${haltReason}`;
			blockedToolCalls.set(context.toolCall.id, reason);
			return { block: true, reason };
		}
		const blocksBefore = doom.blocks;
		const result = await beforeToolCall(context);
		if (result?.block) blockedToolCalls.set(context.toolCall.id, result.reason ?? "bloqueada");
		// Bloqueio do doom loop: a chamada é recusada e as demais ferramentas da resposta não são executadas.
		// A run segue até a próxima chamada, que é vetada pelo haltReason (comportamento testado em doom_loop.test).
		if (doom.blocks > blocksBefore) haltReason ??= "doom_loop";
		return result;
	};

	const agent = new Agent({
		streamFn,
		beforeToolCall: recordingHook,
		initialState: {
			model: options.model,
			systemPrompt: options.systemPrompt ?? "",
			tools: options.tools,
			...(options.reasoningEffort !== undefined ? { thinkingLevel: options.reasoningEffort } : {}),
		},
	});

	agent.subscribe((event) => {
		if (event.type !== "message_end") return;
		const message = event.message;
		if (message.role === "assistant") {
			// Resposta sintética do stream vetado: não é chamada ao provedor, então não tem call_started nem usage.
			if (pendingCalls.length === 0 && haltReason !== undefined) return;
			const index = pendingCalls.shift();
			if (index === undefined) throw new Error("message_end de assistente sem call_started");
			recordAssistant(index, message);
			callsFinished += 1;
			outputTokens += message.usage.output;
			if (budget.onMessageEnd(message)) {
				haltReason ??= "budget_exceeded";
				agent.abort();
			} else if (limitReason === undefined) {
				const wantsTools = message.content.some((block) => block.type === "toolCall");
				if (options.maxOutputTokens !== undefined && outputTokens > options.maxOutputTokens) {
					limitReason = "max_output_tokens";
				} else if (options.maxTurns !== undefined && callsFinished >= options.maxTurns && wantsTools) {
					limitReason = "max_turns";
				}
				if (limitReason !== undefined) {
					haltReason ??= limitReason;
					agent.abort();
				}
			}
		} else if (message.role === "toolResult") {
			recordToolResult(message);
		}
	});

	const recordAssistant = (index: number, message: AssistantMessage): void => {
		const toolCalls = message.content.filter((block) => block.type === "toolCall");
		for (const call of toolCalls) {
			toolArgumentDigests.set(call.id, argumentsSha256(call.arguments));
			tools.declare({ toolCallId: call.id, toolName: call.name, argumentsSha256: argumentsSha256(call.arguments) });
		}
		ledger.appendCallFinished({
			call_index: index,
			record: {
				stop_reason: message.stopReason,
				...(message.errorMessage === undefined
					? {}
					: { error_message: sanitizeProviderErrorMessage(message.errorMessage) }),
				usage: {
					input: message.usage.input,
					output: message.usage.output,
					cache_read: message.usage.cacheRead,
					cache_write: message.usage.cacheWrite,
					total: message.usage.totalTokens,
				},
				telemetry: buildCallTelemetry(message.provider, message, options.priceBook, { contractId }),
				tool_calls: toolCalls.map((call) => ({
					tool_call_id: call.id,
					tool_name: call.name,
					arguments_sha256: argumentsSha256(call.arguments),
				})),
			},
		});
	};

	const recordToolResult = (message: ToolResultMessage): void => {
		tools.report(message.toolCallId);
		// Sem passar pelo hook, a ferramenta foi cortada pela parada (o handler não roda): not_executed explícito.
		const blockReason =
			blockedToolCalls.get(message.toolCallId) ??
			(haltReason !== undefined && !hookSeen.has(message.toolCallId) ? `not_executed: ${haltReason}` : undefined);
		const rawOutput = message.content
			.map((part) => (part.type === "text" ? (part as TextContent).text : "[imagem]"))
			.join("\n");
		ledger.appendToolFinished({
			tool_call_id: message.toolCallId,
			tool_name: message.toolName,
			arguments_sha256: toolArgumentDigests.get(message.toolCallId) ?? "",
			status: blockReason !== undefined ? "blocked" : message.isError ? "error" : "ok",
			...(blockReason === undefined ? {} : { block_reason: blockReason }),
			raw_output: rawOutput,
			raw_output_sha256: sha256Hex(rawOutput),
		});
	};

	try {
		await agent.prompt(options.prompt);
		await agent.waitForIdle();
	} catch (error) {
		thrown = error;
	}

	// Chamada declarada sem resultado é registrada como não executada (nada desaparece em silêncio).
	tools.finalize(ledger, "run terminada antes da execução da ferramenta");

	const messages = [...agent.state.messages];
	// A resposta sintética de parada não é resposta do modelo: o status final vem da última resposta real.
	const lastAssistant = [...messages]
		.reverse()
		.find((m): m is AssistantMessage => m.role === "assistant" && !m.errorMessage?.startsWith("parada por guard:"));
	const status = finalStatus(
		budget.tripped || budget.tokensTripped,
		limitReason !== undefined,
		thrown !== undefined,
		lastAssistant,
	);
	ledger.appendRunFinished({
		status,
		calls_started: callCount,
		calls_finished: callsFinished,
		in_flight_call_indices: [...pendingCalls],
		spent_lower_bound_usd: budget.spentLowerBoundUsd,
		unknown_cost_calls: budget.unknownCostCalls,
		non_metered_cost_calls: budget.nonMeteredCostCalls,
		ceiling_status: budget.ceilingStatus(),
		guard_events: {
			doom_loop_blocks: doom.blocks,
			budget_blocked_tools: budget.blockedTools,
			limit_reason: limitReason ?? null,
		},
	});
	ledger.close();
	return {
		status,
		ceilingStatus: budget.ceilingStatus(),
		spentLowerBoundUsd: budget.spentLowerBoundUsd,
		unknownCostCalls: budget.unknownCostCalls,
		ledgerPath: options.ledgerPath,
		ledgerSha256: ledgerSha256(options.ledgerPath),
		messages,
	};
}

/** Estado final: orçamento vence; depois erro do provedor; depois aborto externo; senão concluído. */
function finalStatus(
	tripped: boolean,
	limited: boolean,
	threw: boolean,
	last: AssistantMessage | undefined,
): RunStatus {
	if (tripped) return "budget_exceeded";
	if (limited) return "limit_exceeded";
	if (threw || last?.stopReason === "error") return "provider_error";
	if (last?.stopReason === "aborted") return "aborted";
	return "completed";
}

/** Mensagem de erro `aborted` sem conteúdo nem usage: usada para encerrar o loop sem chamar o provedor. */
function haltedStream(model: Model<Api>, reason: string): AssistantMessageEventStream {
	const message: AssistantMessage = {
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
		stopReason: "aborted",
		errorMessage: `parada por guard: ${reason}`,
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "aborted", error: message });
	stream.end();
	return stream;
}
