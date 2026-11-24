// Baldes de telemetria de uma chamada (contract v4, regras a e b): mede, marca o que falta e nunca altera oracle_pass.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CONTRACT_V5_ID } from "../contract.ts";
import { transportFor, uncachedInputTokens } from "./capabilities.ts";
import { costForMessage, type PriceBook } from "./prices.ts";

export interface CallTelemetry {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	uncached_input_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
	cost_usd: number | null;
	cost_basis: string;
	/** Nulos declarados pela tabela de transporte como não expostos (não são falha). Sempre subconjunto dos nulos. */
	declared_not_exposed: string[];
	/** Baldes que não se aplicam ao modo de cobrança (ex.: cost_usd em sessão de assinatura). Não são falha. */
	declared_not_applicable: string[];
	/** Baldes obrigatórios não medidos e não declarados. Vazio quando telemetry_complete=true. */
	missing_buckets: string[];
	telemetry_complete: boolean;
	/** UNVERIFIABLE: agy com cache ativo (regra v5), até um turno com cache comprovar a semântica. */
	cost_accounting_status: "MEASURED" | "INCONCLUSIVE" | "UNVERIFIABLE";
}

/**
 * Mapeia o usage do pi-ai para os baldes do contrato. prompt_tokens inclui cache (input + cacheRead + cacheWrite),
 * completion_tokens é output, e total = prompt + completion. Campo que o transporte declara como não exposto
 * e que chega nulo vai para declared_not_exposed, e não para missing_buckets.
 */
export function buildCallTelemetry(
	provider: string,
	message: AssistantMessage,
	book: PriceBook,
	options: { contractId?: string } = {},
): CallTelemetry {
	const u = message.usage;
	const promptTokens = u.input + u.cacheRead + u.cacheWrite;
	const transport = transportFor(message.api);
	// agy sob v5: regra condicional própria. Sob v4 não há regra para o agy (uncached fica null).
	const agy = options.contractId === CONTRACT_V5_ID && provider === "agy" ? agyV5Rule(u) : null;
	const uncached = agy !== null ? agy.uncached : uncachedInputTokens(provider, message);
	const cost = costForMessage(message, book);
	const notApplicable: string[] = [];
	// Sessão de assinatura: a cobrança não é por token; o custo é declarado como não aplicável, não como desconhecido.
	if (cost !== null && cost.usd === null) notApplicable.push("cost_usd");

	const declared: string[] = [];
	const missing: string[] = [];
	// Erro ou aborto sem nenhum token: zero aqui significa que o provedor não respondeu com usage, não medição.
	if ((message.stopReason === "error" || message.stopReason === "aborted") && u.totalTokens === 0) {
		missing.push("usage_not_reported");
	}
	// Caches: o pi-ai preenche 0 quando o transporte não envia; se a tabela diz não exposto, 0 não é medição.
	const cacheRead =
		transport?.cache_read_tokens === "not_exposed" ? declareNull("cache_read_tokens", declared) : u.cacheRead;
	const cacheWrite =
		transport?.cache_write_tokens === "not_exposed" ? declareNull("cache_write_tokens", declared) : u.cacheWrite;
	// Reasoning: valor presente é medição; ausente é declarado só quando a tabela diz não exposto.
	const reasoning: number | null = u.reasoning ?? null;
	if (reasoning === null) {
		if (transport?.reasoning_tokens === "not_exposed") declareNull("reasoning_tokens", declared);
		else missing.push("reasoning_tokens");
	}
	// Usage incompleto declarado pelo adaptador (campos ausentes viraram 0 e não são medição).
	if (message.diagnostics?.some((d) => d.type === "usage_incomplete")) missing.push("usage_incomplete");
	if (message.diagnostics?.some((d) => d.type === "model_switch_unconfirmed")) missing.push("model_switch_unconfirmed");
	if (agy !== null) missing.push(...agy.missing);
	else if (uncached === null) missing.push("uncached_input_tokens");
	if (cost === null) missing.push("cost_usd");

	const complete = missing.length === 0;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: u.output,
		total_tokens: promptTokens + u.output,
		uncached_input_tokens: uncached,
		cache_read_tokens: cacheRead,
		cache_write_tokens: cacheWrite,
		reasoning_tokens: reasoning,
		cost_usd: cost?.usd ?? null,
		cost_basis: cost?.basis ?? "unknown",
		declared_not_exposed: declared,
		declared_not_applicable: notApplicable,
		missing_buckets: missing,
		telemetry_complete: complete,
		cost_accounting_status: complete ? "MEASURED" : agy?.unverifiable === true ? "UNVERIFIABLE" : "INCONCLUSIVE",
	};
}

/** Registra o balde como nulo declarado pelo transporte (não exposto). */
function declareNull(bucket: string, declared: string[]): null {
	declared.push(bucket);
	return null;
}

/**
 * Regra condicional do agy (contrato v5 ratificado). Cache zero e totalTokens = inputTokens + outputTokens: uncached é
 * inputTokens (com cache zero, as duas semânticas dão o mesmo valor). Cache ativo: UNVERIFIABLE, sem medição de uncached.
 */
function agyV5Rule(u: AssistantMessage["usage"]): {
	uncached: number | null;
	missing: string[];
	unverifiable: boolean;
} {
	if (u.cacheRead > 0 || u.cacheWrite > 0) {
		return { uncached: null, missing: ["uncached_input_tokens", "agy_cache_semantics_unverified"], unverifiable: true };
	}
	if (u.totalTokens !== u.input + u.output) {
		return { uncached: null, missing: ["uncached_input_tokens", "agy_usage_inconsistent"], unverifiable: false };
	}
	return { uncached: u.input, missing: [], unverifiable: false };
}
