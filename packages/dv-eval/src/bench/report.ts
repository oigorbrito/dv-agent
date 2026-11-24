// Agregação e renderização do benchmark: tabela por política e por tier (solve_rate, escalação, tokens, custo,
// teto e conformidade v4). Linha "all" só existe quando todos os tiers do corpus foram executados.
import type { ConformanceStatus } from "@dv-agent/core";
import type { LedgerMetrics } from "../smoke/ledger_metrics.ts";
import type { PolicyName, RoleLimits } from "../smoke/runner.ts";
import { CORPUS_TIERS, type CorpusTier, TIERS } from "./corpus.ts";

export const BENCH_SCHEMA = "dv-bench-summary-v2";

export type CeilingStatus = "within_verified" | "exceeded" | "unverifiable";

export interface RunStep {
	rung: number;
	role: string;
	model: string;
	verdict: string | null;
	run_status: string;
	ceiling_status: CeilingStatus;
	spent_lower_bound_usd: number;
	ledger_path: string;
	ledger_sha256: string;
	metrics: LedgerMetrics;
	conformance_status: ConformanceStatus;
}

/** Uma combinação (tarefa x política). `escalated` é null em políticas sem degrau de escalonamento. */
export interface RunRecord {
	/** Contrato do run (igual ao do resumo). Ausente em resumos anteriores à rotulagem por contrato. */
	contract_id?: string;
	task_id: string;
	/** Índice da réplica (0-based): rep-N no diretório. */
	repeat: number;
	tier: CorpusTier;
	policy: PolicyName;
	final_outcome: string;
	solved: boolean;
	escalated: boolean | null;
	steps: RunStep[];
	/** PASS só com todos os steps PASS; sem nenhum ledger (ex.: bloqueado) é INCONCLUSIVE. */
	conformance_status: ConformanceStatus;
	conformance_violations: string[];
}

export interface GroupRow {
	policy: PolicyName;
	tier: CorpusTier | "all";
	runs: number;
	solved: number;
	solve_rate: number | null;
	/** Intervalo de confiança de Wilson 95% (z=1,96) sobre solved/runs. Null sem execuções. */
	ci_95_low: number | null;
	ci_95_high: number | null;
	escalation_rate: number | null;
	tokens_total: number;
	tokens_input: number;
	tokens_cached_read: number;
	tokens_cache_write: number;
	tokens_output: number;
	/** Soma de cost_usd; null se algum passo não tem custo em USD (sessão de assinatura ou preço desconhecido). */
	cost_usd: number | null;
	spent_lower_bound_usd: number;
	/** Runs do grupo cortados por budget_exceeded: o tokens_total inclui a chamada que cruzou o teto. */
	budget_exceeded_runs: number;
	/** Tarefas distintas no grupo e quantas foram resolvidas em todas as réplicas (pass^k). */
	tasks: number;
	pass_all: number;
	/** Pior teto do grupo: exceeded > unverifiable > within_verified. n/a sem passos. */
	ceiling_status: CeilingStatus | "n/a";
	telemetry_status: "MEASURED" | "INCONCLUSIVE";
	conformance_v4: ConformanceStatus;
}

/** Políticas com degrau de escalonamento (promoção do degrau 0 para o 1). As demais reportam escalation_rate = null. */
export const ESCALATING_POLICIES: readonly PolicyName[] = ["ladder", "predictive-harness-router"];

const CEILING_RANK: Record<CeilingStatus, number> = { within_verified: 1, unverifiable: 2, exceeded: 3 };

/**
 * Agrega por política. Linhas por tier executado; linha "all" somente quando os três tiers foram executados.
 * `tiers` são os tiers efetivamente executados (não o filtro pedido).
 */
export function aggregate(
	runs: readonly RunRecord[],
	policies: readonly PolicyName[],
	tiers: readonly CorpusTier[],
): GroupRow[] {
	const rows: GroupRow[] = [];
	const allExecuted = TIERS.every((t) => tiers.includes(t));
	for (const policy of policies) {
		const byPolicy = runs.filter((r) => r.policy === policy);
		if (allExecuted) rows.push(groupRow(policy, "all", byPolicy));
		for (const tier of CORPUS_TIERS.filter((t) => tiers.includes(t))) {
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

function groupRow(policy: PolicyName, tier: CorpusTier | "all", runs: readonly RunRecord[]): GroupRow {
	const steps = runs.flatMap((r) => r.steps);
	const sum = (pick: (m: LedgerMetrics) => number): number => steps.reduce((acc, s) => acc + pick(s.metrics), 0);
	const solved = runs.filter((r) => r.solved).length;
	const telemetryMeasured =
		runs.length > 0 && runs.every((r) => r.steps.length > 0 && r.steps.every((s) => s.metrics.telemetry_complete));
	const escalating = ESCALATING_POLICIES.includes(policy);
	const ci = wilsonInterval(solved, runs.length);
	const costs = steps.map((s) => s.metrics.cost_usd);
	const worst = steps.reduce<CeilingStatus | undefined>(
		(acc, s) => (acc === undefined || CEILING_RANK[s.ceiling_status] > CEILING_RANK[acc] ? s.ceiling_status : acc),
		undefined,
	);
	return {
		policy,
		tier,
		runs: runs.length,
		solved,
		solve_rate: runs.length === 0 ? null : round4(solved / runs.length),
		ci_95_low: ci === null ? null : round4(ci.low),
		ci_95_high: ci === null ? null : round4(ci.high),
		escalation_rate:
			escalating && runs.length > 0 ? round4(runs.filter((r) => r.escalated === true).length / runs.length) : null,
		tokens_total: sum((m) => m.total_tokens),
		tokens_input: sum((m) => m.uncached_input_tokens),
		tokens_cached_read: sum((m) => m.cache_read_tokens),
		tokens_cache_write: sum((m) => m.cache_write_tokens),
		tokens_output: sum((m) => m.completion_tokens),
		cost_usd: costs.some((c) => c === null) ? null : costs.reduce<number>((acc, c) => acc + (c ?? 0), 0),
		spent_lower_bound_usd: steps.reduce((acc, s) => acc + s.spent_lower_bound_usd, 0),
		budget_exceeded_runs: runs.filter((r) => r.steps.some((s) => s.run_status === "budget_exceeded")).length,
		...passStats(runs),
		ceiling_status: worst ?? "n/a",
		telemetry_status: telemetryMeasured ? "MEASURED" : "INCONCLUSIVE",
		conformance_v4: groupConformance(runs),
	};
}

/**
 * Intervalo de confiança de Wilson (z padrão 1,96 = 95%) para uma proporção x/n, em frações de [0,1].
 * Evita o intervalo de Wald, que é degenerado em 0/n e n/n e subestima a incerteza com n pequeno.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
	if (n <= 0) return null;
	const p = successes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** pass^k: tarefas resolvidas em todas as réplicas. Cada tarefa conta uma vez, qualquer que seja o número de réplicas. */
export function passStats(runs: readonly RunRecord[]): { tasks: number; pass_all: number } {
	const byTask = new Map<string, boolean[]>();
	for (const r of runs) {
		const list = byTask.get(r.task_id) ?? [];
		list.push(r.solved);
		byTask.set(r.task_id, list);
	}
	const values = [...byTask.values()];
	return { tasks: values.length, pass_all: values.filter((v) => v.every(Boolean)).length };
}

/** Regra (c): qualquer FAIL domina; depois INCONCLUSIVE (teto não verificável); PASS só se todos forem PASS. */
export function groupConformance(runs: readonly RunRecord[]): ConformanceStatus {
	if (runs.some((r) => r.conformance_status === "FAIL")) return "FAIL";
	if (runs.some((r) => r.conformance_status === "INCONCLUSIVE")) return "INCONCLUSIVE";
	return "PASS";
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

export interface BenchReport {
	schema: typeof BENCH_SCHEMA;
	contract_id: string;
	contract_sha256: string;
	auth_mode: string;
	/** Filtro pedido em --tier. */
	tier: CorpusTier | "all";
	/** Tiers efetivamente executados. */
	tiers: CorpusTier[];
	task: string | null;
	/** Lista de --tasks, na ordem pedida (null quando não foi usada). */
	tasks: string[] | null;
	policies: PolicyName[];
	/** Modelo primário (--model). Identifica o baseline single: Haiku (fraco) ou Sonnet (forte). */
	model: string | null;
	escalation_model: string | null;
	max_cost_usd: number;
	max_tokens: number | null;
	editor_limits: RoleLimits;
	/** Réplicas por célula, temperatura pedida (null = padrão) e estado de suporte por modelo. */
	repeats: number;
	temperature: number | null;
	temperature_notes: string[];
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
	"cost_usd",
	"spent_lower_bound_usd",
	"ceiling_status",
	"tokens_total",
	"tokens_input",
	"tokens_cached_read",
	"tokens_cache_write",
	"tokens_output",
	"telemetry_status",
	"conformance_v4",
];

/** Relatório em Markdown. Campo sem valor aparece como n/a (ver legenda). */
export function renderMarkdown(report: BenchReport): string {
	const lines: string[] = [];
	lines.push("# dv-bench: ablação empírica", "");
	lines.push(`- contrato: \`${report.contract_id}\` (sha256 \`${report.contract_sha256}\`)`);
	lines.push(
		`- auth_mode: \`${report.auth_mode}\`; tier pedido: \`${report.tier}\`; tiers executados: \`${report.tiers.join(", ")}\`; tarefa: \`${report.task ?? "todas"}\``,
	);
	lines.push(
		`- políticas: ${report.policies.join(", ")}; teto de custo: ${report.auth_mode === "subscription" ? "n/a (subscription)" : `${report.max_cost_usd} USD`}; teto de tokens: ${report.max_tokens ?? "n/a"}`,
	);
	lines.push(
		`- tetos do editor: ${report.editor_limits.maxTurns} turnos, ${report.editor_limits.maxOutputTokens} tokens de saída`,
	);
	lines.push(`- réplicas por célula: ${report.repeats}; temperatura pedida: ${report.temperature ?? "padrão"}`);
	for (const note of report.temperature_notes) lines.push(`  - temperatura, ${note}`);
	if (report.auth_mode === "offline-faux") {
		lines.push(
			"",
			"> AVISO: modo offline-faux. Roteiros determinísticos por tarefa; valida o harness (promoção, oráculo, ledger),",
			"> não mede qualidade de modelo real.",
		);
	}
	lines.push("", "## Tabela por política e tier", "");
	const headers = COLUMNS.map(String);
	headers.splice(COLUMNS.indexOf("solve_rate") + 1, 0, "ci_95");
	headers.push("pass^k");
	lines.push(`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`);
	for (const row of report.rows) {
		const cells = COLUMNS.map((c) => cell(row[c]));
		const tokensIdx = COLUMNS.indexOf("tokens_total");
		if (row.budget_exceeded_runs > 0) cells[tokensIdx] = `${cells[tokensIdx]} †`;
		cells.splice(COLUMNS.indexOf("solve_rate") + 1, 0, ciCell(row));
		lines.push(`| ${[...cells, `${row.pass_all}/${row.tasks}`].join(" | ")} |`);
	}
	lines.push(
		"",
		"Legenda: `cost_usd` n/a = sessão de assinatura ou preço desconhecido (custo não somável em USD).",
		"`ceiling_status` unverifiable = teto de custo não verificável; a conformidade então fica INCONCLUSIVE (contract v4, regra c).",
		"† tokens_total inclui a chamada que cruzou o teto de tokens/custo no grupo (budget_exceeded); nenhuma chamada posterior é enviada.",
		"ci_95 = intervalo de Wilson 95% (z=1,96) sobre solved/runs. Com n pequeno o intervalo é largo por construção.",
		"",
		"## Runs",
		"",
		"| tarefa | tier | política | outcome | degraus | escalou | ceiling | conformidade |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const run of report.runs) {
		const escalated = run.escalated === null ? "n/a" : run.escalated ? "sim" : "não";
		const path = run.steps.map((s) => `${s.role}:${s.verdict ?? "-"}`).join(" → ") || "-";
		const ceiling = [...new Set(run.steps.map((s) => s.ceiling_status))].join(",") || "n/a";
		lines.push(
			`| ${run.task_id} | ${run.tier} | ${run.policy} | ${run.final_outcome} | ${path} | ${escalated} | ${ceiling} | ${run.conformance_status} |`,
		);
	}
	lines.push("", "## Conformidade v4", "");
	if (report.conformance_violations.length === 0) lines.push("Nenhuma violação estrutural nos ledgers.");
	for (const v of report.conformance_violations) lines.push(`- ${v.run}: ${v.violations.join("; ")}`);
	return `${lines.join("\n")}\n`;
}

function ciCell(row: GroupRow): string {
	if (row.ci_95_low === null || row.ci_95_high === null) return "n/a";
	return `[${(row.ci_95_low * 100).toFixed(1)}%, ${(row.ci_95_high * 100).toFixed(1)}%]`;
}

function cell(value: unknown): string {
	if (value === null || value === undefined) return "n/a";
	return String(value);
}
