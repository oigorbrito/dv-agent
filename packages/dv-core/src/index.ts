// API pública do dv-core: ledger dv-run-ledger-v2, guards, router e execução de um degrau.
export { CONTRACT_FILE, CONTRACT_ID, LEDGER_SCHEMA } from "./contract.ts";
export { BudgetGuard, type BudgetOptions, type CeilingStatus } from "./guards/budget.ts";
export { type BeforeToolCallHook, composeBeforeToolCall } from "./guards/compose.ts";
export { DoomLoopDetector, type DoomLoopOptions } from "./guards/doom_loop.ts";
export { argumentsSha256 } from "./guards/tool_signature.ts";
export {
	assertProviderCanRun,
	capabilityFor,
	type FieldExposure,
	PI_TRANSPORT_CAPABILITIES,
	type TransportCapability,
	transportFor,
} from "./ledger/capabilities.ts";
export { type ConformanceReport, type ConformanceStatus, checkLedgerConformance } from "./ledger/conformance.ts";
export type { LimitReason, RouteDecidedPayload, RunStatus } from "./ledger/events.ts";
export type { PriceBook, PriceEntry } from "./ledger/prices.ts";
export {
	classifyProviderError,
	type ProviderErrorClassification,
	redactText,
	redactValue,
	sanitizeProviderErrorMessage,
} from "./ledger/redact.ts";
export { buildCallTelemetry, type CallTelemetry } from "./ledger/telemetry.ts";
export { type DeclaredToolCall, ToolOutcomeTracker } from "./ledger/tool_outcomes.ts";
export {
	type ClientIdentity,
	DV_CLIENT_IDENTITY,
	DV_USER_AGENT,
	dvHttpHeaders,
	isCloudflareBlocked,
} from "./ledger/transport_identity.ts";
export { ledgerSha256, RunLedger } from "./ledger/writer.ts";
// Provedor agy (ACP sobre stdio): cliente, framing JSON-RPC, usage e adaptador de StreamFn.
export {
	ACP_PROTOCOL_VERSION,
	AcpClient,
	AGY_DEFAULT_COMMAND,
	defaultSpawn,
	type ProcessLike,
	type SpawnFn,
	sanitizeTransportMessage,
} from "./providers/agy/acp_client.ts";
export { JsonRpcConnection, JsonRpcError, TransportError } from "./providers/agy/jsonrpc.ts";
export {
	AGY_API,
	AGY_MODELS,
	AGY_PROVIDER,
	type AgyStreamOptions,
	agyModel,
	createAgyStreamFn,
	isAgyModel,
	mapStopReason,
	promptFromContext,
} from "./providers/agy/stream.ts";
export { AGY_USAGE_FIELDS, mapAgyUsage } from "./providers/agy/usage.ts";
export {
	ArchitectEditorPolicy,
	type Attempt,
	DEFAULT_ESCALATE_ON_STATUSES,
	ExecutionGuidedLadderPolicy,
	type LadderOptions,
	type ModelRef,
	type RouterDecision,
	type RouterPolicy,
	type RungSpec,
	SingleModelPolicy,
	type StopOutcome,
	type Verification,
	type VerificationStatus,
} from "./router/policy.ts";
export { PredictiveHarnessRouterPolicy, type PredictiveRouterOptions } from "./router/predictive.ts";
export { extractPythonSignals, type SourceFile, type StaticSignals } from "./router/signals.ts";
export { classifyVerification, type OracleVerdict, type RunSignals } from "./router/verification.ts";
export { executeRung, type RungRunOptions, type RungRunResult } from "./run/execute_rung.ts";
export { type AgyMockMode, type AgyMockOptions, createAgyMockSpawn, FakeAgyChild } from "./testing/agy_mock.ts";
// Runtime faux (provider mockado com usage declarado): testes e smoke offline. Não usar em runs reais.
export { type FauxRuntime, fauxRuntime, type Turn, textTurn, toolTurn, usage } from "./testing/faux_runtime.ts";
export { assertCommandAllowed, resolveInWorkspace, WorkspaceViolation } from "./tools/confinement.ts";
export {
	atomicWriteFile,
	createWorkspaceTools,
	truncateHeadTail,
	type WorkspaceToolsOptions,
} from "./tools/workspace_tools.ts";
