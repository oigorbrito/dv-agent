// Payloads tipados dos eventos do ledger dv-run-ledger-v2 (o campo `schema` e `event` são acrescentados pelo writer).
import type { CallTelemetry } from "./telemetry.ts";

/** limit_exceeded: teto de turnos ou de output do degrau (motivo em guard_events.limit_reason). */
export type RunStatus = "completed" | "budget_exceeded" | "limit_exceeded" | "provider_error" | "aborted";

/** Motivo explícito de corte por limite de turnos ou de output. */
export type LimitReason = "max_turns" | "max_output_tokens";

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

/** Decisão de roteamento tomada antes de um degrau (evento `route_decided`, no máximo um por ledger, logo após run_started). */
export interface RouteDecidedPayload {
	policy: string;
	rung: number;
	role: string;
	/** Motivo legível da escolha do degrau (ex.: profundidade de import abaixo do limiar). */
	reason: string;
	/** Sinais estáticos usados na decisão; null quando a política não usa sinais. */
	signals: { source_files: number; loc: number; import_depth: number } | null;
	/** Evidência histórica auditável do predictive router v2; nulo para políticas que não usam o índice. */
	empirical_evidence?: {
		partition: "calibration";
		sources: { path: string; sha256: string }[];
		index_sha256: string;
		match: "task" | "category" | "none";
		task_id: string;
		category: string;
		model: string;
		n: number;
		failures: number;
		failure_rate: number | null;
		n_min: number;
		failure_threshold: number;
		start_rung: number;
		reason: string;
	};
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
	non_metered_cost_calls: number;
	guard_events: { doom_loop_blocks: number; budget_blocked_tools: number; limit_reason: LimitReason | null };
}
