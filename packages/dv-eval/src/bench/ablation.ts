// Runner de ablação: cada (tarefa x política) em workspace isolado (via runSmoke), ledger de cada degrau verificado
// contra o contrato v4, e relatório agregado gravado em summary.json e summary.md. Falha explícita em violação.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkLedgerConformance } from "@dv-agent/core";
import { readLedgerMetrics } from "../smoke/ledger_metrics.ts";
import { type AuthMode, type PolicyName, runSmoke } from "../smoke/runner.ts";
import { type CorpusTask, discoverCorpus, selectTasks, type Tier } from "./corpus.ts";
import { aggregate, BENCH_SCHEMA, type BenchReport, type RunRecord, renderMarkdown } from "./report.ts";

/** SHA-256 congelado de contracts/run-accounting-contract-v4.json. Se o arquivo mudar, o bench não roda. */
export const CONTRACT_SHA256 = "11b4d5453e0964a7eb88decb5cbf7d1c5f5eebf4fbbdd458fb4e38686baef486";
export const CONTRACT_PATH = "contracts/run-accounting-contract-v4.json";
const CONTRACT_ID = "p1-run-accounting-v4";

export interface BenchOptions {
	corpusDir: string;
	tier: Tier | "all";
	task?: string;
	policies: readonly PolicyName[];
	authMode: AuthMode;
	model?: string;
	escalationModel?: string;
	maxTokens?: number;
	maxCostUsd: number;
	outdir: string;
	/** Diretório de probes aprovados (api-key/subscription). Padrão: packages/dv-eval/probe-results. */
	probesDir: string;
	/** Contrato v4 a verificar (padrão: contracts/run-accounting-contract-v4.json na raiz do repositório). */
	contractPath: string;
}

/** Violação de conformidade v4 em pelo menos um ledger. O relatório já foi gravado antes do erro. */
export class ConformanceFailure extends Error {
	readonly violations: { run: string; violations: string[] }[];
	constructor(violations: { run: string; violations: string[] }[]) {
		const count = violations.reduce((n, v) => n + v.violations.length, 0);
		super(`conformidade v4 falhou em ${violations.length} run(s), ${count} violação(ões)`);
		this.violations = violations;
	}
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Executa a ablação e grava outdir/summary.json e outdir/summary.md. */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
	const contractSha = sha256File(resolve(options.contractPath));
	if (contractSha !== CONTRACT_SHA256) {
		throw new Error(`contrato v4 alterado: sha256 ${contractSha} != ${CONTRACT_SHA256} (${options.contractPath})`);
	}
	const tasks = selectTasks(discoverCorpus(options.corpusDir), { tier: options.tier, task: options.task });
	const outdir = resolve(options.outdir);
	mkdirSync(outdir, { recursive: true });

	const runs: RunRecord[] = [];
	for (const task of tasks) {
		for (const policy of options.policies) {
			runs.push(await runOne(task, policy, options, outdir));
		}
	}

	const violations = runs
		.filter((r) => r.conformance_violations.length > 0)
		.map((r) => ({ run: `${r.task_id}/${r.policy}`, violations: r.conformance_violations }));
	const tiers: Tier[] = [...new Set(tasks.map((t) => t.tier))];
	const report: BenchReport = {
		schema: BENCH_SCHEMA,
		contract_id: CONTRACT_ID,
		contract_sha256: contractSha,
		auth_mode: options.authMode,
		tier: options.tier,
		task: options.task ?? null,
		policies: [...options.policies],
		max_cost_usd: options.maxCostUsd,
		max_tokens: options.maxTokens ?? null,
		runs,
		rows: aggregate(runs, options.policies, tiers),
		conformance_violations: violations,
	};
	writeFileSync(join(outdir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	writeFileSync(join(outdir, "summary.md"), renderMarkdown(report), "utf8");
	if (violations.length > 0) throw new ConformanceFailure(violations);
	return report;
}

async function runOne(task: CorpusTask, policy: PolicyName, options: BenchOptions, outdir: string): Promise<RunRecord> {
	const runDir = join(outdir, task.id, policy);
	const summary = await runSmoke({
		taskDir: task.dir,
		policy,
		authMode: options.authMode,
		model: options.model,
		escalationModel: options.escalationModel,
		outdir: runDir,
		maxCostUsd: options.maxCostUsd,
		...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
		probesDir: options.probesDir,
	});
	const violations: string[] = [];
	const steps = summary.steps.map((step) => {
		const v = checkLedgerConformance(step.ledger_path).violations;
		for (const item of v) violations.push(`${task.id}/${policy}/${step.role}#${step.step}: ${item}`);
		return {
			rung: step.rung,
			role: step.role,
			model: step.model,
			verdict: step.oracle?.verdict ?? null,
			run_status: step.run_status,
			ledger_path: step.ledger_path,
			ledger_sha256: step.ledger_sha256,
			metrics: readLedgerMetrics(step.ledger_path),
		};
	});
	return {
		task_id: task.id,
		tier: task.tier,
		policy,
		final_outcome: summary.final_outcome,
		solved: summary.final_outcome === "solved",
		escalated: policy === "ladder" ? steps.some((s) => s.rung >= 1) : null,
		steps,
		conformance_violations: violations,
	};
}
