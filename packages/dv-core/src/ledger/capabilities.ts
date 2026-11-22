// Tabela de capacidades do contrato v4 (regra b): como derivar uncached_input_tokens por provedor e se o provedor pode executar.
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
 * `approvedProbes` contém os provedores cujo probe foi aprovado por evidência versionada.
 */
export function assertProviderCanRun(provider: string, approvedProbes: ReadonlySet<string>): void {
	const capability = capabilityFor(provider);
	if (capability?.status === "PROVISIONAL_PROBE_REQUIRED" && !approvedProbes.has(provider)) {
		throw new Error(`provedor ${provider} com capacidade PROVISIONAL sem probe aprovado (contract v4, regra b)`);
	}
}
