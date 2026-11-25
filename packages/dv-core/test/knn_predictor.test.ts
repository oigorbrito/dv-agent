import assert from "node:assert/strict";
import test from "node:test";
import {
	type EmpiricalFailureIndex,
	extractPythonSignals,
	extractTaskFeatures,
	KnnRoutingPredictor,
	PredictiveHarnessRouterPolicy,
} from "../src/index.ts";

const CAL_IDS = new Set(["cal-1", "cal-2", "cal-3", "cal-4"]);
const HOLD_IDS = new Set(["hold-1"]);

function makeFeatures(spec: string, code: string) {
	const files = [
		{ path: "SPEC.md", content: spec },
		{ path: "mod.py", content: code },
	];
	return extractTaskFeatures(spec, files, extractPythonSignals(files));
}

test("k-NN: rejeita exemplares fora da partição calibration (anti-data leakage)", () => {
	const leakExample = {
		taskId: "hold-1",
		partition: "calibration" as const,
		features: makeFeatures("parse ini config", "def parse(): pass"),
		failedRung0: true,
	};
	assert.throws(() => new KnnRoutingPredictor([leakExample], CAL_IDS, HOLD_IDS), /k-NN leakage/i);
});

test("k-NN: fallback para startRung=0 quando vizinhos válidos < nMin", () => {
	const examples = [
		{
			taskId: "cal-1",
			partition: "calibration" as const,
			features: makeFeatures("raft consensus", "def vote(): pass"),
			failedRung0: true,
		},
		{
			taskId: "cal-2",
			partition: "calibration" as const,
			features: makeFeatures("raft log", "def append(): pass"),
			failedRung0: true,
		},
	];
	const predictor = new KnnRoutingPredictor(examples, CAL_IDS, HOLD_IDS, 3, 3, 0.67);
	const pred = predictor.predict("hold-1", makeFeatures("raft state machine", "def tick(): pass"));
	assert.equal(pred.startRung, 0);
	assert.equal(pred.reasonCode, "knn_insufficient_evidence_fallback_rung0");
});

test("k-NN: promove para startRung=1 quando vizinhos próximos falharam no rung 0 acima de theta", () => {
	const examples = [
		{
			taskId: "cal-1",
			partition: "calibration" as const,
			features: makeFeatures("hindley milner type infer", "def unify(): pass"),
			failedRung0: true,
		},
		{
			taskId: "cal-2",
			partition: "calibration" as const,
			features: makeFeatures("polymorphic type infer", "def subst(): pass"),
			failedRung0: true,
		},
		{
			taskId: "cal-3",
			partition: "calibration" as const,
			features: makeFeatures("occurs check type infer", "def occurs(): pass"),
			failedRung0: true,
		},
		{
			taskId: "cal-4",
			partition: "calibration" as const,
			features: makeFeatures("csv slug normalizer", "def slug(): pass"),
			failedRung0: false,
		},
	];
	const predictor = new KnnRoutingPredictor(examples, CAL_IDS, HOLD_IDS, 3, 3, 0.67);
	const targetFeatures = makeFeatures("incremental type infer occurs check", "def infer(): pass");
	const pred = predictor.predict("hold-1", targetFeatures);
	assert.equal(pred.startRung, 1);
	assert.equal(pred.reasonCode, "knn_high_failure_risk_skip_rung0");
	assert.equal(pred.neighbors.length, 3);

	const history: EmpiricalFailureIndex = {
		schema: "dv-empirical-failure-index-v1",
		partition: "calibration",
		sources: [],
		indexSha256: "0".repeat(64),
		observations: [],
		byTask: {},
		byCategory: {},
		knnExamples: examples,
		knnCalibrationIds: [...CAL_IDS],
		knnHoldoutIds: [...HOLD_IDS],
	};
	const policy = new PredictiveHarnessRouterPolicy({
		rungs: [
			{ model: { provider: "anthropic", modelId: "claude-haiku-5-5" }, costShareCap: 0.5 },
			{ model: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, costShareCap: 1 },
		],
		globalMaxCostUsd: 1,
		history,
		taskId: "hold-1",
		category: "frontier",
		taskFeatures: targetFeatures,
	});
	assert.equal(policy.startRung, 1);
	assert.equal(policy.knnEvidence?.startRung, 1);
});
