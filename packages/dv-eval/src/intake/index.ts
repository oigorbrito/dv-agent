// Ponto de entrada do módulo de intake e gate offline de integridade.
export {
	computeDatasetSha256,
	computeManifestSha256,
	computeStableFileSha256,
	type ExternalTaskDefinition,
	hashTaskFiles,
	type IntakeBatchResult,
	type IntakeGateResult,
	type IntakeManifest,
	type TaskManifestEntry,
	validateTaskIntake,
	validateTasksBatch,
} from "./intake_gate.ts";
export { applyUnifiedDiff, parseUnifiedDiff } from "./patch_applier.ts";
export {
	buildSliceManifest,
	loadVerifiedSlice,
	SLICE_SCHEMA,
	SLICE_TASKS_DIR,
	type SliceManifest,
	type SliceProvenance,
	type SliceTaskEntry,
	type SliceVerification,
	verifySliceManifest,
	writeSliceManifest,
} from "./slice.ts";
