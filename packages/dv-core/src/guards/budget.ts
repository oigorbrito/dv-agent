// Guarda de orçamento: soma o limite inferior de custo em message_end e corta a execução ao exceder o teto.
import type { AgentMessage, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { costForMessage, type PriceBook } from "../ledger/prices.ts";

export interface BudgetOptions {
	maxCostUsd: number;
	priceBook: PriceBook;
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
	private readonly priceBook: PriceBook;

	constructor(options: BudgetOptions) {
		this.maxCostUsd = options.maxCostUsd;
		this.priceBook = options.priceBook;
		this.spentLowerBoundUsd = 0;
		this.unknownCostCalls = 0;
		this.nonMeteredCostCalls = 0;
		this.blockedTools = 0;
		this.tripped = false;
	}

	/** Chamar em message_end. Retorna true quando o chamador deve abortar a execução. */
	onMessageEnd(message: AgentMessage): boolean {
		if (message.role !== "assistant") return this.tripped;
		const cost = costForMessage(message, this.priceBook);
		if (cost === null) {
			this.unknownCostCalls += 1;
		} else if (cost.usd === null) {
			this.nonMeteredCostCalls += 1;
		} else {
			this.spentLowerBoundUsd += cost.usd;
		}
		if (this.spentLowerBoundUsd > this.maxCostUsd) this.tripped = true;
		return this.tripped;
	}

	beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
		if (!this.tripped) return undefined;
		this.blockedTools += 1;
		return {
			block: true,
			reason: `budget_exceeded: limite inferior ${this.spentLowerBoundUsd.toFixed(6)} USD > teto ${this.maxCostUsd} USD (${context.toolCall.name} bloqueada)`,
		};
	}

	ceilingStatus(): CeilingStatus {
		if (this.tripped) return "exceeded";
		return this.unknownCostCalls === 0 && this.nonMeteredCostCalls === 0 ? "within_verified" : "unverifiable";
	}
}
