// Seção de métricas de roteamento para o relatório. Cruza resumos de invocações diferentes (Haiku single, Sonnet single,
// roteador) sobre o MESMO conjunto de execuções. Comparar pontos de conjuntos diferentes é recusado.

import { aiq, apgr, type CostQualityPoint, type CurvePoint, paretoFrontier, pgr } from "./metrics.ts";
import type { BenchReport, RunRecord } from "./report.ts";

export const ROUTER_POLICY = "predictive-harness-router";

export interface RoutingPoint {
	label: string;
	policy: string;
	/** Tokens totais do grupo (proxy de custo em assinatura; em api-key também fica disponível). */
	tokens: number;
	/** Taxa de aprovação do grupo. */
	quality: number;
	/** Fração das execuções que usou o modelo forte em algum degrau. Só existe para o roteador. */
	strong_fraction: number | null;
}

export interface RoutingInputs {
	weakModel: string;
	strongModel: string;
}

export interface RoutingMetrics {
	weak: RoutingPoint;
	strong: RoutingPoint;
	router: RoutingPoint | null;
	others: RoutingPoint[];
	pgr: { value: number | null; reason: string | null } | null;
	apgr: { value: number | null; reason: string | null } | null;
	pareto: string[];
	aiq: { value: number | null; reason: string | null; x_max: number };
}

function executionKey(run: RunRecord): string {
	return `${run.task_id}#${run.repeat}`;
}

/** Conjunto de execuções de um resumo. Dois resumos só são comparáveis se tiverem o mesmo conjunto. */
function executionSet(report: BenchReport): string {
	return [...new Set(report.runs.map(executionKey))].sort().join("|");
}

function strongFraction(report: BenchReport, policy: string, strongModel: string): number | null {
	const runs = report.runs.filter((r) => r.policy === policy);
	if (runs.length === 0) return null;
	return runs.filter((r) => r.steps.some((s) => s.model === strongModel)).length / runs.length;
}

export function computeRoutingMetrics(reports: readonly BenchReport[], inputs: RoutingInputs): RoutingMetrics {
	if (reports.length === 0) throw new Error("sem resumos para calcular métricas de roteamento");
	const reference = executionSet(reports[0] as BenchReport);
	for (const report of reports) {
		if (executionSet(report) !== reference) {
			throw new Error("resumos com conjuntos de execuções diferentes: métricas só são comparáveis no mesmo conjunto");
		}
	}

	const points: RoutingPoint[] = [];
	for (const report of reports) {
		// Só a linha agregada (tier "all"): as linhas por tier são cortes do mesmo conjunto e não são pontos novos.
		for (const row of report.rows) {
			if (row.tier !== "all") continue;
			if (row.policy === "single") {
				if (report.model === inputs.weakModel) {
					points.push({
						label: `single:${inputs.weakModel}`,
						policy: "single",
						tokens: row.tokens_total ?? 0,
						quality: row.solve_rate ?? 0,
						strong_fraction: 0,
					});
				} else if (report.model === inputs.strongModel) {
					points.push({
						label: `single:${inputs.strongModel}`,
						policy: "single",
						tokens: row.tokens_total ?? 0,
						quality: row.solve_rate ?? 0,
						strong_fraction: 1,
					});
				}
				continue;
			}
			points.push({
				label: row.policy,
				policy: row.policy,
				tokens: row.tokens_total ?? 0,
				quality: row.solve_rate ?? 0,
				strong_fraction: row.policy === ROUTER_POLICY ? strongFraction(report, row.policy, inputs.strongModel) : null,
			});
		}
	}

	const weak = points.find((p) => p.label === `single:${inputs.weakModel}`);
	const strong = points.find((p) => p.label === `single:${inputs.strongModel}`);
	if (weak === undefined || strong === undefined) {
		throw new Error(
			`faltam baselines: single:${inputs.weakModel} e single:${inputs.strongModel} (resumos com campo model)`,
		);
	}
	const router = points.find((p) => p.policy === ROUTER_POLICY) ?? null;
	const others = points.filter((p) => p !== weak && p !== strong && p !== router);

	let pgrResult: RoutingMetrics["pgr"] = null;
	let apgrResult: RoutingMetrics["apgr"] = null;
	if (router !== null) {
		pgrResult = pgr(router.quality, weak.quality, strong.quality);
		const f = router.strong_fraction;
		if (f !== null) {
			// Curva de três pontos: fraco em 0, operação do roteador em f, forte em 1. Span = 1.
			const curve: CurvePoint[] = [
				{ x: 0, y: weak.quality },
				{ x: f, y: router.quality },
				{ x: 1, y: strong.quality },
			];
			apgrResult = apgr(curve, weak.quality, strong.quality);
		}
	}

	const costQuality: CostQualityPoint[] = points.map((p) => ({ id: p.label, cost: p.tokens, quality: p.quality }));
	const xMax = Math.max(...points.map((p) => p.tokens));
	return {
		weak,
		strong,
		router,
		others,
		pgr: pgrResult,
		apgr: apgrResult,
		pareto: paretoFrontier(costQuality).map((p) => p.id),
		aiq: { ...aiq(costQuality, xMax), x_max: xMax },
	};
}

function fmt(value: number | null | undefined, digits = 3): string {
	return value === null || value === undefined ? "n/a" : value.toFixed(digits);
}

/** Seção markdown: pontos, PGR/APGR do roteador, fronteira de Pareto e AIQ do conjunto. */
export function renderRoutingSection(metrics: RoutingMetrics): string {
	const lines: string[] = [];
	lines.push("## Métricas de roteamento", "");
	lines.push("| ponto | tokens | solve_rate | fração forte |", "| --- | ---: | ---: | ---: |");
	for (const p of [metrics.weak, metrics.strong, ...(metrics.router ? [metrics.router] : []), ...metrics.others]) {
		lines.push(`| ${p.label} | ${p.tokens} | ${fmt(p.quality)} | ${fmt(p.strong_fraction)} |`);
	}
	lines.push("");
	if (metrics.router === null) {
		lines.push("Sem resultado do roteador: PGR, APGR e a comparação não se aplicam.", "");
	} else {
		lines.push(
			`- PGR do roteador (ponto único): ${fmt(metrics.pgr?.value ?? null)}${metrics.pgr?.reason ? ` (${metrics.pgr.reason})` : ""}`,
		);
		lines.push(
			`- APGR (curva fraco→roteador→forte): ${fmt(metrics.apgr?.value ?? null)}${metrics.apgr?.reason ? ` (${metrics.apgr.reason})` : ""}`,
		);
	}
	lines.push(`- Fronteira de Pareto (tokens, solve_rate): ${metrics.pareto.join(", ")}`);
	lines.push(
		`- AIQ do conjunto (1 ponto por política, x_max=${metrics.aiq.x_max}): ${fmt(metrics.aiq.value)}${metrics.aiq.reason ? ` (${metrics.aiq.reason})` : ""}`,
	);
	lines.push("");
	return `${lines.join("\n")}\n`;
}
