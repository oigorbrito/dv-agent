// Deterministic lexical + structural k-NN predictor. Calibration-only examples; holdout IDs are rejected.
import type { SourceFile, StaticSignals } from "./signals.ts";

export interface TaskFeatureVector {
	lexical: ReadonlyMap<string, number>;
	files: number;
	loc: number;
	importDepth: number;
}
export interface KnnExample {
	taskId: string;
	partition: "calibration";
	features: TaskFeatureVector;
	failedRung0: boolean;
}
export interface KnnNeighbor {
	taskId: string;
	similarity: number;
	failedRung0: boolean;
}
export interface KnnPrediction {
	startRung: 0 | 1;
	reasonCode:
		| "knn_insufficient_evidence_fallback_rung0"
		| "knn_high_failure_risk_skip_rung0"
		| "knn_low_failure_risk_rung0";
	neighbors: KnnNeighbor[];
	weightedFailureRate: number | null;
	weightSum: number;
	k: number;
	theta: number;
}

const TOKENS = /[\p{L}\p{N}_]+/gu;
const STOP = new Set(
	"a an and are as at be by for from in into is it of on or that the to with do no not um uma uns umas de da das dos e em para por com no na nos nas que se ao aos ou como".split(
		/\s+/u,
	),
);
function tokenize(text: string): string[] {
	return (text.normalize("NFKC").toLocaleLowerCase("en-US").match(TOKENS) ?? []).filter(
		(t) => t.length > 1 && !STOP.has(t),
	);
}
export function extractTaskFeatures(
	spec: string,
	files: readonly SourceFile[],
	signals: StaticSignals,
): TaskFeatureVector {
	const terms = tokenize(spec);
	const counts = new Map<string, number>();
	for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
	const norm = Math.sqrt([...counts.values()].reduce((sum, n) => sum + n * n, 0)) || 1;
	const lexical = new Map([...counts].map(([term, n]) => [term, n / norm]));
	const workspaceTokens = tokenize(
		files
			.filter((f) => f.path.endsWith(".py"))
			.map((f) => `${f.path} ${f.content}`)
			.join(" "),
	);
	const wsCounts = new Map<string, number>();
	for (const term of workspaceTokens) wsCounts.set(term, (wsCounts.get(term) ?? 0) + 1);
	const wsNorm = Math.sqrt([...wsCounts.values()].reduce((sum, n) => sum + n * n, 0)) || 1;
	for (const [term, n] of wsCounts) lexical.set(`ws:${term}`, n / wsNorm);
	return {
		lexical,
		files: Math.min(1, signals.source_files / 20),
		loc: Math.min(1, signals.loc / 2000),
		importDepth: Math.min(1, signals.import_depth / 10),
	};
}
function cosine(a: TaskFeatureVector, b: TaskFeatureVector): number {
	let dot = a.files * b.files + a.loc * b.loc + a.importDepth * b.importDepth;
	let na = a.files ** 2 + a.loc ** 2 + a.importDepth ** 2;
	let nb = b.files ** 2 + b.loc ** 2 + b.importDepth ** 2;
	for (const [key, value] of a.lexical) {
		dot += value * (b.lexical.get(key) ?? 0);
		na += value ** 2;
	}
	for (const value of b.lexical.values()) nb += value ** 2;
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
export class KnnRoutingPredictor {
	readonly examples: readonly KnnExample[];
	readonly calibrationIds: ReadonlySet<string>;
	readonly holdoutIds: ReadonlySet<string>;
	readonly k: number;
	readonly nMin: number;
	readonly theta: number;
	readonly minWeight: number;
	constructor(
		examples: readonly KnnExample[],
		calibrationIds: ReadonlySet<string>,
		holdoutIds: ReadonlySet<string>,
		k = 3,
		nMin = 3,
		theta = 0.67,
		minWeight = 0.01,
	) {
		if (
			examples.some((e) => e.partition !== "calibration" || !calibrationIds.has(e.taskId) || holdoutIds.has(e.taskId))
		)
			throw new Error("k-NN leakage: exemplars must belong exclusively to calibration partition");
		if (!Number.isInteger(k) || k < 1 || !Number.isInteger(nMin) || nMin < 1 || theta < 0 || theta > 1 || minWeight < 0)
			throw new Error("invalid k-NN parameters");
		this.examples = [...examples];
		this.calibrationIds = calibrationIds;
		this.holdoutIds = holdoutIds;
		this.k = k;
		this.nMin = nMin;
		this.theta = theta;
		this.minWeight = minWeight;
	}
	predict(taskId: string, features: TaskFeatureVector): KnnPrediction {
		if (this.holdoutIds.has(taskId)) {
			/* target holdout is permitted; only exemplar leakage is forbidden */
		}
		const neighbors = this.examples
			.filter((e) => e.taskId !== taskId)
			.map((e) => ({ taskId: e.taskId, similarity: cosine(features, e.features), failedRung0: e.failedRung0 }))
			.filter((n) => n.similarity > 0)
			.sort((a, b) => b.similarity - a.similarity || a.taskId.localeCompare(b.taskId))
			.slice(0, this.k);
		const weightSum = neighbors.reduce((s, n) => s + n.similarity, 0);
		const weightedFailureRate = weightSum
			? neighbors.reduce((s, n) => s + n.similarity * (n.failedRung0 ? 1 : 0), 0) / weightSum
			: null;
		const sufficient = neighbors.length >= this.nMin && weightSum >= this.minWeight;
		const startRung = sufficient && weightedFailureRate !== null && weightedFailureRate >= this.theta ? 1 : 0;
		return {
			startRung,
			reasonCode: !sufficient
				? "knn_insufficient_evidence_fallback_rung0"
				: startRung
					? "knn_high_failure_risk_skip_rung0"
					: "knn_low_failure_risk_rung0",
			neighbors,
			weightedFailureRate,
			weightSum,
			k: this.k,
			theta: this.theta,
		};
	}
}
