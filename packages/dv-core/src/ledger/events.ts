// Payloads tipados dos eventos do ledger dv-run-ledger-v2 (o campo `schema` e `event` são acrescentados pelo writer).
import type { CallTelemetry } from "./telemetry.ts";

export type RunStatus = "completed" | "budget_exceeded" | "provider_error" | "aborted";

export interface RunStartedPayload {
	run_id: string;
	contract_id: string;
	harness_variant: string;
	reference_provenance: Record<string, string>;
	dataset_sha256: string;
	task_definition_sha256: string;
	model: { provider: string; model_id: string; api: string };
	max_cost_usd: number;
	guards: { doom_loop_max_identical_consecutive: number };
}

export interface CallStartedPayload {
	call_index: number;
	provider: string;
	model_id: string;
	api: string;
}

export interface CallRecord {
	stop_reason: string;
	error_message?: string;
	usage: { input: number; output: number; cache_read: number; cache_write: number; total: number };
	telemetry: CallTelemetry;
	tool_calls: { tool_call_id: string; tool_name: string; arguments_sha256: string }[];
}

export interface CallFinishedPayload {
	call_index: number;
	record: CallRecord;
}

export interface ToolFinishedPayload {
	tool_call_id: string;
	tool_name: string;
	arguments_sha256: string;
	/** not_executed: a chamada foi declarada pelo modelo, mas a run terminou antes de executá-la (ex.: corte de orçamento). */
	status: "ok" | "error" | "blocked" | "not_executed";
	block_reason?: string;
	raw_output: string;
	raw_output_sha256: string;
}

export interface RunFinishedPayload {
	status: RunStatus;
	calls_started: number;
	calls_finished: number;
	in_flight_call_indices: number[];
	spent_lower_bound_usd: number;
	unknown_cost_calls: number;
	ceiling_status: "within_verified" | "exceeded" | "unverifiable";
	guard_events: { doom_loop_blocks: number; budget_blocked_tools: number };
}
