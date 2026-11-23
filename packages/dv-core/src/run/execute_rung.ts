// Executa um degrau (um run com ledger próprio) ligando o Agent do pi-agent-core ao ledger e aos guards.
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { CONTRACT_ID } from "../contract.ts";
import { BudgetGuard, type CeilingStatus } from "../guards/budget.ts";
import { composeBeforeToolCall } from "../guards/compose.ts";
import { DoomLoopDetector } from "../guards/doom_loop.ts";
import { argumentsSha256 } from "../guards/tool_signature.ts";
import { assertProviderCanRun } from "../ledger/capabilities.ts";
import type { LimitReason, RunStatus } from "../ledger/events.ts";
import type { PriceBook } from "../ledger/prices.ts";
import { buildCallTelemetry } from "../ledger/telemetry.ts";
import { ToolOutcomeTracker } from "../ledger/tool_outcomes.ts";
import { ledgerSha256, RunLedger } from "../ledger/writer.ts";
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
	let callCount = 0;
	let callsFinished = 0;
	let thrown: unknown;
	let outputTokens = 0;
	// Motivo de corte por limite (contrato v4 não fixa; registrado no ledger para auditoria).
	let limitReason = undefined as LimitReason | undefined;

	ledger.appendRunStarted({
		run_id: options.runId,
		contract_id: CONTRACT_ID,
		harness_variant: options.harnessVariant,
		reference_provenance: options.referenceProvenance,
		dataset_sha256: options.datasetSha256,
		task_definition_sha256: options.taskDefinitionSha256,
		model: { provider: options.model.provider, model_id: options.model.id, api: options.model.api },
		max_cost_usd: options.maxCostUsd,
		guards: { doom_loop_max_identical_consecutive: options.doomLoopMaxIdenticalConsecutive },
	});

	// Registra call_started antes de qualquer tentativa do provedor (I1: chamada iniciada sem fim fica em voo).
	const streamFn: StreamFn = (model, context, streamOptions) => {
		callCount += 1;
		ledger.appendCallStarted({ call_index: callCount, provider: model.provider, model_id: model.id, api: model.api });
		pendingCalls.push(callCount);
		return options.streamFn(model, context, streamOptions);
	};

	const beforeToolCall = composeBeforeToolCall([budget.beforeToolCall.bind(budget), doom.beforeToolCall.bind(doom)]);
	const recordingHook = async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const result = await beforeToolCall(context);
		if (result?.block) blockedToolCalls.set(context.toolCall.id, result.reason ?? "bloqueada");
		return result;
	};

	const agent = new Agent({
		streamFn,
		beforeToolCall: recordingHook,
		initialState: { model: options.model, systemPrompt: options.systemPrompt ?? "", tools: options.tools },
	});

	agent.subscribe((event) => {
		if (event.type !== "message_end") return;
		const message = event.message;
		if (message.role === "assistant") {
			const index = pendingCalls.shift();
			if (index === undefined) throw new Error("message_end de assistente sem call_started");
			recordAssistant(index, message);
			callsFinished += 1;
			outputTokens += message.usage.output;
			if (budget.onMessageEnd(message)) {
				agent.abort();
			} else if (limitReason === undefined) {
				const wantsTools = message.content.some((block) => block.type === "toolCall");
				if (options.maxOutputTokens !== undefined && outputTokens > options.maxOutputTokens) {
					limitReason = "max_output_tokens";
				} else if (options.maxTurns !== undefined && callsFinished >= options.maxTurns && wantsTools) {
					limitReason = "max_turns";
				}
				if (limitReason !== undefined) agent.abort();
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
				...(message.errorMessage === undefined ? {} : { error_message: message.errorMessage }),
				usage: {
					input: message.usage.input,
					output: message.usage.output,
					cache_read: message.usage.cacheRead,
					cache_write: message.usage.cacheWrite,
					total: message.usage.totalTokens,
				},
				telemetry: buildCallTelemetry(message.provider, message, options.priceBook),
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
		const blockReason = blockedToolCalls.get(message.toolCallId);
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
	const lastAssistant = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
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
