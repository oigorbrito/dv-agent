import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateHarborLedgerTelemetry } from "../src/harbor/ledger_telemetry.ts";

function call(telemetry: Record<string, unknown>): Record<string, unknown> {
	return { event: "call_finished", record: { telemetry } };
}

function finished(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		event: "run_finished",
		status: "completed",
		ceiling_status: "within_verified",
		unknown_cost_calls: 0,
		non_metered_cost_calls: 0,
		spent_lower_bound_usd: 0.002,
		...overrides,
	};
}

test("aggregates measured input, output, cache-read and verified cost", () => {
	const result = aggregateHarborLedgerTelemetry([
		call({
			prompt_tokens: 100,
			completion_tokens: 20,
			cache_read_tokens: 30,
			telemetry_complete: true,
			missing_buckets: [],
		}),
		call({
			prompt_tokens: 50,
			completion_tokens: 10,
			cache_read_tokens: 5,
			telemetry_complete: true,
			missing_buckets: [],
		}),
		finished(),
	]);
	assert.deepEqual(result, {
		inputTokens: 150,
		outputTokens: 30,
		cacheTokens: 35,
		costUsd: 0.002,
		complete: true,
		runStatus: "completed",
	});
});

test("missing provider usage stays null instead of becoming zero", () => {
	const result = aggregateHarborLedgerTelemetry([
		call({
			prompt_tokens: 0,
			completion_tokens: 0,
			cache_read_tokens: 0,
			telemetry_complete: false,
			missing_buckets: ["usage_not_reported"],
		}),
		finished({
			status: "provider_error",
			ceiling_status: "unverifiable",
			unknown_cost_calls: 1,
			spent_lower_bound_usd: 0,
		}),
	]);
	assert.deepEqual(result, {
		inputTokens: undefined,
		outputTokens: undefined,
		cacheTokens: undefined,
		costUsd: null,
		complete: false,
		runStatus: "provider_error",
	});
});

test("cache-read usage remains null if any transport does not expose it", () => {
	const result = aggregateHarborLedgerTelemetry([
		call({
			prompt_tokens: 10,
			completion_tokens: 2,
			cache_read_tokens: null,
			telemetry_complete: false,
			missing_buckets: ["cache_read_tokens"],
		}),
		finished(),
	]);
	assert.equal(result.inputTokens, 10);
	assert.equal(result.outputTokens, 2);
	assert.equal(result.cacheTokens, undefined);
	assert.equal(result.costUsd, 0.002);
	assert.equal(result.complete, false);
});

test("a trial with no model calls does not report zero usage or cost", () => {
	const result = aggregateHarborLedgerTelemetry([finished()]);
	assert.equal(result.inputTokens, undefined);
	assert.equal(result.outputTokens, undefined);
	assert.equal(result.cacheTokens, undefined);
	assert.equal(result.costUsd, null);
	assert.equal(result.complete, false);
});

test("rejects a ledger without terminal run_finished status", () => {
	assert.throws(
		() =>
			aggregateHarborLedgerTelemetry([
				call({
					prompt_tokens: 1,
					completion_tokens: 1,
					cache_read_tokens: 0,
					telemetry_complete: true,
					missing_buckets: [],
				}),
			]),
		/DV ledger has no final run_finished status/,
	);
});
