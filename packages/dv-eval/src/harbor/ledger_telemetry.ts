export interface HarborLedgerTelemetry {
	inputTokens?: number;
	outputTokens?: number;
	cacheTokens?: number;
	costUsd: number | null;
	complete: boolean;
	runStatus: string;
}

type LedgerEvent = Record<string, unknown>;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Aggregate Harbor-native usage fields from the closed DV ledger without imputing missing values. */
export function aggregateHarborLedgerTelemetry(events: readonly LedgerEvent[]): HarborLedgerTelemetry {
	const calls = events
		.filter((event) => event.event === "call_finished")
		.map((event) => {
			const record = event.record;
			if (!record || typeof record !== "object" || Array.isArray(record)) {
				throw new Error("DV ledger call_finished event has no record object");
			}
			const telemetry = (record as Record<string, unknown>).telemetry;
			if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) {
				throw new Error("DV ledger call_finished event has no telemetry object");
			}
			return telemetry as Record<string, unknown>;
		});
	const usageReported =
		calls.length > 0 &&
		calls.every((call) => {
			const missing = Array.isArray(call.missing_buckets) ? call.missing_buckets : [];
			return (
				!missing.includes("usage_not_reported") &&
				!missing.includes("usage_incomplete") &&
				isFiniteNumber(call.prompt_tokens) &&
				isFiniteNumber(call.completion_tokens)
			);
		});
	const inputTokens = usageReported
		? calls.reduce((sum, call) => sum + (call.prompt_tokens as number), 0)
		: undefined;
	const outputTokens = usageReported
		? calls.reduce((sum, call) => sum + (call.completion_tokens as number), 0)
		: undefined;
	const cacheReported =
		calls.length > 0 &&
		calls.every((call) => {
			const missing = Array.isArray(call.missing_buckets) ? call.missing_buckets : [];
			return (
				!missing.includes("usage_not_reported") &&
				!missing.includes("usage_incomplete") &&
				isFiniteNumber(call.cache_read_tokens)
			);
		});
	const cacheTokens = cacheReported
		? calls.reduce((sum, call) => sum + (call.cache_read_tokens as number), 0)
		: undefined;

	const finished = events.find((event) => event.event === "run_finished");
	if (!finished || typeof finished.status !== "string") {
		throw new Error("DV ledger has no final run_finished status");
	}
	const costVerified =
		calls.length > 0 &&
		finished.ceiling_status === "within_verified" &&
		finished.unknown_cost_calls === 0 &&
		finished.non_metered_cost_calls === 0 &&
		isFiniteNumber(finished.spent_lower_bound_usd);
	return {
		inputTokens,
		outputTokens,
		cacheTokens,
		costUsd: costVerified ? (finished.spent_lower_bound_usd as number) : null,
		complete: calls.length > 0 && calls.every((call) => call.telemetry_complete === true),
		runStatus: finished.status,
	};
}
