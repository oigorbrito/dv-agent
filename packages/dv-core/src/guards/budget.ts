// Guarda de orçamento: soma o limite inferior de custo em message_end e corta a execução ao exceder o teto.
import type { AgentMessage, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { costForMessage, type PriceBook } from "../ledger/prices.ts";

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
		this.tokensTripped = false;
		this.maxTotalTokens = options.maxTotalTokens;
	}

	/** Chamar em message_end. Retorna true quando o chamador deve abortar a execução. */
	onMessageEnd(message: AgentMessage): boolean {
		if (message.role !== "assistant") return this.tripped || this.tokensTripped;
		const cost = costForMessage(message, this.priceBook);
		if (cost === null) {
			this.unknownCostCalls += 1;
		} else if (cost.usd === null) {
			this.nonMeteredCostCalls += 1;
		} else {
			this.spentLowerBoundUsd += cost.usd;
		}
		if (this.spentLowerBoundUsd > this.maxCostUsd) this.tripped = true;
		const u = message.usage;
		this.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
		if (this.maxTotalTokens !== undefined && this.totalTokens > this.maxTotalTokens) this.tokensTripped = true;
		return this.tripped || this.tokensTripped;
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
