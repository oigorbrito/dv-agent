import assert from "node:assert/strict";
import { test } from "node:test";
import { emitHarborTelemetry } from "../src/tools/harbor_remote_tools.ts";

test("Harbor telemetry emits one JSONL frame with ledger provenance", () => {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;

	try {
		emitHarborTelemetry({
			runId: "trial-001",
			ledgerPath: "/tmp/trial-001.jsonl",
			ledgerSha256: "a".repeat(64),
			provider: "openai",
			model: "gpt-test",
			inputTokens: 120,
			outputTokens: 45,
			cacheTokens: null,
			costUsd: null,
			complete: false,
		});
	} finally {
		process.stdout.write = originalWrite;
	}

	assert.equal(chunks.length, 1);
	assert.ok(chunks[0].endsWith("\n"));
	const frame = JSON.parse(chunks[0]) as Record<string, unknown>;
	assert.deepEqual(frame, {
		type: "telemetry",
		run_id: "trial-001",
		ledger_path: "/tmp/trial-001.jsonl",
		ledger_sha256: "a".repeat(64),
		provider: "openai",
		model: "gpt-test",
		input_tokens: 120,
		output_tokens: 45,
		cache_tokens: null,
		cost_usd: null,
		complete: false,
	});
});

test("Harbor telemetry preserves missing usage and cost as null, never zero", () => {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;

	try {
		emitHarborTelemetry({
			runId: "trial-unknown",
			ledgerPath: "/tmp/trial-unknown.jsonl",
			ledgerSha256: "b".repeat(64),
			provider: "provider",
			model: "model",
			complete: false,
		});
	} finally {
		process.stdout.write = originalWrite;
	}

	const frame = JSON.parse(chunks[0]) as Record<string, unknown>;
	assert.equal(frame.input_tokens, null);
	assert.equal(frame.output_tokens, null);
	assert.equal(frame.cache_tokens, null);
	assert.equal(frame.cost_usd, null);
});
