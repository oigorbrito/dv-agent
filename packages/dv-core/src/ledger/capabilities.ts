// Capacidades do contrato v4 (regra b) e tabela explícita do transporte pi-ai (quais campos de usage cada família expõe).
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type CapabilityStatus = "CODE_VERIFIED_OFFLINE" | "PROVISIONAL_PROBE_REQUIRED";

export interface ProviderCapability {
	provider: string;
	/** `pi_usage_input`: usage.input do pi-ai é o input não cacheado. `none`: regra não implementada (campo fica null). */
	uncached: "pi_usage_input" | "none";
	status: CapabilityStatus;
	source: string;
}

// Espelha as linhas de `capability_table` do contrato v4 (experiments/p1). Não amplie sem nova versão do contrato.
const CAPABILITY_TABLE: readonly ProviderCapability[] = [
	{
		provider: "anthropic",
		uncached: "pi_usage_input",
		status: "CODE_VERIFIED_OFFLINE",
		source: "contract v4 regra b (litellm 1.110.1). Equivalência com usage.input do pi-ai não re-verificada por probe.",
	},
	{
		provider: "gemini",
		uncached: "none",
		status: "PROVISIONAL_PROBE_REQUIRED",
		source: "contract v4 regra b: prompt_tokens - cached_tokens; probe obrigatório antes da execução.",
	},
	{
		provider: "agy",
		uncached: "none",
		status: "PROVISIONAL_PROBE_REQUIRED",
		source:
			"probe ACP 2026-11-24: inputTokens e cachedReadTokens não dizem se o cache está dentro de inputTokens; regra b não definida para agy. Probe live obrigatório.",
	},
	{
		provider: "openai",
		uncached: "none",
		status: "PROVISIONAL_PROBE_REQUIRED",
		source: "contract v4 regra b: prompt_tokens - cached_tokens; probe obrigatório antes da execução.",
	},
];

/** Capacidade registrada do provedor, ou undefined (unknown_provider: sem regra). */
export function capabilityFor(provider: string): ProviderCapability | undefined {
	return CAPABILITY_TABLE.find((row) => row.provider === provider);
}

/** uncached_input_tokens pela regra registrada do provedor. Sem regra, null. Nunca por subtração genérica. */
export function uncachedInputTokens(provider: string, message: AssistantMessage): number | null {
	const capability = capabilityFor(provider);
	if (capability?.uncached === "pi_usage_input") return message.usage.input;
	return null;
}

/**
 * Bloqueia a execução de provedor com capacidade PROVISIONAL sem probe aprovado (regra b, capability_probe).
 * `approvedProbes` contém os provedores cujo probe live foi aprovado (status VERIFIED, em dv-eval/probe-results).
 */
export function assertProviderCanRun(provider: string, approvedProbes: ReadonlySet<string>): void {
	const capability = capabilityFor(provider);
	if (capability?.status === "PROVISIONAL_PROBE_REQUIRED" && !approvedProbes.has(provider)) {
		throw new Error(`provedor ${provider} com capacidade PROVISIONAL sem probe aprovado (contract v4, regra b)`);
	}
}

/** Exposição de um campo de usage pelo transporte. `not_exposed` só vale quando o transporte não envia o campo. */
export type FieldExposure = "exposed" | "not_exposed";

export interface TransportCapability {
	/** Identificador `api` do pi-ai (família de transporte). `faux` é o transporte de teste. */
	api: string;
	reasoning_tokens: FieldExposure;
	cache_read_tokens: FieldExposure;
	cache_write_tokens: FieldExposure;
	/** Fonte da declaração no código do pi-ai (arquivo e comportamento observado). */
	source: string;
	test_only?: boolean;
}

// Declaração explícita por transporte. Família sem linha = não verificada: campos ficam como medidos ou ausentes.
export const PI_TRANSPORT_CAPABILITIES: readonly TransportCapability[] = [
	{
		api: "anthropic-messages",
		reasoning_tokens: "not_exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "exposed",
		source:
			"api/anthropic-messages.ts: cache_read/cache_creation_input_tokens; thinking_tokens só quando um proxy envia (fora do transporte padrão).",
	},
	{
		api: "openai-completions",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "not_exposed",
		source:
			"api/openai-completions.ts: completion_tokens_details.reasoning_tokens e prompt_tokens_details.cached_tokens; OpenAI não emite cache_write.",
	},
	{
		api: "openai-responses",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "not_exposed",
		source:
			"api/openai-responses-shared.ts: output_tokens_details.reasoning_tokens e input_tokens_details.cached_tokens; cache_write não emitido pela OpenAI.",
	},
	{
		api: "azure-openai-responses",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "not_exposed",
		source: "mesmo caminho de openai-responses-shared.ts.",
	},
	{
		api: "openai-codex-responses",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "not_exposed",
		source: "mesmo caminho de openai-responses-shared.ts.",
	},
	{
		api: "google-generative-ai",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "not_exposed",
		source: "api/google-generative-ai.ts: thoughtsTokenCount e cachedContentTokenCount; cacheWrite fixo em 0.",
	},
	{
		api: "google-vertex",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "not_exposed",
		source: "mesmo caminho de google-generative-ai (cacheWrite não emitido).",
	},
	{
		api: "agy-acp",
		reasoning_tokens: "exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "exposed",
		source:
			"providers/agy/usage.ts: thoughtTokens, cachedReadTokens e cachedWriteTokens presentes no usage do session/prompt do probe de 2026-11-24.",
	},
	{
		api: "faux",
		reasoning_tokens: "not_exposed",
		cache_read_tokens: "exposed",
		cache_write_tokens: "exposed",
		source: "api/faux: usage é estimativa (texto/4), sem reasoning. Somente teste.",
		test_only: true,
	},
];

/** Linha de transporte para o `api` de uma mensagem. Identificadores faux:* usam a linha `faux`. */
export function transportFor(api: string): TransportCapability | undefined {
	const key = api.startsWith("faux:") ? "faux" : api;
	return PI_TRANSPORT_CAPABILITIES.find((row) => row.api === key);
}
