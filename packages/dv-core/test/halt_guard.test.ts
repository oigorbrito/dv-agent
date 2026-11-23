// Parada após guard: nenhuma chamada N+1 chega ao provedor depois do disparo, ferramentas pendentes da resposta
// que disparou o guard viram not_executed sem invocar o handler, e a telemetria segue MEASURED (sem chamada fantasma).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkLedgerConformance, executeRung, type RungRunOptions } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage, writeFileTool } from "./support.ts";

const MODEL = "dv-halt";
const KEY = `anthropic/${MODEL}`;

interface Harness {
	providerCalls: number;
	handlerRuns: number;
	workspace: Map<string, string>;
	ledger: string;
}

async function run(
	turns: Parameters<ReturnType<typeof fauxRuntime>["script"]>[0],
	extra: Partial<RungRunOptions> = {},
): Promise<{ result: Awaited<ReturnType<typeof executeRung>>; h: Harness }> {
	const runtime = fauxRuntime("anthropic", [MODEL]);
	runtime.script(turns);
	const h: Harness = {
		providerCalls: 0,
		handlerRuns: 0,
		workspace: new Map(),
		ledger: join(tempDir("halt"), "l.jsonl"),
	};
	const counting: RungRunOptions["streamFn"] = (m, c, o) => {
		h.providerCalls += 1;
		return runtime.streamFn(m, c, o);
	};
	const result = await executeRung({
		ledgerPath: h.ledger,
		runId: "halt",
		harnessVariant: "halt-test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "1".repeat(64),
		taskDefinitionSha256: "2".repeat(64),
		model: runtime.modelOf(MODEL),
		tools: [
			writeFileTool(h.workspace, () => {
				h.handlerRuns += 1;
			}),
		],
		prompt: "tarefa",
		streamFn: counting,
		priceBook: priceBookFor([KEY]),
		maxCostUsd: 10,
		doomLoopMaxIdenticalConsecutive: 3,
		...extra,
	});
	return { result, h };
}

function events(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("max_turns: nenhuma chamada N+1 ao provedor, ferramenta da resposta cortada não executa", async () => {
	const u = usage(1000, 100, { reasoning: 0 });
	const { result, h } = await run(
		[toolTurn("write_file", { path: "a.txt", content: "x" }, u, "t1"), textTurn("fim", u)],
		{ maxTurns: 1 },
	);
	assert.equal(result.status, "limit_exceeded");
	assert.equal(h.providerCalls, 1, "a chamada 2 não pode ser enviada ao provedor");
	assert.equal(h.handlerRuns, 0, "ferramenta pendente não invoca o handler");
	assert.equal(h.workspace.has("a.txt"), false);
	const ev = events(h.ledger);
	assert.equal(ev.filter((e) => e.event === "call_started").length, 1);
	const tool = ev.find((e) => e.event === "tool_finished");
	assert.equal(tool?.status, "blocked");
	assert.equal(tool?.block_reason, "not_executed: max_turns");
});

test("max_turns: telemetria MEASURED e conformidade PASS (sem registro fantasma aborted)", async () => {
	const u = usage(1000, 100, { reasoning: 0 });
	const { h } = await run([toolTurn("write_file", { path: "a.txt", content: "x" }, u, "t1"), textTurn("fim", u)], {
		maxTurns: 1,
	});
	const report = checkLedgerConformance(h.ledger);
	assert.deepEqual(report.violations, []);
	assert.equal(report.status, "PASS");
	const calls = events(h.ledger).filter((e) => e.event === "call_finished");
	assert.equal(calls.length, 1);
	assert.notEqual((calls[0]?.record as { stop_reason: string }).stop_reason, "aborted");
});

test("budget_exceeded (USD): a chamada que estoura o teto é a última enviada ao provedor", async () => {
	const big = usage(1_000_000, 0, { reasoning: 0 }); // 1.0 USD
	const { result, h } = await run(
		[toolTurn("write_file", { path: "a.txt", content: "x" }, big, "t1"), textTurn("fim", big)],
		{ maxCostUsd: 0.5 },
	);
	assert.equal(result.status, "budget_exceeded");
	assert.equal(h.providerCalls, 1);
	assert.equal(h.handlerRuns, 0);
	const report = checkLedgerConformance(h.ledger);
	assert.deepEqual(report.violations, []);
	assert.equal(report.ceiling_status, "exceeded");
	assert.equal(report.status, "PASS");
});

test("budget_exceeded (tokens): corte por teto de tokens também não envia chamada N+1", async () => {
	const u = usage(500, 500, { reasoning: 0 });
	const { result, h } = await run([textTurn("um", u), textTurn("dois", u), textTurn("tres", u)], {
		maxTotalTokens: 100,
	});
	assert.equal(result.status, "budget_exceeded");
	assert.equal(h.providerCalls, 1);
	const report = checkLedgerConformance(h.ledger);
	assert.equal(report.status, "PASS");
});

test("sem guard: a run termina normalmente e todas as chamadas são medidas", async () => {
	const u = usage(100, 10, { reasoning: 0 });
	const { result, h } = await run([
		toolTurn("write_file", { path: "a.txt", content: "x" }, u, "t1"),
		textTurn("ok", u),
	]);
	assert.equal(result.status, "completed");
	assert.equal(h.providerCalls, 2);
	assert.equal(h.handlerRuns, 1);
	assert.equal(checkLedgerConformance(h.ledger).status, "PASS");
});
