// (b) O DoomLoopDetector bloqueia em before_tool_call a repetição idêntica consecutiva, e o bloqueio aparece no ledger.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { checkLedgerConformance, DoomLoopDetector, executeRung } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage, writeFileTool } from "./support.ts";

function ctx(name: string, args: JsonObject, id: string): BeforeToolCallContext {
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
	return { assistantMessage: fauxAssistantMessage(""), toolCall, args, context: { messages: [], tools: [] } };
}

test("detector: N idênticas permitidas, N+1-ésima bloqueada, bloqueios não reiniciam o streak", () => {
	const detector = new DoomLoopDetector({ maxIdenticalConsecutive: 2 });
	const same = { path: "a.txt", content: "x" };
	assert.equal(detector.beforeToolCall(ctx("write_file", same, "1")), undefined);
	assert.equal(detector.beforeToolCall(ctx("write_file", same, "2")), undefined);
	const blocked = detector.beforeToolCall(ctx("write_file", same, "3"));
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /doom_loop/);
	assert.equal(detector.beforeToolCall(ctx("write_file", same, "4"))?.block, true);
	assert.equal(detector.blocks, 2);
});

test("detector: argumentos diferentes ou outra ferramenta reiniciam o streak", () => {
	const detector = new DoomLoopDetector({ maxIdenticalConsecutive: 1 });
	assert.equal(detector.beforeToolCall(ctx("write_file", { path: "a" }, "1")), undefined);
	assert.equal(detector.beforeToolCall(ctx("write_file", { path: "b" }, "2")), undefined);
	assert.equal(detector.beforeToolCall(ctx("read_file", { path: "b" }, "3")), undefined);
	assert.equal(detector.beforeToolCall(ctx("write_file", { path: "b" }, "4")), undefined);
	assert.equal(detector.blocks, 0);
});

test("run com repetição: ferramenta executa até o limite, chamadas seguintes são bloqueadas e registradas", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	const workspace = new Map<string, string>();
	let executions = 0;
	const ledgerPath = join(tempDir("doom"), "ledger.jsonl");
	const repeated = { path: "out.txt", content: "41" };
	runtime.script([
		...Array.from({ length: 5 }, (_, i) =>
			toolTurn("write_file", repeated, usage(100, 10, { reasoning: 0 }), `call_${i}`),
		),
		textTurn("desisti", usage(100, 10, { reasoning: 0 })),
	]);

	const result = await executeRung({
		ledgerPath,
		runId: "run-b-1",
		harnessVariant: "b0_test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "c".repeat(64),
		taskDefinitionSha256: "d".repeat(64),
		model: runtime.modelOf("dv-cheap"),
		tools: [
			writeFileTool(workspace, () => {
				executions += 1;
			}),
		],
		prompt: "grave 41",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/dv-cheap"]),
		maxCostUsd: 10,
		doomLoopMaxIdenticalConsecutive: 3,
	});

	assert.equal(result.status, "completed");
	assert.equal(executions, 3, "ferramenta executa somente até o limite de repetição");

	const lines = readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const toolStatuses = lines.filter((ev) => ev.event === "tool_finished").map((ev) => ev.status);
	assert.deepEqual(toolStatuses, ["ok", "ok", "ok", "blocked", "blocked"]);
	const blockedEvent = lines.find((ev) => ev.event === "tool_finished" && ev.status === "blocked") as {
		block_reason: string;
	};
	assert.match(blockedEvent.block_reason, /doom_loop/);

	const finished = lines.at(-1) as { guard_events: { doom_loop_blocks: number } };
	assert.equal(finished.guard_events.doom_loop_blocks, 2);
	assert.deepEqual(checkLedgerConformance(ledgerPath).violations, []);
});
