// Loader dos históricos dv-bench. Isola a calibração pela partição registrada no corpus e detecta reuso de evidência.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	buildEmpiricalFailureIndex,
	type EmpiricalFailureIndex,
	type EmpiricalObservation,
	extractPythonSignals,
	extractTaskFeatures,
	type KnnExample,
	type SourceFile,
} from "@dv-agent/core";
import { discoverCorpus } from "./corpus.ts";
import { partitionTaskIds } from "./routing_calibration.ts";

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function inside(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Pure projection de summary.json -> observações verificáveis do degrau 0. */
export function observationsFromBenchSummary(
	input: unknown,
	options: { calibrationTaskIds: ReadonlySet<string>; tierByTask: ReadonlyMap<string, string>; sourcePath: string },
): EmpiricalObservation[] {
	const report = object(input);
	if (report === undefined || !["dv-bench-summary-v1", "dv-bench-summary-v2"].includes(String(report.schema))) {
		throw new Error(`summary de routing history inválido: ${options.sourcePath}`);
	}
	if (!Array.isArray(report.runs)) throw new Error(`summary sem runs: ${options.sourcePath}`);
	const observations: EmpiricalObservation[] = [];
	for (const rawRun of report.runs) {
		const run = object(rawRun);
		if (run === undefined || typeof run.task_id !== "string" || typeof run.tier !== "string") {
			throw new Error(`run inválido em ${options.sourcePath}`);
		}
		const taskId = run.task_id;
		if (!options.calibrationTaskIds.has(taskId)) {
			throw new Error(`data leakage recusado: ${taskId} não pertence à partição de calibração (${options.sourcePath})`);
		}
		if (options.tierByTask.get(taskId) !== run.tier) {
			throw new Error(`tier inconsistente para ${taskId} em ${options.sourcePath}`);
		}
		if (run.tier === "negative") continue;
		if (!Array.isArray(run.steps)) throw new Error(`run ${taskId} sem steps em ${options.sourcePath}`);
		for (const rawStep of run.steps) {
			const step = object(rawStep);
			if (step?.rung !== 0 || (step.verdict !== "PASS" && step.verdict !== "FAIL")) continue;
			if (typeof step.model !== "string" || !/^[^/]+\/.+$/.test(step.model)) {
				throw new Error(`modelo inválido no rung 0 de ${taskId} (${options.sourcePath})`);
			}
			if (typeof step.ledger_sha256 !== "string") {
				throw new Error(`ledger_sha256 ausente no rung 0 de ${taskId} (${options.sourcePath})`);
			}
			observations.push({
				taskId,
				category: run.tier,
				model: step.model,
				verdict: step.verdict,
				ledgerSha256: step.ledger_sha256,
			});
		}
	}
	return observations;
}

/** Lê um ou mais summaries somente quando o chamador declara explicitamente calibração/treino. */
export function loadRoutingHistory(
	paths: readonly string[],
	options: { corpusDir: string; partition: "calibration" | "train" },
): EmpiricalFailureIndex {
	if (paths.length === 0) throw new Error("--routing-history requer ao menos um summary.json");
	if (options.partition !== "calibration" && options.partition !== "train") {
		throw new Error("routing history só aceita a partição explícita calibration/train");
	}
	const tasks = discoverCorpus(options.corpusDir);
	const partition = partitionTaskIds(tasks.map((task) => task.id));
	const calibrationTaskIds = new Set(partition.calibration);
	const tierByTask = new Map(tasks.map((task) => [task.id, task.tier]));
	const sources = new Map<string, { path: string; sha256: string }>();
	const observations: EmpiricalObservation[] = [];
	for (const rawPath of paths) {
		const path = resolve(rawPath);
		if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`routing history ausente: ${path}`);
		const bytes = readFileSync(path);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
		observations.push(
			...observationsFromBenchSummary(parsed, {
				calibrationTaskIds,
				tierByTask,
				sourcePath: path,
			}),
		);
		sources.set(path, { path, sha256: digest });
	}
	const index = buildEmpiricalFailureIndex(observations, [...sources.values()]);
	const obsByTask = new Map<string, { runs: number; failures: number }>();
	for (const obs of index.observations) {
		const s = obsByTask.get(obs.taskId) ?? { runs: 0, failures: 0 };
		s.runs += 1;
		if (obs.verdict === "FAIL") s.failures += 1;
		obsByTask.set(obs.taskId, s);
	}
	const knnExamples: KnnExample[] = [];
	for (const task of tasks) {
		if (!calibrationTaskIds.has(task.id)) continue;
		const stats = obsByTask.get(task.id);
		if (stats === undefined || stats.runs === 0) continue;
		const taskJson = JSON.parse(readFileSync(join(task.dir, "task.json"), "utf8")) as {
			prompt?: unknown;
			workspace_dir?: unknown;
		};
		const wsDir = join(task.dir, typeof taskJson.workspace_dir === "string" ? taskJson.workspace_dir : "workspace");
		const sourceFiles = collectWorkspaceFiles(wsDir);
		const signals = extractPythonSignals(sourceFiles);
		const specText = [
			typeof taskJson.prompt === "string" ? taskJson.prompt : "",
			...sourceFiles.filter((f) => f.path.endsWith(".md")).map((f) => f.content),
		].join("\n");
		knnExamples.push({
			taskId: task.id,
			partition: "calibration",
			features: extractTaskFeatures(specText, sourceFiles, signals),
			failedRung0: stats.failures / stats.runs >= 0.5,
		});
	}
	index.knnExamples = knnExamples;
	index.knnCalibrationIds = [...partition.calibration];
	index.knnHoldoutIds = [...partition.holdout];
	return index;
}

/** Impede que o índice inclua exatamente as execuções já gravadas no outdir que será roteado. */
export function assertNoRoutingHistoryLeakage(index: EmpiricalFailureIndex, outdir: string): void {
	const output = resolve(outdir);
	for (const source of index.sources) {
		if (inside(output, resolve(source.path))) {
			throw new Error(`data leakage recusado: histórico ${source.path} está dentro do outdir atual ${output}`);
		}
	}
	if (!existsSync(output)) return;
	const knownLedgers = new Set(index.observations.map((item) => item.ledgerSha256));
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const path = resolve(directory, name);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				walk(path);
				continue;
			}
			if (name === "ledger.jsonl") {
				const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
				if (knownLedgers.has(digest))
					throw new Error(`data leakage recusado: ledger do outdir atual já consta no histórico (${path})`);
			}
			if (name !== "summary.json") continue;
			let summary: Json | undefined;
			try {
				summary = object(JSON.parse(readFileSync(path, "utf8")) as unknown);
			} catch {
				continue;
			}
			if (summary === undefined) continue;
			const runs = Array.isArray(summary.runs) ? summary.runs : [];
			const smokeSteps = Array.isArray(summary.steps) ? summary.steps : [];
			for (const run of runs) assertStepHashes(run, knownLedgers, path);
			assertStepHashes({ steps: smokeSteps }, knownLedgers, path);
		}
	};
	walk(output);
}

function assertStepHashes(raw: unknown, knownLedgers: ReadonlySet<string>, path: string): void {
	const run = object(raw);
	if (!Array.isArray(run?.steps)) return;
	for (const stepRaw of run.steps) {
		const step = object(stepRaw);
		if (typeof step?.ledger_sha256 === "string" && knownLedgers.has(step.ledger_sha256)) {
			throw new Error(`data leakage recusado: ledger do outdir atual também consta no histórico (${path})`);
		}
	}
}

function collectWorkspaceFiles(rootDir: string, relBase = ""): SourceFile[] {
	if (!existsSync(rootDir)) return [];
	const out: SourceFile[] = [];
	for (const name of readdirSync(rootDir).sort()) {
		const full = join(rootDir, name);
		const rel = relBase === "" ? name : `${relBase}/${name}`;
		const st = statSync(full);
		if (st.isDirectory()) out.push(...collectWorkspaceFiles(full, rel));
		else if (st.isFile()) out.push({ path: rel, content: readFileSync(full, "utf8") });
	}
	return out;
}
