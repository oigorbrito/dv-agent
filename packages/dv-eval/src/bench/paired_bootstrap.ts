// Bootstrap pareado por tarefa para comparar duas políticas em resumos dv-bench.
// As unidades são tarefas; réplicas da mesma tarefa permanecem agrupadas no mesmo bootstrap draw.
import type { BenchReport, RunRecord } from "./report.ts";

export const DEFAULT_PAIRED_BOOTSTRAP_SEED = 20261123;
export const DEFAULT_PAIRED_BOOTSTRAP_RESAMPLES = 10_000;

export interface BootstrapDifference {
	/** Média não ponderada das diferenças por tarefa (policyB - policyA). */
	estimate: number | null;
	ci95: [number, number] | null;
	units: number;
	defined_resamples: number;
	resamples: number;
	reason: string | null;
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

function summarize(units: readonly number[], random: () => number, resamples: number): BootstrapDifference {
	if (units.length === 0) {
		return {
			estimate: null,
			ci95: null,
			units: 0,
			defined_resamples: 0,
			resamples,
			reason: "no paired measurable task values",
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
	};
}

function collectPolicyRuns(reports: readonly BenchReport[], policy: string): Map<string, RunRecord> {
	const records = new Map<string, RunRecord>();
	for (const report of reports) {
		for (const run of report.runs) {
			if (run.policy !== policy) continue;
			const key = `${run.task_id}\u0000${run.repeat}`;
			if (records.has(key)) throw new Error(`duplicate paired run for ${policy}: ${run.task_id}/rep-${run.repeat}`);
			records.set(key, run);
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

function taskDifferences(
	keys: readonly string[],
	a: ReadonlyMap<string, RunRecord>,
	b: ReadonlyMap<string, RunRecord>,
	value: (run: RunRecord) => number | undefined,
): number[] {
	const byTask = new Map<string, number[]>();
	for (const key of keys) {
		const left = a.get(key);
		const right = b.get(key);
		if (left === undefined || right === undefined) continue;
		const x = value(left);
		const y = value(right);
		if (x === undefined || y === undefined) continue;
		const values = byTask.get(left.task_id) ?? [];
		values.push(y - x);
		byTask.set(left.task_id, values);
	}
	return [...byTask.entries()]
		.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
		.flatMap(([, values]) => {
			const result = mean(values);
			return result === undefined ? [] : [result];
		});
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

	const a = collectPolicyRuns(reports, options.policyA);
	const b = collectPolicyRuns(reports, options.policyB);
	if (a.size === 0 || b.size === 0) throw new Error(`missing runs for ${options.policyA} or ${options.policyB}`);
	const keysA = [...a.keys()].sort();
	const keysB = [...b.keys()].sort();
	if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index]))
		throw new Error("policies have different task/repeat sets; paired bootstrap requires identical runs");
	const tasks = new Set(keysA.map((key) => a.get(key)?.task_id).filter((id): id is string => id !== undefined));
	const repeats = new Set(keysA.map((key) => a.get(key)?.repeat).filter((n): n is number => n !== undefined));
	const passDiffs = taskDifferences(keysA, a, b, (run) => (run.solved ? 1 : 0));
	const tokenDiffs = taskDifferences(keysA, a, b, stepTokens);
	const costDiffs = taskDifferences(keysA, a, b, stepCost);

	// Uma única sequência de PRNG, usada em ordem fixa para resultados inteiramente reprodutíveis.
	const random = seededRandom(seed);
	return {
		policy_a: options.policyA,
		policy_b: options.policyB,
		seed,
		resamples,
		tasks: tasks.size,
		repeats: repeats.size,
		pass_rate_difference: summarize(passDiffs, random, resamples),
		total_tokens_difference: summarize(tokenDiffs, random, resamples),
		cost_usd_difference: summarize(costDiffs, random, resamples),
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
		`- tarefas: ${result.tasks}; réplicas distintas: ${result.repeats}; seed: ${result.seed}; reamostragens: ${result.resamples}`,
		"",
		"| métrica | diferença | IC 95% | unidades |",
		"| --- | ---: | ---: | ---: |",
	];
	for (const [label, metric] of [
		["pass rate", result.pass_rate_difference],
		["total tokens", result.total_tokens_difference],
		["custo USD", result.cost_usd_difference],
	] as const) {
		const interval =
			metric.ci95 === null ? `n/a (${metric.reason})` : `[${fmt(metric.ci95[0])}, ${fmt(metric.ci95[1])}]`;
		lines.push(`| ${label} | ${fmt(metric.estimate)} | ${interval} | ${metric.units} |`);
	}
	lines.push("", "Diferenças negativas indicam valor menor em policyB; pass rate mede `solved / runs`.", "");
	return `${lines.join("\n")}\n`;
}
