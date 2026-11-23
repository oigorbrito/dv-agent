// Agregação e renderização do benchmark: tabela por política e por tier (solve_rate, escalação, tokens, telemetria, conformidade v4).

import type { LedgerMetrics } from "../smoke/ledger_metrics.ts";
import type { PolicyName } from "../smoke/runner.ts";
import type { Tier } from "./corpus.ts";

export const BENCH_SCHEMA = "dv-bench-summary-v1";

export interface RunStep {
	rung: number;
	role: string;
	model: string;
	verdict: string | null;
	run_status: string;
	ledger_path: string;
	ledger_sha256: string;
	metrics: LedgerMetrics;
}

/** Uma combinação (tarefa x política). `escalated` é null em políticas sem degrau de escalonamento. */
export interface RunRecord {
	task_id: string;
	tier: Tier;
	policy: PolicyName;
	final_outcome: string;
	solved: boolean;
	escalated: boolean | null;
	steps: RunStep[];
	conformance_violations: string[];
}

export interface GroupRow {
	policy: PolicyName;
	tier: Tier | "all";
	runs: number;
	solved: number;
	solve_rate: number | null;
	escalation_rate: number | null;
	tokens_total: number;
	tokens_input: number;
	tokens_cached_read: number;
	tokens_cache_write: number;
	tokens_output: number;
	telemetry_status: "MEASURED" | "INCONCLUSIVE";
	conformance_v4: "PASS" | "FAIL";
}

/** Políticas com degrau de escalonamento (promoção do degrau 0 para o 1). As demais reportam escalation_rate = null. */
export const ESCALATING_POLICIES: readonly PolicyName[] = ["ladder"];

/** Agrega por política (tier "all") e por política x tier. Ordem: política na ordem pedida; tiers na ordem canônica. */
export function aggregate(
	runs: readonly RunRecord[],
	policies: readonly PolicyName[],
	tiers: readonly Tier[],
): GroupRow[] {
	const rows: GroupRow[] = [];
	for (const policy of policies) {
		const byPolicy = runs.filter((r) => r.policy === policy);
		rows.push(groupRow(policy, "all", byPolicy));
		for (const tier of tiers) {
			rows.push(
				groupRow(
					policy,
					tier,
					byPolicy.filter((r) => r.tier === tier),
				),
			);
		}
	}
	return rows;
}

function groupRow(policy: PolicyName, tier: Tier | "all", runs: readonly RunRecord[]): GroupRow {
	const steps = runs.flatMap((r) => r.steps);
	const sum = (pick: (m: LedgerMetrics) => number): number => steps.reduce((acc, s) => acc + pick(s.metrics), 0);
	const solved = runs.filter((r) => r.solved).length;
	const telemetryMeasured =
		runs.length > 0 && runs.every((r) => r.steps.length > 0 && r.steps.every((s) => s.metrics.telemetry_complete));
	const escalating = ESCALATING_POLICIES.includes(policy);
	return {
		policy,
		tier,
		runs: runs.length,
		solved,
		solve_rate: runs.length === 0 ? null : round4(solved / runs.length),
		escalation_rate:
			escalating && runs.length > 0 ? round4(runs.filter((r) => r.escalated === true).length / runs.length) : null,
		tokens_total: sum((m) => m.total_tokens),
		tokens_input: sum((m) => m.uncached_input_tokens),
		tokens_cached_read: sum((m) => m.cache_read_tokens),
		tokens_cache_write: sum((m) => m.cache_write_tokens),
		tokens_output: sum((m) => m.completion_tokens),
		telemetry_status: telemetryMeasured ? "MEASURED" : "INCONCLUSIVE",
		conformance_v4: runs.some((r) => r.conformance_violations.length > 0) ? "FAIL" : "PASS",
	};
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

export interface BenchReport {
	schema: typeof BENCH_SCHEMA;
	contract_id: string;
	contract_sha256: string;
	auth_mode: string;
	tier: Tier | "all";
	task: string | null;
	policies: PolicyName[];
	max_cost_usd: number;
	max_tokens: number | null;
	runs: RunRecord[];
	rows: GroupRow[];
	conformance_violations: { run: string; violations: string[] }[];
}

const COLUMNS: (keyof GroupRow)[] = [
	"policy",
	"tier",
	"runs",
	"solved",
	"solve_rate",
	"escalation_rate",
	"tokens_total",
	"tokens_input",
	"tokens_cached_read",
	"tokens_cache_write",
	"tokens_output",
	"telemetry_status",
	"conformance_v4",
];

/** Relatório em Markdown. Não omite linhas nem colunas: campo sem valor aparece como n/a. */
export function renderMarkdown(report: BenchReport): string {
	const lines: string[] = [];
	lines.push("# dv-bench: ablação empírica", "");
	lines.push(`- contrato: \`${report.contract_id}\` (sha256 \`${report.contract_sha256}\`)`);
	lines.push(`- auth_mode: \`${report.auth_mode}\`; tier: \`${report.tier}\`; tarefa: \`${report.task ?? "todas"}\``);
	lines.push(
		`- políticas: ${report.policies.join(", ")}; teto de custo: ${report.max_cost_usd} USD; teto de tokens: ${report.max_tokens ?? "n/a"}`,
	);
	if (report.auth_mode === "offline-faux") {
		lines.push(
			"",
			"> AVISO: modo offline-faux. Roteiros determinísticos por tarefa; valida o harness (promoção, oráculo, ledger),",
			"> não mede qualidade de modelo real.",
		);
	}
	lines.push("", "## Tabela por política e tier", "");
	lines.push(`| ${COLUMNS.join(" | ")} |`, `| ${COLUMNS.map(() => "---").join(" | ")} |`);
	for (const row of report.rows) {
		lines.push(`| ${COLUMNS.map((c) => cell(row[c])).join(" | ")} |`);
	}
	lines.push(
		"",
		"## Runs",
		"",
		"| tarefa | tier | política | outcome | degraus | escalou |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const run of report.runs) {
		const escalated = run.escalated === null ? "n/a" : run.escalated ? "sim" : "não";
		const path = run.steps.map((s) => `${s.role}:${s.verdict ?? "-"}`).join(" → ") || "-";
		lines.push(`| ${run.task_id} | ${run.tier} | ${run.policy} | ${run.final_outcome} | ${path} | ${escalated} |`);
	}
	lines.push("", "## Conformidade v4", "");
	if (report.conformance_violations.length === 0) lines.push("Todos os ledgers passaram no verificador v4.");
	for (const v of report.conformance_violations) lines.push(`- ${v.run}: ${v.violations.join("; ")}`);
	return `${lines.join("\n")}\n`;
}

function cell(value: unknown): string {
	if (value === null || value === undefined) return "n/a";
	return String(value);
}
