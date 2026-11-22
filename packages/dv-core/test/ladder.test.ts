// (d) O ExecutionGuidedLadderPolicy promove do degrau 0 ao 1 somente após falha da verificação externa, com teto por degrau.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Attempt,
	checkLedgerConformance,
	ExecutionGuidedLadderPolicy,
	executeRung,
	SingleModelPolicy,
} from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage, writeFileTool } from "./support.ts";

const CHEAP = { provider: "anthropic", modelId: "dv-cheap" };
const STRONG = { provider: "anthropic", modelId: "dv-strong" };
const policy = (): ExecutionGuidedLadderPolicy =>
	new ExecutionGuidedLadderPolicy({
		rungs: [
			{ model: CHEAP, costShareCap: 0.5 },
			{ model: STRONG, costShareCap: 1 },
		],
		globalMaxCostUsd: 2,
		escalateOnStatuses: ["fail"],
	});

function attempt(rung: number, verification: Attempt["verification"], spent: number): Attempt {
	return {
		rung,
		role: `rung_${rung}`,
		model: rung === 0 ? CHEAP : STRONG,
		verification,
		spent_lower_bound_usd: spent,
	};
}

test("política: degrau 0 com teto share*global; sem histórico começa no degrau 0", () => {
	const decision = policy().decide([]);
	assert.deepEqual(decision, { kind: "run", rung: 0, role: "rung_0", model: CHEAP, cap_usd: 1 });
});

test("política: falha de verificação no degrau 0 promove ao degrau 1 com teto min(share*global, saldo)", () => {
	const decision = policy().decide([attempt(0, { oracle_pass: false, status: "fail" }, 0.4)]);
	assert.deepEqual(decision, { kind: "run", rung: 1, role: "rung_1", model: STRONG, cap_usd: 1.6 });
});

test("política: sem promoção quando o status não é de escalonamento; sem veredito vira inconclusivo", () => {
	assert.deepEqual(policy().decide([attempt(0, { oracle_pass: null, status: "provider_error" }, 0.1)]), {
		kind: "stop",
		outcome: "inconclusive",
		reason: "sem veredito do oráculo (provider_error)",
	});
});

test("política: aprovação para; reprovação no último degrau não resolve", () => {
	assert.equal(policy().decide([attempt(0, { oracle_pass: true, status: "pass" }, 0.1)]).kind, "stop");
	const last = policy().decide([
		attempt(0, { oracle_pass: false, status: "fail" }, 0.1),
		attempt(1, { oracle_pass: false, status: "fail" }, 0.5),
	]);
	assert.deepEqual(last, { kind: "stop", outcome: "unsolved", reason: "oráculo reprovou" });
});

test("política: saldo global esgotado interrompe a promoção (soma inclui degraus reprovados)", () => {
	const decision = policy().decide([attempt(0, { oracle_pass: false, status: "fail" }, 2)]);
	assert.deepEqual(decision, { kind: "stop", outcome: "budget_exhausted", reason: "saldo global esgotado" });
});

test("política de referência: um modelo, sem escalonamento", () => {
	const single = new SingleModelPolicy(CHEAP, 3);
	assert.deepEqual(single.decide([]), { kind: "run", rung: 0, role: "executor", model: CHEAP, cap_usd: 3 });
	assert.equal(single.decide([attempt(0, { oracle_pass: false, status: "fail" }, 0.2)]).kind, "stop");
});

test("ponta a ponta: falha no degrau 0 promove ao degrau 1 com workspace limpo e ledgers separados", async () => {
	const runtime = fauxRuntime("anthropic", ["dv-cheap", "dv-strong"]);
	const dir = tempDir("ladder");
	const ladder = policy();
	const attempts: Attempt[] = [];
	const workspaces: Map<string, string>[] = [];
	const usageCall = usage(100_000, 1000, { reasoning: 0 }); // 0.1 + 0.004 = 0.104 USD por chamada

	// Degrau 0: escreve errado e depois encerra. Degrau 1: escreve certo e encerra.
	runtime.script([
		toolTurn("write_file", { path: "out.txt", content: "41" }, usageCall, "r0a"),
		textTurn("feito", usageCall),
		toolTurn("write_file", { path: "out.txt", content: "42" }, usageCall, "r1a"),
		textTurn("feito", usageCall),
	]);

	const verify = (workspace: Map<string, string>): Attempt["verification"] =>
		workspace.get("out.txt") === "42" ? { oracle_pass: true, status: "pass" } : { oracle_pass: false, status: "fail" };

	const ledgers: string[] = [];
	let decision = ladder.decide(attempts);
	while (decision.kind === "run") {
		const workspace = new Map<string, string>(); // workspace limpo por degrau
		workspaces.push(workspace);
		const ledgerPath = join(dir, `ledger-rung-${decision.rung}.jsonl`);
		ledgers.push(ledgerPath);
		const model = decision.model.modelId === "dv-cheap" ? runtime.modelOf("dv-cheap") : runtime.modelOf("dv-strong");
		const result = await executeRung({
			ledgerPath,
			runId: `ladder-rung-${decision.rung}`,
			harnessVariant: "execution_guided_ladder_test",
			referenceProvenance: { harness: "dv-core" },
			datasetSha256: "1".repeat(64),
			taskDefinitionSha256: "2".repeat(64),
			model,
			tools: [writeFileTool(workspace)],
			prompt: "grave 42 em out.txt",
			streamFn: runtime.streamFn,
			priceBook: priceBookFor(["anthropic/dv-cheap", "anthropic/dv-strong"]),
			maxCostUsd: decision.cap_usd,
			doomLoopMaxIdenticalConsecutive: 3,
		});
		attempts.push({
			rung: decision.rung,
			role: decision.role,
			model: decision.model,
			verification: verify(workspace),
			spent_lower_bound_usd: result.spentLowerBoundUsd,
		});
		decision = ladder.decide(attempts);
	}

	assert.deepEqual(decision, { kind: "stop", outcome: "solved", reason: "oráculo aprovou" });
	assert.deepEqual(
		attempts.map((a) => [a.rung, a.model.modelId, a.verification?.status]),
		[
			[0, "dv-cheap", "fail"],
			[1, "dv-strong", "pass"],
		],
	);
	// Degrau 1 começou com workspace vazio: o arquivo do degrau 0 não existe nele antes da escrita.
	assert.equal(workspaces[1]?.get("out.txt"), "42");
	assert.equal(workspaces[0]?.get("out.txt"), "41");
	for (const ledgerPath of ledgers) {
		assert.deepEqual(checkLedgerConformance(ledgerPath).violations, []);
	}
});
