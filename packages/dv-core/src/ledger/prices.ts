// Custo por chamada com base explícita. Preço desconhecido vira null com cost_basis "unknown", nunca zero
// (contract v4, regra b). Sessão de assinatura não é cobrada por token: cost_usd null com basis "subscription_session".
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Preço em USD por 1M tokens. */
export interface PriceEntry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Faixas por tamanho de entrada (pi-ai: a maior faixa atingida vale para a requisição inteira). */
	tiers?: readonly { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
}

/** Tabela de preços versionada. Chave: `provider/modelId`. */
export interface MeteredPriceBook {
	kind: "metered";
	id: string;
	source: string;
	entries: Readonly<Record<string, PriceEntry>>;
}

/** Sessão de assinatura (OAuth de plano): o custo marginal por token não é cobrado em USD. */
export interface SubscriptionPriceBook {
	kind: "subscription";
	id: string;
	source: string;
}

export type PriceBook = MeteredPriceBook | SubscriptionPriceBook;

/** usd null só com basis "subscription_session"; para preço desconhecido, costForMessage retorna null. */
export interface CallCost {
	usd: number | null;
	basis: string;
}

export const SUBSCRIPTION_BASIS = "subscription_session";

/**
 * Custo de uma chamada. Sessão de assinatura: usd null, basis subscription_session. Total reportado pelo provedor
 * quando existe (totalFromProvider); senão calcula pela tabela; sem nenhum dos dois, retorna null (desconhecido).
 */
export function costForMessage(message: AssistantMessage, book: PriceBook): CallCost | null {
	if (book.kind === "subscription") return { usd: null, basis: SUBSCRIPTION_BASIS };
	if (message.usage.cost.totalFromProvider === true) {
		return { usd: message.usage.cost.total, basis: "provider_reported" };
	}
	const entry = book.entries[`${message.provider}/${message.model}`];
	if (entry === undefined) return null;
	const u = message.usage;
	const rates = ratesFor(entry, u);
	// Escrita de cache de 1h custa 2x a entrada (regra do pi-ai, calculateCost). O resto da escrita é cache de 5 min.
	const longWrite = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
	const shortWrite = u.cacheWrite - longWrite;
	const usd =
		(u.input * rates.input +
			u.output * rates.output +
			u.cacheRead * rates.cacheRead +
			shortWrite * rates.cacheWrite +
			longWrite * rates.input * 2) /
		1_000_000;
	return { usd, basis: `price_book:${book.id}` };
}

/**
 * Taxas da requisição. Como no pi-ai (calculateCost): a faixa de maior limite já atingido pela entrada inteira
 * (input + cache de leitura + cache de escrita) vale para a requisição toda. Sem faixa atingida, vale a base.
 */
function ratesFor(entry: PriceEntry, u: AssistantMessage["usage"]): Omit<PriceEntry, "tiers"> {
	const inputTokens = u.input + u.cacheRead + u.cacheWrite;
	let selected: Omit<PriceEntry, "tiers"> = entry;
	let matched = -1;
	for (const tier of entry.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			selected = tier;
			matched = tier.inputTokensAbove;
		}
	}
	return selected;
}
