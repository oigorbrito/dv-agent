// Baldes de telemetria de uma chamada (contract v4, regras a e b): mede, marca o que falta e nunca altera oracle_pass.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type PriceBook, costForMessage } from "./prices.ts";
import { uncachedInputTokens } from "./capabilities.ts";

export interface CallTelemetry {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	uncached_input_tokens: number | null;
	cache_read_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number | null;
	cost_usd: number | null;
	cost_basis: string;
	/** Baldes obrigatórios não medidos. Vazio quando telemetry_complete=true. */
	missing_buckets: string[];
	telemetry_complete: boolean;
	cost_accounting_status: "MEASURED" | "INCONCLUSIVE";
}

/**
 * Mapeia o usage do pi-ai para os baldes do contrato. prompt_tokens inclui cache (input + cacheRead + cacheWrite),
 * completion_tokens é output, e total = prompt + completion.
 */
export function buildCallTelemetry(provider: string, message: AssistantMessage, book: PriceBook): CallTelemetry {
	const u = message.usage;
	const promptTokens = u.input + u.cacheRead + u.cacheWrite;
	const uncached = uncachedInputTokens(provider, message);
	const reasoning = u.reasoning ?? null;
	const cost = costForMessage(message, book);

	const missing: string[] = [];
	if (uncached === null) missing.push("uncached_input_tokens");
	if (reasoning === null) missing.push("reasoning_tokens");
	if (cost === null) missing.push("cost_usd");

	const complete = missing.length === 0;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: u.output,
		total_tokens: promptTokens + u.output,
		uncached_input_tokens: uncached,
		cache_read_tokens: u.cacheRead,
		cache_write_tokens: u.cacheWrite,
		reasoning_tokens: reasoning,
		cost_usd: cost?.usd ?? null,
		cost_basis: cost?.basis ?? "unknown",
		missing_buckets: missing,
		telemetry_complete: complete,
		cost_accounting_status: complete ? "MEASURED" : "INCONCLUSIVE",
	};
}
