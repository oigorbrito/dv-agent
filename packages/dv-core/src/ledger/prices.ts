// Custo por chamada com fonte explícita. Preço desconhecido vira null, nunca zero (contract v4, regra b: budget_rule).
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Preço em USD por 1M tokens. */
export interface PriceEntry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Tabela de preços versionada. `id` e `source` vão para o cost_basis do ledger. Chave: `provider/modelId`. */
export interface PriceBook {
	id: string;
	source: string;
	entries: Readonly<Record<string, PriceEntry>>;
}

export interface CallCost {
	usd: number;
	basis: string;
}

/**
 * Custo de uma chamada. Usa o total reportado pelo provedor quando existe (totalFromProvider);
 * senão calcula pela tabela de preços; sem nenhuma das duas, retorna null.
 */
export function costForMessage(message: AssistantMessage, book: PriceBook): CallCost | null {
	if (message.usage.cost.totalFromProvider === true) {
		return { usd: message.usage.cost.total, basis: "provider_reported" };
	}
	const rates = book.entries[`${message.provider}/${message.model}`];
	if (rates === undefined) return null;
	const u = message.usage;
	const usd =
		(u.input * rates.input + u.output * rates.output + u.cacheRead * rates.cacheRead + u.cacheWrite * rates.cacheWrite) /
		1_000_000;
	return { usd, basis: `price_book:${book.id}` };
}
