// Roteamento pré-execução: escolhe o degrau inicial antes da primeira chamada, a partir de sinais estáticos.
// O restante (promoção por oráculo) é delegado à ExecutionGuidedLadderPolicy, que fornece o fallback.

import { chooseEmpiricalStartRung, type EmpiricalFailureIndex, type EmpiricalRouteEvidence } from "./empirical.ts";
import { type KnnPrediction, KnnRoutingPredictor, type TaskFeatureVector } from "./knn_predictor.ts";
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
	taskFeatures?: TaskFeatureVector;
	knnK?: number;
	knnTheta?: number;
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
	readonly knnEvidence?: KnnPrediction;
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
		let finalStartRung = selected.start_rung;
		let finalReason = selected.reason;
		if (
			options.taskFeatures !== undefined &&
			options.history?.knnExamples !== undefined &&
			options.history.knnExamples.length > 0
		) {
			const calIds = new Set(options.history.knnCalibrationIds ?? options.history.knnExamples.map((e) => e.taskId));
			const holdIds = new Set(options.history.knnHoldoutIds ?? []);
			const predictor = new KnnRoutingPredictor(
				options.history.knnExamples,
				calIds,
				holdIds,
				options.knnK ?? 3,
				options.nMin ?? 3,
				options.knnTheta ?? options.failureThreshold ?? 0.67,
			);
			const knn = predictor.predict(options.taskId, options.taskFeatures);
			const hasSufficientKnn = knn.reasonCode !== "knn_insufficient_evidence_fallback_rung0";
			const gatedStartRung: 0 | 1 = hasSufficientKnn
				? knn.startRung === 1 && options.rungs.length > 1
					? 1
					: 0
				: selected.start_rung === 1
					? 1
					: 0;
			this.knnEvidence = { ...knn, startRung: gatedStartRung };
			finalStartRung = gatedStartRung;
			finalReason = hasSufficientKnn
				? `k-NN (${knn.reasonCode}, k=${knn.k}, vizinhos=${knn.neighbors.length}, taxa=${knn.weightedFailureRate === null ? "n/a" : knn.weightedFailureRate.toFixed(4)}, theta=${knn.theta}); startRung=${gatedStartRung}`
				: `${selected.reason} [k-NN fallback: ${knn.reasonCode}, vizinhos=${knn.neighbors.length}<${knn.k}]`;
		}
		this.startRung = finalStartRung;
		this.reason = finalReason;
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
