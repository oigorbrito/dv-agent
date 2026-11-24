// Usage do session/prompt do ACP para o formato do pi-ai (e daí para os baldes do contrato v4).
// Mapeamento observado (probe 2026-11-24): totalTokens = inputTokens + outputTokens com cache zerado;
// thoughtTokens (117) é subconjunto de outputTokens (118), como Usage.reasoning do pi-ai.
// NÃO assumido: se cachedReadTokens faz parte de inputTokens. Por isso o agy fica PROVISIONAL no contrato (regra b).
import type { Usage } from "@earendil-works/pi-ai";

export const AGY_USAGE_FIELDS = [
	"inputTokens",
	"outputTokens",
	"cachedReadTokens",
	"cachedWriteTokens",
	"thoughtTokens",
	"totalTokens",
] as const;

/** Usage cru de um turno, como o agy envia (valores ainda não validados). */
export interface AgyTurnUsage {
	inputTokens: unknown;
	outputTokens: unknown;
	cachedReadTokens: unknown;
	cachedWriteTokens: unknown;
	thoughtTokens: unknown;
	totalTokens: unknown;
}

export interface AgyUsageMapping {
	usage: Usage;
	/** Campos obrigatórios ausentes ou inválidos. Vazio = medição completa. */
	missing: string[];
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Mapeia o usage cru. Campo ausente vira 0 no Usage e entra em `missing`: nunca é tratado como medição. */
export function mapAgyUsage(raw: unknown): AgyUsageMapping {
	const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const missing: string[] = [];
	const read = (field: (typeof AGY_USAGE_FIELDS)[number]): number => {
		const value = count(source[field]);
		if (value === undefined) {
			missing.push(field);
			return 0;
		}
		return value;
	};
	const input = read("inputTokens");
	const output = read("outputTokens");
	const cacheRead = read("cachedReadTokens");
	const cacheWrite = read("cachedWriteTokens");
	const thought = read("thoughtTokens");
	const total = read("totalTokens");
	return {
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: total,
			// Usage.reasoning é subconjunto de output no pi-ai; só é declarado quando o campo veio.
			...(missing.includes("thoughtTokens") ? {} : { reasoning: thought }),
			// Custo não vem do agy: sessão de login local, sem preço por token no catálogo.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
		},
		missing,
	};
}
