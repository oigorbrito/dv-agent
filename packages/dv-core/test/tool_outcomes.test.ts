// Desfecho not_executed no LedgerWriter: chamada declarada pelo modelo, sem resultado porque a run foi abortada.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	argumentsSha256,
	type CallTelemetry,
	checkLedgerConformance,
	RunLedger,
	ToolOutcomeTracker,
} from "../src/index.ts";
import { sha256Hex } from "../src/util/canonical.ts";
import { tempDir } from "./support.ts";

const ARGS_A = { path: "calc.py", content: "a" };
const ARGS_B = { path: "outro.py", content: "b" };

function openRun(path: string): RunLedger {
	const ledger = new RunLedger(path);
	ledger.appendRunStarted({
		run_id: "unit-not-executed",
		contract_id: "p1-run-accounting-v4",
		harness_variant: "unit",
		reference_provenance: { test: "tool_outcomes" },
		dataset_sha256: "a".repeat(64),
		task_definition_sha256: "b".repeat(64),
		model: { provider: "anthropic", model_id: "m", api: "anthropic-messages" },
		max_cost_usd: 1,
		guards: { doom_loop_max_identical_consecutive: 3 },
	});
	return ledger;
}

/** Chamada de modelo com duas ferramentas declaradas; a ledger recebe call_started e call_finished. */
function declareTwo(ledger: RunLedger, tracker: ToolOutcomeTracker): void {
	ledger.appendCallStarted({ call_index: 1, provider: "anthropic", model_id: "m", api: "anthropic-messages" });
	const telemetry: CallTelemetry = {
		prompt_tokens: 10,
		completion_tokens: 5,
		total_tokens: 15,
		uncached_input_tokens: 10,
		cache_read_tokens: 0,
		cache_write_tokens: null,
		reasoning_tokens: null,
		cost_usd: 0.0001,
		cost_basis: "price_book:unit",
		declared_not_exposed: ["cache_write_tokens", "reasoning_tokens"],
		declared_not_applicable: [],
		missing_buckets: [],
		telemetry_complete: true,
		cost_accounting_status: "MEASURED",
	};
	ledger.appendCallFinished({
		call_index: 1,
		record: {
			stop_reason: "toolUse",
			usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15 },
			telemetry,
			tool_calls: [
				{ tool_call_id: "call-a", tool_name: "edit_file", arguments_sha256: argumentsSha256(ARGS_A) },
				{ tool_call_id: "call-b", tool_name: "run_bash", arguments_sha256: argumentsSha256(ARGS_B) },
			],
		},
	});
	tracker.declare({ toolCallId: "call-a", toolName: "edit_file", argumentsSha256: argumentsSha256(ARGS_A) });
	tracker.declare({ toolCallId: "call-b", toolName: "run_bash", argumentsSha256: argumentsSha256(ARGS_B) });
}

function closeRun(ledger: RunLedger, status: "budget_exceeded" | "aborted"): void {
	ledger.appendRunFinished({
		status,
		calls_started: 1,
		calls_finished: 1,
		in_flight_call_indices: [],
		spent_lower_bound_usd: 0.0001,
		unknown_cost_calls: 0,
		non_metered_cost_calls: 0,
		ceiling_status: "within_verified",
		guard_events: { doom_loop_blocks: 0, budget_blocked_tools: 0 },
	});
	ledger.close();
}

test("abort: chamada declarada sem resultado vira not_executed com digest dos argumentos, e o ledger é conforme", () => {
	const path = join(tempDir("not-exec"), "ledger.jsonl");
	const ledger = openRun(path);
	const tracker = new ToolOutcomeTracker();
	declareTwo(ledger, tracker);
	// call-a executou; a run foi abortada antes de call-b receber resultado.
	tracker.report("call-a");
	ledger.appendToolFinished({
		tool_call_id: "call-a",
		tool_name: "edit_file",
		arguments_sha256: argumentsSha256(ARGS_A),
		status: "ok",
		raw_output: "editado calc.py",
		raw_output_sha256: sha256Hex("editado calc.py"),
	});
	assert.deepEqual(
		tracker.pending().map((c) => c.toolCallId),
		["call-b"],
	);
	assert.equal(tracker.finalize(ledger, "run terminada antes da execução da ferramenta"), 1);
	closeRun(ledger, "aborted");

	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const finals = lines.filter((ev) => ev.event === "tool_finished");
	assert.deepEqual(
		finals.map((ev) => [ev.tool_call_id, ev.status]),
		[
			["call-a", "ok"],
			["call-b", "not_executed"],
		],
	);
	const notExecuted = finals[1] as Record<string, unknown>;
	assert.equal(notExecuted.arguments_sha256, argumentsSha256(ARGS_B));
	assert.equal(notExecuted.raw_output, "");
	assert.equal(notExecuted.raw_output_sha256, sha256Hex(""));
	assert.equal(notExecuted.block_reason, "run terminada antes da execução da ferramenta");
	assert.deepEqual(checkLedgerConformance(path).violations, []);
});

test("finalize é idempotente: segunda chamada não grava novo not_executed", () => {
	const path = join(tempDir("not-exec-idem"), "ledger.jsonl");
	const ledger = openRun(path);
	const tracker = new ToolOutcomeTracker();
	declareTwo(ledger, tracker);
	assert.equal(tracker.finalize(ledger, "fim"), 2);
	assert.equal(tracker.finalize(ledger, "fim"), 0);
	closeRun(ledger, "aborted");
	const count = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.includes('"not_executed"')).length;
	assert.equal(count, 2);
	assert.deepEqual(checkLedgerConformance(path).violations, []);
});

test("sem not_executed, a chamada declarada sem desfecho é violação do verificador", () => {
	const path = join(tempDir("not-exec-neg"), "ledger.jsonl");
	const ledger = openRun(path);
	const tracker = new ToolOutcomeTracker();
	declareTwo(ledger, tracker);
	closeRun(ledger, "aborted");
	const violations = checkLedgerConformance(path).violations;
	assert.ok(violations.includes("tool_call call-a sem desfecho (tool_finished)"));
	assert.ok(violations.includes("tool_call call-b sem desfecho (tool_finished)"));
});
