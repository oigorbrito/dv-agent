// Roteamento pré-execução: escolhe o degrau inicial antes da primeira chamada, a partir de sinais estáticos.
// O restante (promoção por oráculo) é delegado à ExecutionGuidedLadderPolicy, que fornece o fallback.

import { chooseEmpiricalStartRung, type EmpiricalFailureIndex, type EmpiricalRouteEvidence } from "./empirical.ts";
import {
	type Attempt,
	DEFAULT_ESCALATE_ON_STATUSES,
	ExecutionGuidedLadderPolicy,
	type RouterDecision,
	type RouterPolicy,
	type RungSpec,
	type VerificationStatus,
} from "./policy.ts";

export interface PredictiveRouterOptions {
	/** Degraus do mais econômico ao mais forte. O último é o modelo forte. */
	rungs: readonly RungSpec[];
	globalMaxCostUsd: number;
	/** Índice construído exclusivamente com observações da partição de calibração. Ausente = fallback no degrau 0. */
	history?: EmpiricalFailureIndex;
	taskId: string;
	category: string;
	nMin?: number;
	failureThreshold?: number;
	escalateOnStatuses?: readonly VerificationStatus[];
}

export class PredictiveHarnessRouterPolicy implements RouterPolicy {
	readonly name = "predictive_harness_router";
	readonly version = 2;
	/** Degrau escolhido para a primeira tentativa. Fixado no construtor, antes de qualquer chamada. */
	readonly startRung: number;
	/** Motivo legível da escolha, gravado no ledger como `route_decided.reason`. */
	readonly reason: string;
	readonly routeEvidence: EmpiricalRouteEvidence;
	private readonly ladder: ExecutionGuidedLadderPolicy;

	constructor(options: PredictiveRouterOptions) {
		if (options.rungs.length === 0) throw new Error("predictive: sem degraus");
		const rung0 = options.rungs[0];
		if (rung0 === undefined) throw new Error("predictive: sem degrau 0");
		const selected = chooseEmpiricalStartRung(options.history, {
			taskId: options.taskId,
			category: options.category,
			model: `${rung0.model.provider}/${rung0.model.modelId}`,
			rungCount: options.rungs.length,
			...(options.nMin === undefined ? {} : { nMin: options.nMin }),
			...(options.failureThreshold === undefined ? {} : { failureThreshold: options.failureThreshold }),
		});
		this.routeEvidence = selected;
		this.startRung = selected.start_rung;
		this.reason = selected.reason;
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
