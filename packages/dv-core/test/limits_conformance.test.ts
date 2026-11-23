// Guards de turnos e de output do degrau (motivo registrado no ledger), status de conformidade com teto não
// verificável (contract v4, regra c) e proteção de evidência (ledger não é sobrescrito nem anexado).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkLedgerConformance, executeRung, type LimitReason, RunLedger } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage, writeFileTool } from "./support.ts";

const MODEL = "dv-limit";
const KEY = `anthropic/${MODEL}`;

async function runWith(
	turns: Parameters<ReturnType<typeof fauxRuntime>["script"]>[0],
	extra: { maxTurns?: number; maxOutputTokens?: number; unpriced?: boolean } = {},
): Promise<{ ledger: string; status: string; limit: LimitReason | null }> {
	const runtime = fauxRuntime("anthropic", [MODEL]);
	runtime.script(turns);
	const dir = tempDir("limit");
	const ledger = join(dir, "ledger.jsonl");
	const workspace = new Map<string, string>();
	const result = await executeRung({
		ledgerPath: ledger,
		runId: "limit-test",
		harnessVariant: "limits-test",
		referenceProvenance: { harness: "dv-core" },
		datasetSha256: "1".repeat(64),
		taskDefinitionSha256: "2".repeat(64),
		model: runtime.modelOf(MODEL),
		tools: [writeFileTool(workspace)],
		prompt: "tarefa",
		streamFn: runtime.streamFn,
		priceBook: extra.unpriced ? { kind: "metered", id: "empty", source: "test", entries: {} } : priceBookFor([KEY]),
		maxCostUsd: 10,
		doomLoopMaxIdenticalConsecutive: 3,
		...(extra.maxTurns === undefined ? {} : { maxTurns: extra.maxTurns }),
		...(extra.maxOutputTokens === undefined ? {} : { maxOutputTokens: extra.maxOutputTokens }),
	});
	return { ledger, status: result.status, limit: lastFinished(ledger).limit_reason ?? null };
}

function lastFinished(path: string): { limit_reason?: LimitReason | null; ceiling_status: string; status: string } {
	const lines = readFileSync(path, "utf8").trim().split("\n");
	const finished = JSON.parse(lines.at(-1) ?? "{}") as {
		event: string;
		status: string;
		ceiling_status: string;
		guard_events: { limit_reason?: LimitReason | null };
	};
	assert.equal(finished.event, "run_finished");
	return {
		status: finished.status,
		ceiling_status: finished.ceiling_status,
		limit_reason: finished.guard_events.limit_reason,
	};
}

test("maxTurns: turno que pede ferramenta após o teto corta o degrau com motivo max_turns no ledger", async () => {
	const u = usage(1000, 100, { reasoning: 0 });
	const run = await runWith([toolTurn("write_file", { path: "a.txt", content: "x" }, u, "t1"), textTurn("fim", u)], {
		maxTurns: 1,
	});
	assert.equal(run.status, "limit_exceeded");
	assert.equal(run.limit, "max_turns");
	assert.deepEqual(checkLedgerConformance(run.ledger).violations, []);
});

test("maxTurns: resposta final sem ferramenta no último turno não é tratada como corte", async () => {
	const u = usage(1000, 100, { reasoning: 0 });
	const run = await runWith([textTurn("pronto", u)], { maxTurns: 1 });
	assert.equal(run.status, "completed");
	assert.equal(run.limit, null);
});

test("maxOutputTokens: output acumulado acima do teto corta o degrau com motivo max_output_tokens", async () => {
	const u = usage(1000, 500, { reasoning: 0 });
	const run = await runWith([textTurn("texto longo", u)], { maxOutputTokens: 100 });
	assert.equal(run.status, "limit_exceeded");
	assert.equal(run.limit, "max_output_tokens");
	assert.deepEqual(checkLedgerConformance(run.ledger).violations, []);
});

test("conformidade: teto de custo não verificável dá INCONCLUSIVE, nunca PASS (contract v4, regra c)", async () => {
	const u = usage(1000, 100, { reasoning: 0 });
	const run = await runWith([textTurn("ok", u)], { unpriced: true });
	const report = checkLedgerConformance(run.ledger);
	assert.equal(run.status, "completed");
	assert.deepEqual(report.violations, []);
	assert.equal(report.ceiling_status, "unverifiable");
	assert.equal(report.status, "INCONCLUSIVE");
	assert.equal(report.ok, true);
});

test("conformidade: teto verificado dentro do limite dá PASS", async () => {
	const u = usage(1000, 100, { reasoning: 0 });
	const run = await runWith([textTurn("ok", u)]);
	const report = checkLedgerConformance(run.ledger);
	assert.equal(report.ceiling_status, "within_verified");
	assert.equal(report.status, "PASS");
});

test("evidência: RunLedger recusa caminho que já existe (sem append nem sobrescrita)", () => {
	const path = join(tempDir("evidence"), "ledger.jsonl");
	new RunLedger(path).close();
	assert.throws(() => new RunLedger(path), /EEXIST/);
	assert.equal(existsSync(path), true);
});
