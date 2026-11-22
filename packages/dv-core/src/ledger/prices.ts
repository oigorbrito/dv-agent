// Custo por chamada com base explícita. Preço desconhecido vira null com cost_basis "unknown", nunca zero
// (contract v4, regra b). Sessão de assinatura não é cobrada por token: cost_usd null com basis "subscription_session".
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Preço em USD por 1M tokens. */
export interface PriceEntry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
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
	const rates = book.entries[`${message.provider}/${message.model}`];
	if (rates === undefined) return null;
	const u = message.usage;
	const usd =
		(u.input * rates.input +
			u.output * rates.output +
			u.cacheRead * rates.cacheRead +
			u.cacheWrite * rates.cacheWrite) /
		1_000_000;
	return { usd, basis: `price_book:${book.id}` };
}
