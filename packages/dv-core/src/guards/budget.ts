// Guarda de orçamento: soma o limite inferior de custo em message_end e corta a execução ao exceder o teto.
import type { AgentMessage, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { costForMessage, type PriceBook, type PriceEntry } from "../ledger/prices.ts";

/** Margem de bytes para o overhead do provedor (cabeçalhos, schema de ferramentas, framing) na estimativa de entrada. */
const REQUEST_OVERHEAD_BYTES = 4096;

export type PreCallAllowance = { ok: true; maxTokens: number } | { ok: false; reason: string };

export interface BudgetOptions {
	maxCostUsd: number;
	priceBook: PriceBook;
	/**
	 * Teto de tokens (prompt + completion) do degrau. Ao excedê-lo, o degrau para com budget_exceeded, mas o
	 * ceiling_status continua sendo só de custo (contract v4, regra c): token não altera a verificação de teto em USD.
	 */
	maxTotalTokens?: number;
}

/**
 * "exceeded": o limite inferior já passou do teto. "unverifiable": há chamada com custo desconhecido ou não
 * medido em USD (sessão de assinatura), então o teto não pode ser declarado cumprido. "within_verified": todos
 * os custos são medidos em USD e estão dentro do teto.
 */
export type CeilingStatus = "within_verified" | "exceeded" | "unverifiable";

/** Interceptor de message_end (custo) e before_tool_call (bloqueia ferramentas após o corte). */
export class BudgetGuard {
	readonly maxCostUsd: number;
	spentLowerBoundUsd: number;
	unknownCostCalls: number;
	/** Chamadas de sessão de assinatura: sem custo em USD, não somam ao gasto. */
	nonMeteredCostCalls: number;
	blockedTools: number;
	tripped: boolean;
	/**
	 * Gasto conservador: para cada chamada, o maior entre o custo de tabela e o custo com faixas do pi-ai.
	 * Não entra no ledger (que segue o custo de tabela); serve de base ao gate pré-chamada, para que o teto
	 * valha também para contextos que cruzam faixas de preço.
	 */
	conservativeSpentUsd: number;
	/**
	 * Prefixo medido da última chamada: tokens reais (entrada + saída) e número de mensagens do contexto daquela
	 * requisição mais a resposta. O próximo contexto contém esse prefixo, então sua entrada é limitada por
	 * tokens_medidos + bytes da cauda nova. Sem prefixo (primeira chamada), usa-se o total em bytes.
	 */
	private prefix: { tokens: number; messages: number } | undefined;
	private pendingRequestMessages: number | undefined;
	/** Tokens acumulados (prompt + completion, como no ledger). */
	totalTokens: number;
	/** Teto de tokens excedido. Interrompe o degrau, mas não entra em ceilingStatus. */
	tokensTripped: boolean;
	readonly maxTotalTokens: number | undefined;
	private readonly priceBook: PriceBook;

	constructor(options: BudgetOptions) {
		this.maxCostUsd = options.maxCostUsd;
		this.priceBook = options.priceBook;
		this.spentLowerBoundUsd = 0;
		this.unknownCostCalls = 0;
		this.nonMeteredCostCalls = 0;
		this.blockedTools = 0;
		this.tripped = false;
		this.totalTokens = 0;
		this.conservativeSpentUsd = 0;
		this.tokensTripped = false;
		this.maxTotalTokens = options.maxTotalTokens;
	}

	/** Chamar quando uma requisição é de fato enviada ao provedor (após o gate). */
	beginRequest(context: Context): void {
		this.pendingRequestMessages = context.messages.length;
	}

	/** Chamar em message_end. Retorna true quando o chamador deve abortar a execução. */
	onMessageEnd(message: AgentMessage): boolean {
		if (message.role !== "assistant") return this.tripped || this.tokensTripped;
		if (this.pendingRequestMessages !== undefined) {
			const u = message.usage;
			this.prefix = {
				tokens: u.input + u.output + u.cacheRead + u.cacheWrite,
				messages: this.pendingRequestMessages + 1,
			};
			this.pendingRequestMessages = undefined;
		}
		const cost = costForMessage(message, this.priceBook);
		if (cost === null) {
			this.unknownCostCalls += 1;
		} else if (cost.usd === null) {
			this.nonMeteredCostCalls += 1;
		} else {
			this.spentLowerBoundUsd += cost.usd;
		}
		if (this.priceBook.kind === "metered") {
			const tiered = message.usage.cost?.total;
			const tieredUsd = typeof tiered === "number" && Number.isFinite(tiered) ? tiered : 0;
			this.conservativeSpentUsd += Math.max(cost?.usd ?? 0, tieredUsd);
		}
		if (this.spentLowerBoundUsd > this.maxCostUsd) this.tripped = true;
		const u = message.usage;
		this.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
		if (this.maxTotalTokens !== undefined && this.totalTokens > this.maxTotalTokens) this.tokensTripped = true;
		return this.tripped || this.tokensTripped;
	}

	/**
	 * Gate pré-chamada. Limita a entrada pelo maior preço possível e a saída pelo saldo restante, de modo que o
	 * custo máximo desta chamada não ultrapasse o que resta do teto. Sem preço conhecido, não há projeção (ver abaixo).
	 * Sessão de assinatura não tem teto em USD: passa sem limite de custo.
	 */
	preCallAllowance(model: Model<Api>, context: Context, requestedMaxTokens?: number): PreCallAllowance {
		if (this.priceBook.kind !== "metered") {
			return { ok: true, maxTokens: requestedMaxTokens ?? model.maxTokens };
		}
		const entry = this.priceBook.entries[`${model.provider}/${model.id}`];
		// Preço desconhecido: sem projeção em USD. A chamada segue e o custo fica "desconhecido" (contract v4, regra b).
		if (entry === undefined) return { ok: true, maxTokens: requestedMaxTokens ?? model.maxTokens };
		const { maxIn, maxOut } = worstRates(entry);
		const inputUsd = (this.inputTokensUpperBound(context) * maxIn) / 1_000_000;
		const remaining = this.maxCostUsd - this.conservativeSpentUsd - inputUsd;
		if (remaining <= 0) {
			return { ok: false, reason: `entrada projetada ${inputUsd.toFixed(6)} USD excede o saldo do teto` };
		}
		const outputByBudget = maxOut > 0 ? Math.floor((remaining * 1_000_000) / maxOut) : Number.POSITIVE_INFINITY;
		const maxTokens = Math.min(outputByBudget, model.maxTokens, requestedMaxTokens ?? Number.POSITIVE_INFINITY);
		if (maxTokens < 1) return { ok: false, reason: "saldo do teto insuficiente para saída mínima" };
		return { ok: true, maxTokens };
	}

	/**
	 * Limite superior de tokens de entrada da próxima requisição. Primeira chamada: bytes UTF-8 do pedido inteiro
	 * (um token nunca ocupa menos de um byte nesta estimativa). Chamadas seguintes: tokens medidos do prefixo
	 * mais bytes da cauda nova, com margem de 16 tokens por mensagem para a fronteira entre trechos.
	 */
	private inputTokensUpperBound(context: Context): number {
		if (this.prefix !== undefined && context.messages.length >= this.prefix.messages) {
			const tail = context.messages.slice(this.prefix.messages);
			const tailBytes = Buffer.byteLength(JSON.stringify(tail), "utf8");
			return this.prefix.tokens + tailBytes + 16 * tail.length + 64;
		}
		const wholeBytes = Buffer.byteLength(
			JSON.stringify({ s: context.systemPrompt ?? "", m: context.messages, t: context.tools ?? [] }),
			"utf8",
		);
		return wholeBytes + REQUEST_OVERHEAD_BYTES;
	}

	beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
		if (!this.tripped && !this.tokensTripped) return undefined;
		this.blockedTools += 1;
		const reason = this.tripped
			? `limite inferior ${this.spentLowerBoundUsd.toFixed(6)} USD > teto ${this.maxCostUsd} USD`
			: `${this.totalTokens} tokens > teto ${this.maxTotalTokens}`;
		return { block: true, reason: `budget_exceeded: ${reason} (${context.toolCall.name} bloqueada)` };
	}

	ceilingStatus(): CeilingStatus {
		if (this.tripped) return "exceeded";
		return this.unknownCostCalls === 0 && this.nonMeteredCostCalls === 0 ? "within_verified" : "unverifiable";
	}
}

/** Maiores taxas (USD/1M) possíveis entre a tabela base e todas as faixas, incluindo escrita de cache de 1h (2x). */
function worstRates(entry: PriceEntry): { maxIn: number; maxOut: number } {
	const rows = [entry, ...(entry.tiers ?? [])];
	let maxIn = 0;
	let maxOut = 0;
	for (const r of rows) {
		maxIn = Math.max(maxIn, r.input, r.cacheRead, r.cacheWrite, 2 * r.input);
		maxOut = Math.max(maxOut, r.output);
	}
	return { maxIn, maxOut };
}
