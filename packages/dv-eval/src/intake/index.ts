// Ponto de entrada do módulo de intake e gate offline de integridade.
export {
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
