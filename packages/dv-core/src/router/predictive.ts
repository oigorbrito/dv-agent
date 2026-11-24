// Roteamento pré-execução: escolhe o degrau inicial antes da primeira chamada, a partir de sinais estáticos.
// O restante (promoção por oráculo) é delegado à ExecutionGuidedLadderPolicy, que fornece o fallback.

import {
	type Attempt,
	DEFAULT_ESCALATE_ON_STATUSES,
	ExecutionGuidedLadderPolicy,
	type RouterDecision,
	type RouterPolicy,
	type RungSpec,
	type VerificationStatus,
} from "./policy.ts";
import type { StaticSignals } from "./signals.ts";

export interface PredictiveRouterOptions {
	/** Degraus do mais econômico ao mais forte. O último é o modelo forte. */
	rungs: readonly RungSpec[];
	globalMaxCostUsd: number;
	signals: StaticSignals;
	/**
	 * Profundidade de import a partir da qual a tarefa começa direto no modelo forte. `null` desliga o atalho
	 * (todas as tarefas começam no degrau 0). Valor calibrado fora deste código, em partição de calibração.
	 */
	strongFromDepth: number | null;
	escalateOnStatuses?: readonly VerificationStatus[];
}

export class PredictiveHarnessRouterPolicy implements RouterPolicy {
	readonly name = "predictive_harness_router";
	/** Degrau escolhido para a primeira tentativa. Fixado no construtor, antes de qualquer chamada. */
	readonly startRung: number;
	/** Motivo legível da escolha, gravado no ledger como `route_decided.reason`. */
	readonly reason: string;
	private readonly ladder: ExecutionGuidedLadderPolicy;

	constructor(options: PredictiveRouterOptions) {
		if (options.rungs.length === 0) throw new Error("predictive: sem degraus");
		const threshold = options.strongFromDepth;
		if (threshold !== null && (!Number.isInteger(threshold) || threshold < 1)) {
			throw new Error(`strongFromDepth inválido: ${String(threshold)}`);
		}
		const depth = options.signals.import_depth;
		const direct = threshold !== null && depth >= threshold;
		this.startRung = direct ? options.rungs.length - 1 : 0;
		if (threshold === null) {
			this.reason = "sem limiar calibrado: começa no degrau econômico";
		} else if (direct) {
			this.reason = `profundidade de import ${depth} >= ${threshold}: começa direto no modelo forte`;
		} else {
			this.reason = `profundidade de import ${depth} < ${threshold}: começa no degrau econômico`;
		}
		this.ladder = new ExecutionGuidedLadderPolicy({
			rungs: options.rungs,
			globalMaxCostUsd: options.globalMaxCostUsd,
			startRung: this.startRung,
			escalateOnStatuses: options.escalateOnStatuses ?? DEFAULT_ESCALATE_ON_STATUSES,
		});
	}

	decide(history: readonly Attempt[]): RouterDecision {
		const decision = this.ladder.decide(history);
		if (history.length === 0 && decision.kind === "run") return { ...decision, route_reason: this.reason };
		return decision;
	}
}
