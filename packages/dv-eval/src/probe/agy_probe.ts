// Probe live do agy (ACP sobre stdio). Uma sessão, N turnos (o cache só aparece dentro da mesma sessão).
// Registra handshake, modelos, sondagem de session/set_model (sem prompt) e a semântica do usage.
// VERIFIED (aprovação em probe-results/agy.json) só com: handshake numérico, usage completo em todos os turnos,
// semântica DETERMINADA e compatível com o adaptador (cache fora de inputTokens). Caso contrário, INCONCLUSIVE.
//
// Custo: cada turno envia o prompt do probe mais o contexto que o agy mantém na sessão. No probe de 2026-11-24, um turno
// consumiu 13.311 tokens (13.193 de entrada). Ver docs do comando no CLI para o orçamento.
import {
	AcpClient,
	type AcpSetModelProbe,
	AGY_API,
	AGY_DEFAULT_COMMAND,
	type AgyTurnUsage,
	type AgyUsageVerdict,
	classifyAgyUsage,
	mapAgyUsage,
	type SpawnFn,
	sanitizeTransportMessage,
} from "@dv-agent/core";
import { PROBE_SCHEMA } from "./provider_probe.ts";

/** Prompt do probe (mesmo texto do probe de 2026-11-24). Não usa ferramentas. */
export const AGY_PROBE_PROMPT = 'Responda somente com "ok". Não use ferramentas.';
export const AGY_PROBE_DEFAULT_MODEL = "gemini-3.8-flash-high";
export const AGY_PROBE_MAX_TURNS = 3;
/** Teto de tokens do probe inteiro (soma de totalTokens). Verificado entre turnos: o agy não aceita maxTokens. */
export const AGY_PROBE_DEFAULT_MAX_TOKENS = 40_000;

export interface AgyProbeTurn {
	index: number;
	stop_reason: string | null;
	/** Objeto usage cru do session/prompt, só com números. Null se o turno falhou antes do resultado. */
	usage: Record<string, unknown> | null;
	usage_missing: string[];
	text_ok: boolean;
	update_types: string[];
	usage_updates: number;
	error?: string;
}

export interface AgyProbeOptions {
	modelId?: string;
	turns: number;
	/** Teto de tokens do probe (soma de totalTokens). Padrão AGY_PROBE_DEFAULT_MAX_TOKENS. */
	maxTokens?: number;
	cwd: string;
	timeoutMs: number;
	command?: readonly string[];
	spawn?: SpawnFn;
}

export interface AgyProbeResult {
	schema: typeof PROBE_SCHEMA;
	mode: "live";
	provider: "agy";
	model_id: string;
	api: typeof AGY_API;
	auth_mode: "subscription";
	status: "VERIFIED" | "INCONCLUSIVE";
	reasons: string[];
	command: string[];
	handshake: { protocol_version: number | null; agent_name: string | null; auth_methods: number } | null;
	models: { current_model_id: string | null; available_model_ids: string[] } | null;
	set_model_probe: AcpSetModelProbe | null;
	prompt_format: "content_blocks_text";
	turns: AgyProbeTurn[];
	semantics: AgyUsageVerdict | null;
	/** A tabela de capacidades do contrato v4 não tem linha para o agy: MEASURED não é alcançável sob v4 com esta evidência. */
	contract_v4_uncached_rule: "ausente_na_tabela_v4";
}

function usageRecord(raw: unknown): Record<string, unknown> | null {
	if (raw === null || typeof raw !== "object") return null;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "number") out[key] = value;
	}
	return out;
}

/** Roda o probe. Nunca lança por falha do agy: a falha vira INCONCLUSIVE com motivo redigido. */
export async function runAgyProbe(options: AgyProbeOptions): Promise<AgyProbeResult> {
	if (!Number.isInteger(options.turns) || options.turns < 1 || options.turns > AGY_PROBE_MAX_TURNS) {
		throw new Error(`--turns deve ser inteiro entre 1 e ${AGY_PROBE_MAX_TURNS}`);
	}
	const modelId = options.modelId ?? AGY_PROBE_DEFAULT_MODEL;
	const command = [...(options.command ?? AGY_DEFAULT_COMMAND)];
	const reasons: string[] = [];
	const result: AgyProbeResult = {
		schema: PROBE_SCHEMA,
		mode: "live",
		provider: "agy",
		model_id: modelId,
		api: AGY_API,
		auth_mode: "subscription",
		status: "INCONCLUSIVE",
		reasons,
		command,
		handshake: null,
		models: null,
		set_model_probe: null,
		prompt_format: "content_blocks_text",
		turns: [],
		semantics: null,
		contract_v4_uncached_rule: "ausente_na_tabela_v4",
	};

	let client: AcpClient;
	try {
		client = await AcpClient.open({
			cwd: options.cwd,
			modelId,
			timeoutMs: options.timeoutMs,
			command,
			...(options.spawn === undefined ? {} : { spawn: options.spawn }),
		});
	} catch (error) {
		reasons.push(
			`handshake/sessão: ${sanitizeTransportMessage(error instanceof Error ? error.message : String(error))}`,
		);
		return result;
	}

	try {
		const handshake = client.handshake;
		result.handshake = {
			protocol_version: handshake.protocolVersion,
			agent_name: handshake.agentName,
			auth_methods: handshake.authMethods,
		};
		if (handshake.protocolVersion === null) reasons.push("initialize sem protocolVersion numérico");
		const models = client.models;
		result.models = { current_model_id: models.currentModelId, available_model_ids: models.availableModelIds };

		const maxTokens = options.maxTokens ?? AGY_PROBE_DEFAULT_MAX_TOKENS;
		let spent = 0;
		for (let i = 1; i <= options.turns; i += 1) {
			if (spent >= maxTokens) {
				reasons.push(`teto de tokens do probe atingido (${spent} >= ${maxTokens}): turnos restantes não enviados`);
				break;
			}
			const turn: AgyProbeTurn = {
				index: i,
				stop_reason: null,
				usage: null,
				usage_missing: [],
				text_ok: false,
				update_types: [],
				usage_updates: 0,
			};
			result.turns.push(turn);
			try {
				const reply = await client.prompt(AGY_PROBE_PROMPT, {});
				turn.stop_reason = reply.stopReason;
				turn.update_types = reply.updateTypes;
				turn.usage_updates = reply.usageUpdates;
				turn.text_ok = reply.text.trim().toLowerCase() === "ok";
				turn.usage = usageRecord(reply.usage);
				const mapped = mapAgyUsage(reply.usage);
				spent += mapped.usage.totalTokens;
				turn.usage_missing = mapped.missing;
				if (mapped.missing.length > 0) reasons.push(`turno ${i}: usage incompleto (${mapped.missing.join(", ")})`);
				if (reply.stopReason !== "end_turn")
					reasons.push(`turno ${i}: stopReason ${sanitizeTransportMessage(reply.stopReason)}`);
				if (!turn.text_ok) reasons.push(`turno ${i}: resposta diferente de "ok"`);
			} catch (error) {
				turn.error = sanitizeTransportMessage(error instanceof Error ? error.message : String(error));
				reasons.push(`turno ${i}: falha ${turn.error}`);
				break;
			}
		}

		// Sondagem de troca de modelo: só request, sem prompt. Erro JSON-RPC é resposta válida, não falha do probe.
		const alternative = models.availableModelIds.find((id) => id !== modelId);
		if (alternative !== undefined) result.set_model_probe = await client.probeSetModel(alternative);
	} finally {
		await client.close();
	}

	const complete: AgyTurnUsage[] = [];
	for (const turn of result.turns) {
		if (turn.usage !== null && turn.usage_missing.length === 0) {
			complete.push(turn.usage as unknown as AgyTurnUsage);
		}
	}
	const semantics = classifyAgyUsage(complete);
	result.semantics = semantics;
	if (semantics.status === "INCONSISTENT")
		reasons.push(`semântica do usage inconsistente: ${semantics.evidence.at(-1) ?? ""}`);
	if (semantics.status === "INDETERMINATE") {
		reasons.push("semântica do usage indeterminada: nenhum turno com cache (ver turnos 2 ou 3)");
	}
	if (semantics.status === "DETERMINED" && semantics.semantics === "cache_inside_input") {
		reasons.push(
			"cache dentro de inputTokens: o adaptador ainda mapeia input como não cacheado; ajuste exigido antes de aprovar",
		);
	}
	result.status = reasons.length === 0 ? "VERIFIED" : "INCONCLUSIVE";
	return result;
}
