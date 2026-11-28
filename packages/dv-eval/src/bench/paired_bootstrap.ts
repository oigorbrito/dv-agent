// Bootstrap pareado por tarefa para comparar duas políticas em resumos dv-bench.
// As unidades são tarefas; réplicas da mesma tarefa permanecem agrupadas no mesmo bootstrap draw.
import type { BenchReport, RunRecord } from "./report.ts";

export const DEFAULT_PAIRED_BOOTSTRAP_SEED = 20261120;
export const DEFAULT_PAIRED_BOOTSTRAP_RESAMPLES = 10_000;

export interface BootstrapDifference {
	/** Média não ponderada das diferenças por tarefa (policyB - policyA). */
	estimate: number | null;
	ci95: [number, number] | null;
	units: number;
	defined_resamples: number;
	resamples: number;
	reason: string | null;
	/** Pares (tarefa/réplica) fora da métrica por telemetria incompleta ou ausente. Vazio quando nenhum foi descartado. */
	excluded_pairs: string[];
}

export interface PairedBootstrapResult {
	policy_a: string;
	policy_b: string;
	seed: number;
	resamples: number;
	tasks: number;
	repeats: number;
	pass_rate_difference: BootstrapDifference;
	total_tokens_difference: BootstrapDifference;
	cost_usd_difference: BootstrapDifference;
	spent_lower_bound_usd_difference: BootstrapDifference;
	/** Quantos resumos contribuíram com o baseline (1 = baseline único, como antes). */
	baseline_arms: number;
	/** single: um braço de baseline (duplicata é erro). mean: média dos braços por (tarefa, réplica). */
	baseline_aggregation: "single" | "mean";
}

function quantileType7(sorted: readonly number[], q: number): number {
	const position = q * (sorted.length - 1);
	const low = Math.floor(position);
	const high = Math.ceil(position);
	const lowValue = sorted[low];
	const highValue = sorted[high];
	if (lowValue === undefined || highValue === undefined) throw new Error("quantile requires values");
	return lowValue + (highValue - lowValue) * (position - low);
}

/** Mulberry32: sequência estável entre execuções para o mesmo seed, sem dependências externas. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return (value ^ (value >>> 14)) >>> 0;
	};
}

function summarize(
	units: readonly number[],
	random: () => number,
	resamples: number,
	excluded_pairs: readonly string[],
): BootstrapDifference {
	if (units.length === 0) {
		return {
			estimate: null,
			ci95: null,
			units: 0,
			defined_resamples: 0,
			resamples,
			reason: "no paired measurable task values",
			excluded_pairs: [...excluded_pairs],
		};
	}
	const estimate = units.reduce((sum, value) => sum + value, 0) / units.length;
	const draws: number[] = [];
	for (let draw = 0; draw < resamples; draw += 1) {
		let sum = 0;
		for (let i = 0; i < units.length; i += 1) {
			sum += units[Math.floor((random() / 0x1_0000_0000) * units.length)] ?? 0;
		}
		draws.push(sum / units.length);
	}
	draws.sort((a, b) => a - b);
	return {
		estimate,
		ci95: [quantileType7(draws, 0.025), quantileType7(draws, 0.975)],
		units: units.length,
		defined_resamples: draws.length,
		resamples,
		reason: null,
		excluded_pairs: [...excluded_pairs],
	};
}

function collectPolicyRuns(
	reports: readonly BenchReport[],
	policy: string,
	allowMultiple: boolean,
): Map<string, RunRecord[]> {
	const records = new Map<string, RunRecord[]>();
	for (const report of reports) {
		for (const run of report.runs) {
			if (run.policy !== policy) continue;
			const key = `${run.task_id}\u0000${run.repeat}`;
			const list = records.get(key) ?? [];
			if (list.length > 0 && !allowMultiple)
				throw new Error(`duplicate paired run for ${policy}: ${run.task_id}/rep-${run.repeat}`);
			list.push(run);
			records.set(key, list);
		}
	}
	return records;
}

function mean(values: readonly number[]): number | undefined {
	return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stepTokens(run: RunRecord): number | undefined {
	if (run.steps.length === 0 || run.steps.some((step) => !step.metrics.telemetry_complete)) return undefined;
	return run.steps.reduce((sum, step) => sum + step.metrics.total_tokens, 0);
}

function stepCost(run: RunRecord): number | undefined {
	if (
		run.steps.length === 0 ||
		run.steps.some((step) => !step.metrics.telemetry_complete || step.metrics.cost_usd === null)
	)
		return undefined;
	return run.steps.reduce((sum, step) => sum + (step.metrics.cost_usd ?? 0), 0);
}

function spentLowerBound(run: RunRecord): number | undefined {
	return run.steps.length === 0 ? undefined : run.steps.reduce((sum, step) => sum + step.spent_lower_bound_usd, 0);
}

/** Média dos valores de um grupo de runs pareados; qualquer valor ausente torna o par indefinido (sem média parcial). */
function aggregateValue(runs: readonly RunRecord[], value: (run: RunRecord) => number | undefined): number | undefined {
	const values = runs.map(value);
	if (values.some((v) => v === undefined)) return undefined;
	return mean(values as number[]);
}

interface TaskDifferences {
	values: number[];
	/** Pares tarefa/réplica sem valor medível em um dos braços: ficam fora, e aparecem no resultado. */
	excluded: string[];
}

function taskDifferences(
	keys: readonly string[],
	a: ReadonlyMap<string, readonly RunRecord[]>,
	b: ReadonlyMap<string, readonly RunRecord[]>,
	value: (run: RunRecord) => number | undefined,
): TaskDifferences {
	const byTask = new Map<string, number[]>();
	const excluded: string[] = [];
	for (const key of keys) {
		const left = a.get(key);
		const right = b.get(key);
		if (left === undefined || right === undefined || left.length === 0 || right.length === 0) continue;
		const x = aggregateValue(left, value);
		const y = aggregateValue(right, value);
		const first = left[0] as RunRecord;
		if (x === undefined || y === undefined) {
			excluded.push(`${first.task_id}/rep-${first.repeat}`);
			continue;
		}
		const values = byTask.get(first.task_id) ?? [];
		values.push(y - x);
		byTask.set(first.task_id, values);
	}
	const values = [...byTask.entries()]
		.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
		.flatMap(([, taskValues]) => {
			const result = mean(taskValues);
			return result === undefined ? [] : [result];
		});
	return { values, excluded: excluded.sort() };
}

/**
 * Reamostra tarefas com reposição e preserva o pareamento A/B e as réplicas dentro de cada tarefa.
 * Tokens e custo em USD só entram quando todos os degraus daquele run têm telemetria completa;
 * custo também exige cost_usd numérico em todos os degraus. Diferença = policyB - policyA.
 */
export function computePairedBootstrap(
	reports: readonly BenchReport[],
	options: {
		policyA: string;
		policyB: string;
		seed?: number;
		resamples?: number;
		baselineAggregation?: "single" | "mean";
	},
): PairedBootstrapResult {
	const seed = options.seed ?? DEFAULT_PAIRED_BOOTSTRAP_SEED;
	const resamples = options.resamples ?? DEFAULT_PAIRED_BOOTSTRAP_RESAMPLES;
	if (reports.length === 0) throw new Error("sem resumos para bootstrap pareado");
	if (!options.policyA || !options.policyB || options.policyA === options.policyB)
		throw new Error("paired policies must be two distinct non-empty names");
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
		throw new Error("seed must be an integer in [0, 2^32-1]");
	if (!Number.isSafeInteger(resamples) || resamples < 1) throw new Error("resamples must be an integer >= 1");

	const aggregation = options.baselineAggregation ?? "single";
	const arms = reports.filter((report) => report.runs.some((run) => run.policy === options.policyA)).length;
	const a = collectPolicyRuns(reports, options.policyA, aggregation === "mean");
	const b = collectPolicyRuns(reports, options.policyB, false);
	if (a.size === 0 || b.size === 0) throw new Error(`missing runs for ${options.policyA} or ${options.policyB}`);
	if (aggregation === "mean") {
		if (arms < 2) throw new Error("baselineAggregation mean exige pelo menos dois resumos com o baseline");
		// Cada célula (tarefa, réplica) precisa de uma execução de cada braço: média de braços incompletos enganaria.
		for (const [key, runs] of a) {
			if (runs.length !== arms)
				throw new Error(`baseline incompleto para ${key.replace("\u0000", "/rep-")}: ${runs.length} de ${arms} braços`);
		}
	}
	const keysA = [...a.keys()].sort();
	const keysB = [...b.keys()].sort();
	if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index]))
		throw new Error("policies have different task/repeat sets; paired bootstrap requires identical runs");
	const tasks = new Set(keysA.map((key) => a.get(key)?.[0]?.task_id).filter((id): id is string => id !== undefined));
	const repeats = new Set(keysA.map((key) => a.get(key)?.[0]?.repeat).filter((n): n is number => n !== undefined));
	const passDiffs = taskDifferences(keysA, a, b, (run) => (run.solved ? 1 : 0));
	const tokenDiffs = taskDifferences(keysA, a, b, stepTokens);
	const costDiffs = taskDifferences(keysA, a, b, stepCost);
	const spentDiffs = taskDifferences(keysA, a, b, spentLowerBound);

	// Uma única sequência de PRNG, usada em ordem fixa para resultados inteiramente reprodutíveis.
	const random = seededRandom(seed);
	return {
		policy_a: options.policyA,
		policy_b: options.policyB,
		seed,
		resamples,
		tasks: tasks.size,
		repeats: repeats.size,
		pass_rate_difference: summarize(passDiffs.values, random, resamples, passDiffs.excluded),
		total_tokens_difference: summarize(tokenDiffs.values, random, resamples, tokenDiffs.excluded),
		cost_usd_difference: summarize(costDiffs.values, random, resamples, costDiffs.excluded),
		spent_lower_bound_usd_difference: summarize(spentDiffs.values, random, resamples, spentDiffs.excluded),
		baseline_arms: arms,
		baseline_aggregation: aggregation,
	};
}

function fmt(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(6);
}

/** Renderiza resultados com diferenças negativas significando menor valor em policyB. */
export function renderPairedBootstrap(result: PairedBootstrapResult): string {
	const lines = [
		"## Bootstrap pareado por tarefa",
		"",
		`- comparação: ${result.policy_b} - ${result.policy_a}`,
		`- pares comparados (n = tarefas): ${result.tasks}; réplicas distintas: ${result.repeats}; seed: ${result.seed}; reamostragens: ${result.resamples}`,
		"",
		"| métrica | diferença | IC 95% | unidades | IC exclui zero |",
		"| --- | ---: | ---: | ---: | :---: |",
	];
	for (const [label, metric] of [
		["solve_rate", result.pass_rate_difference],
		["total tokens", result.total_tokens_difference],
		["custo USD", result.cost_usd_difference],
		["spent_lower_bound_usd", result.spent_lower_bound_usd_difference],
	] as const) {
		const interval =
			metric.ci95 === null ? `n/a (${metric.reason})` : `[${fmt(metric.ci95[0])}; ${fmt(metric.ci95[1])}]`;
		const supported =
			metric.ci95 === null ? "indeterminada" : metric.ci95[0] > 0 || metric.ci95[1] < 0 ? "sim" : "não (IC cruza zero)";
		lines.push(`| ${label} | ${fmt(metric.estimate)} | ${interval} | ${metric.units} | ${supported} |`);
	}
	lines.push(
		"",
		"Diferenças = tratamento - baseline; valores negativos indicam redução. solve_rate mede `solved / runs`.",
	);
	const excludedLines = [
		["solve_rate", result.pass_rate_difference],
		["total tokens", result.total_tokens_difference],
		["custo USD", result.cost_usd_difference],
		["spent_lower_bound_usd", result.spent_lower_bound_usd_difference],
	] as const;
	for (const [label, metric] of excludedLines) {
		if (metric.excluded_pairs.length > 0)
			lines.push(
				`- pares excluídos de ${label} (telemetria ausente ou incompleta): ${metric.excluded_pairs.join(", ")}`,
			);
	}
	if (result.baseline_aggregation === "mean") {
		lines.push(
			`Baseline: média de ${result.baseline_arms} braços \`${result.policy_a}\` por (tarefa, réplica); cada braço conta com peso igual.`,
		);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
