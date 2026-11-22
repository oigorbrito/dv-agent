// (c) O BudgetGuard corta a execução ao exceder o teto pelo limite inferior, e bloqueia ferramentas depois do corte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetGuard, checkLedgerConformance, executeRung } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage, writeFileTool } from "./support.ts";

// 1.000.000 input tokens a 1 USD/MTok = 1 USD por chamada.
const ONE_DOLLAR_CALL = usage(1_000_000, 0, { reasoning: 0 });

test("guard: custo conhecido acima do teto dispara o corte; abaixo ou igual não", () => {
	const guard = new BudgetGuard({ maxCostUsd: 1.5, priceBook: priceBookFor(["anthropic/m"]) });
	const msg = () => ({ ...toolTurn("t", {}, ONE_DOLLAR_CALL).message, usage: ONE_DOLLAR_CALL, provider: "anthropic", model: "m" });
	assert.equal(guard.onMessageEnd(msg()), false);
	assert.equal(guard.ceilingStatus(), "within_verified");
	assert.equal(guard.onMessageEnd(msg()), true);
	assert.equal(guard.ceilingStatus(), "exceeded");
	assert.equal(guard.spentLowerBoundUsd, 2);
});

test("run: corte por orçamento interrompe o agente, bloqueia a ferramenta seguinte e registra budget_exceeded", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
	const workspace = new Map<string, string>();
	let executions = 0;
	const ledgerPath = join(tempDir("budget"), "ledger.jsonl");
	runtime.script([
		toolTurn("write_file", { path: "a.txt", content: "1" }, ONE_DOLLAR_CALL, "c1"),
		toolTurn("write_file", { path: "b.txt", content: "2" }, ONE_DOLLAR_CALL, "c2"),
		toolTurn("write_file", { path: "c.txt", content: "3" }, ONE_DOLLAR_CALL, "c3"),
		textTurn("fim", ONE_DOLLAR_CALL),
	]);

	const result = await executeRung({
		ledgerPath,
		runId: "run-c-1",
		harnessVariant: "b0_test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "e".repeat(64),
		taskDefinitionSha256: "f".repeat(64),
		model: runtime.modelOf("dv-cheap"),
		tools: [writeFileTool(workspace, () => (executions += 1))],
		prompt: "grave três arquivos",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/dv-cheap"]),
		maxCostUsd: 1.5,
		doomLoopMaxIdenticalConsecutive: 10,
	});

	assert.equal(result.status, "budget_exceeded");
	assert.equal(result.ceilingStatus, "exceeded");
	assert.equal(result.spentLowerBoundUsd, 2);
	assert.equal(runtime.faux.getPendingResponseCount(), 2, "respostas após o corte não são consumidas");
	assert.equal(executions, 1, "só a primeira ferramenta roda; a do estouro e as seguintes são bloqueadas");
	assert.equal(workspace.has("b.txt"), false);

	const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
	// O corte ocorre em message_end. O loop devolve resultado de erro (abortado) para a ferramenta do turno, sem executá-la.
	const toolStatuses = lines.filter((ev) => ev.event === "tool_finished").map((ev) => [ev.tool_call_id, ev.status]);
	assert.deepEqual(toolStatuses, [["c1", "ok"], ["c2", "error"]]);
	const finished = lines.at(-1) as { status: string; guard_events: { budget_blocked_tools: number } };
	assert.equal(finished.status, "budget_exceeded");
	assert.equal(finished.guard_events.budget_blocked_tools, 0);

	// O ledger deve ser conforme mesmo no corte: o teto excedido é declarado, não escondido.
	assert.deepEqual(checkLedgerConformance(ledgerPath).violations, []);
});

test("guard: após o corte, before_tool_call bloqueia a ferramenta com motivo budget_exceeded", () => {
	const guard = new BudgetGuard({ maxCostUsd: 0.5, priceBook: priceBookFor(["anthropic/m"]) });
	const turn = { ...toolTurn("write_file", { path: "a", content: "b" }, ONE_DOLLAR_CALL).message, usage: ONE_DOLLAR_CALL, provider: "anthropic", model: "m" };
	guard.onMessageEnd(turn);
	assert.equal(guard.tripped, true);
	const toolCall = turn.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall?.type === "toolCall");
	const decision = guard.beforeToolCall({
		assistantMessage: turn,
		toolCall,
		args: {},
		context: { messages: [], tools: [] },
	});
	assert.equal(decision?.block, true);
	assert.match(decision?.reason ?? "", /budget_exceeded/);
	assert.equal(guard.blockedTools, 1);
});
