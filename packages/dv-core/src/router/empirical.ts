// Índice empírico determinístico para roteamento. Não faz I/O; a leitura/partição dos resumos fica em dv-eval.
import { createHash } from "node:crypto";

export interface EmpiricalObservation {
	taskId: string;
	category: string;
	model: string;
	verdict: "PASS" | "FAIL";
	ledgerSha256: string;
}

export interface EmpiricalIndexSource {
	path: string;
	sha256: string;
}

export interface EmpiricalStats {
	n: number;
	failures: number;
	failureRate: number;
}

export interface EmpiricalFailureIndex {
	schema: "dv-empirical-failure-index-v1";
	partition: "calibration";
	sources: EmpiricalIndexSource[];
	indexSha256: string;
	observations: EmpiricalObservation[];
	byTask: Record<string, EmpiricalStats>;
	byCategory: Record<string, EmpiricalStats>;
}

export interface EmpiricalRouteEvidence {
	partition: "calibration";
	sources: EmpiricalIndexSource[];
	index_sha256: string;
	match: "task" | "category" | "none";
	task_id: string;
	category: string;
	model: string;
	n: number;
	failures: number;
	failure_rate: number | null;
	n_min: number;
	failure_threshold: number;
	start_rung: number;
	reason: string;
}

function key(taskOrCategory: string, model: string): string {
	return `${taskOrCategory}\u0000${model}`;
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function aggregate(observations: readonly EmpiricalObservation[]): Record<string, EmpiricalStats> {
	const counts = new Map<string, { n: number; failures: number }>();
	for (const item of observations) {
		const id = key(item.taskId, item.model);
		const value = counts.get(id) ?? { n: 0, failures: 0 };
		value.n += 1;
		if (item.verdict === "FAIL") value.failures += 1;
		counts.set(id, value);
	}
	return Object.fromEntries(
		[...counts.entries()]
			.sort(([a], [b]) => compare(a, b))
			.map(([id, value]) => [id, { ...value, failureRate: value.failures / value.n }]),
	);
}

/** Constrói um índice estável. Repetir o mesmo ledger não infla n; hash conflitante é erro. */
export function buildEmpiricalFailureIndex(
	observations: readonly EmpiricalObservation[],
	sources: readonly EmpiricalIndexSource[],
): EmpiricalFailureIndex {
	const uniqueSources = [...new Map(sources.map((source) => [source.path, source])).values()].sort((a, b) =>
		compare(a.path, b.path),
	);
	const seenLedgers = new Map<string, string>();
	const unique: EmpiricalObservation[] = [];
	for (const observation of observations) {
		if (!/^[a-f0-9]{64}$/i.test(observation.ledgerSha256)) {
			throw new Error(`ledger_sha256 inválido no histórico: ${observation.taskId}`);
		}
		const signature = [observation.taskId, observation.category, observation.model, observation.verdict].join("\u0000");
		const previous = seenLedgers.get(observation.ledgerSha256);
		if (previous !== undefined) {
			if (previous !== signature)
				throw new Error(`ledger_sha256 repetido com conteúdo conflitante: ${observation.ledgerSha256}`);
			continue;
		}
		seenLedgers.set(observation.ledgerSha256, signature);
		unique.push({ ...observation });
	}
	unique.sort(
		(a, b) => compare(key(a.taskId, a.model), key(b.taskId, b.model)) || compare(a.ledgerSha256, b.ledgerSha256),
	);
	const byTask = aggregate(unique);
	const byCategory = aggregate(unique.map((item) => ({ ...item, taskId: item.category })));
	const indexSha256 = createHash("sha256")
		.update(
			JSON.stringify({
				partition: "calibration",
				source_sha256: uniqueSources.map((source) => source.sha256).sort(compare),
				observations: unique,
			}),
		)
		.digest("hex");
	return {
		schema: "dv-empirical-failure-index-v1",
		partition: "calibration",
		sources: uniqueSources,
		indexSha256,
		observations: unique,
		byTask,
		byCategory,
	};
}

/** Decide conservadoramente: exact task -> category; sem n suficiente ou taxa baixa, permanece no rung 0. */
export function chooseEmpiricalStartRung(
	index: EmpiricalFailureIndex | undefined,
	query: {
		taskId: string;
		category: string;
		model: string;
		rungCount: number;
		nMin?: number;
		failureThreshold?: number;
	},
): EmpiricalRouteEvidence {
	const nMin = query.nMin ?? 3;
	const failureThreshold = query.failureThreshold ?? 0.67;
	if (!Number.isInteger(nMin) || nMin < 1) throw new Error(`nMin inválido: ${nMin}`);
	if (!Number.isFinite(failureThreshold) || failureThreshold < 0 || failureThreshold > 1) {
		throw new Error(`failureThreshold inválido: ${failureThreshold}`);
	}
	const exact = index?.byTask[key(query.taskId, query.model)];
	const category = index?.byCategory[key(query.category, query.model)];
	const matched =
		exact !== undefined && exact.n >= nMin
			? { scope: "task" as const, stats: exact }
			: category !== undefined && category.n >= nMin
				? { scope: "category" as const, stats: category }
				: exact !== undefined
					? { scope: "task" as const, stats: exact }
					: category !== undefined
						? { scope: "category" as const, stats: category }
						: undefined;
	const qualified = matched !== undefined && matched.stats.n >= nMin;
	const skip = qualified && matched.stats.failureRate >= failureThreshold && query.rungCount > 1;
	const startRung = skip ? 1 : 0;
	const n = matched?.stats.n ?? 0;
	const failures = matched?.stats.failures ?? 0;
	const failureRate = matched?.stats.failureRate ?? null;
	let reason: string;
	if (index === undefined || matched === undefined) {
		reason = `sem histórico aplicável para task=${query.taskId}, categoria=${query.category}, modelo=${query.model}; startRung=0`;
	} else if (!qualified) {
		reason = `histórico insuficiente (${matched.scope}, n=${n} < n_min=${nMin}, falhas=${failures}/${n}); startRung=0`;
	} else if (skip) {
		reason = `falha histórica alta (${matched.scope}, ${failures}/${n}=${failureRate?.toFixed(4)} >= ${failureThreshold}); startRung=1`;
	} else {
		reason = `falha histórica abaixo do limiar (${matched.scope}, ${failures}/${n}=${failureRate?.toFixed(4)} < ${failureThreshold}); startRung=0`;
	}
	return {
		partition: "calibration",
		sources: index?.sources ?? [],
		index_sha256: index?.indexSha256 ?? createHash("sha256").update("empty-calibration-index").digest("hex"),
		match: matched?.scope ?? "none",
		task_id: query.taskId,
		category: query.category,
		model: query.model,
		n,
		failures,
		failure_rate: failureRate,
		n_min: nMin,
		failure_threshold: failureThreshold,
		start_rung: startRung,
		reason,
	};
}
