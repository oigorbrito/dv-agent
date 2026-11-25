// Fatia externa congelada (manifesto dv-external-slice-manifest-v1): construção pelo intake_gate fail-closed,
// verificação offline de integridade (hashes por arquivo, manifest_sha256 e dataset_sha256) e carregamento verificado.
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	computeDatasetSha256,
	computeManifestSha256,
	hashTaskFiles,
	type TaskManifestEntry,
	validateTasksBatch,
} from "./intake_gate.ts";

export const SLICE_SCHEMA = "dv-external-slice-manifest-v1" as const;
export const SLICE_TASKS_DIR = "tasks";

export interface SliceProvenance {
	source_repo: string;
	source_url: string;
	source_tree_sha: string;
	source_license: string;
	retrieved_on: string;
	/** Como cada tarefa foi obtida: fonte original, adaptação e o que foi alterado. */
	tasks: Record<string, { source: string; adaptation: string }>;
}

export interface SliceTaskEntry extends TaskManifestEntry {
	tier: string;
}

export interface SliceManifest {
	schema: typeof SLICE_SCHEMA;
	slice_id: string;
	provenance: SliceProvenance;
	gate: { name: "intake_gate"; fail_closed: true; dry_run_auth_mode: "faux" };
	tasks_dir: string;
	dataset_sha256: string;
	tasks: SliceTaskEntry[];
}

export interface SliceVerification {
	ok: boolean;
	errors: string[];
	tasksDir: string;
	manifest?: SliceManifest;
}

function readTier(taskDir: string): string {
	const raw = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as { tier?: unknown };
	return typeof raw.tier === "string" ? raw.tier : "unknown";
}

/**
 * Constrói o manifesto da fatia passando todas as tarefas pelo intake_gate. Falha (lança) se qualquer tarefa
 * for bloqueada: a fatia só é congelada com 100% das tarefas aprovadas.
 */
export async function buildSliceManifest(options: {
	sliceId: string;
	/** Diretório absoluto com as tarefas da fatia. */
	tasksDir: string;
	/** Caminho das tarefas relativo ao diretório do manifesto (gravado em tasks_dir). */
	tasksDirRelative?: string;
	provenance: SliceProvenance;
}): Promise<SliceManifest> {
	const batch = await validateTasksBatch(options.tasksDir);
	if (!batch.ok) {
		throw new Error(`intake_gate bloqueou a fatia: ${batch.violations.join("; ")}`);
	}
	const tasks: SliceTaskEntry[] = batch.tasks
		.map((result) => {
			if (!result.manifest_entry) throw new Error(`tarefa sem manifesto: ${result.task_id}`);
			const dir = join(options.tasksDir, result.task_id);
			return { ...result.manifest_entry, tier: readTier(dir) };
		})
		.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
	const dataset_sha256 = computeDatasetSha256(
		tasks.map((t) => ({ task_id: t.task_id, manifest_sha256: t.manifest_sha256, files: t.files })),
	);
	if (dataset_sha256 !== batch.dataset_sha256) {
		throw new Error("dataset_sha256 divergente entre gate e manifesto");
	}
	return {
		schema: SLICE_SCHEMA,
		slice_id: options.sliceId,
		provenance: options.provenance,
		gate: { name: "intake_gate", fail_closed: true, dry_run_auth_mode: "faux" },
		tasks_dir: options.tasksDirRelative ?? SLICE_TASKS_DIR,
		dataset_sha256,
		tasks,
	};
}

/**
 * Verificação offline de integridade: recalcula os hashes de cada arquivo e de cada tarefa a partir do disco
 * e compara com o manifesto. Também rejeita tarefas extras no diretório e manifestos adulterados.
 */
export function verifySliceManifest(manifestPath: string): SliceVerification {
	const manifestAbs = resolve(manifestPath);
	const errors: string[] = [];
	const base = dirname(manifestAbs);
	let manifest: SliceManifest | undefined;
	try {
		manifest = JSON.parse(readFileSync(manifestAbs, "utf8")) as SliceManifest;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, errors: [`manifesto ilegível: ${msg}`], tasksDir: join(base, SLICE_TASKS_DIR) };
	}
	const tasksDir = join(base, manifest.tasks_dir ?? SLICE_TASKS_DIR);
	if (manifest.schema !== SLICE_SCHEMA) errors.push(`schema inesperado: ${String(manifest.schema)}`);
	if (manifest.gate?.fail_closed !== true) errors.push("gate não declarado fail-closed");
	if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
		errors.push("manifesto sem tarefas");
		return { ok: false, errors, tasksDir, manifest };
	}

	const declared = new Set<string>();
	for (const entry of manifest.tasks) {
		declared.add(entry.task_id);
		const dir = join(tasksDir, entry.task_id);
		if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
			errors.push(`${entry.task_id}: diretório da tarefa ausente`);
			continue;
		}
		let actualTask: { id?: unknown } = {};
		try {
			actualTask = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as { id?: unknown };
		} catch {
			errors.push(`${entry.task_id}: task.json ilegível`);
		}
		if (actualTask.id !== entry.task_id) errors.push(`${entry.task_id}: id no task.json diverge do manifesto`);
		const actualFiles = hashTaskFiles(dir);
		const expectedFiles = entry.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
		const actualByPath = new Map(actualFiles.map((f) => [f.path, f.sha256]));
		const expectedByPath = new Map(expectedFiles.map((f) => [f.path, f.sha256]));
		for (const [path, sha] of expectedByPath) {
			const got = actualByPath.get(path);
			if (got === undefined) errors.push(`${entry.task_id}: arquivo ausente: ${path}`);
			else if (got !== sha) errors.push(`${entry.task_id}: arquivo adulterado: ${path}`);
		}
		for (const path of actualByPath.keys()) {
			if (!expectedByPath.has(path)) errors.push(`${entry.task_id}: arquivo não declarado: ${path}`);
		}
		if (computeManifestSha256(actualFiles) !== entry.manifest_sha256) {
			errors.push(`${entry.task_id}: manifest_sha256 não confere`);
		}
	}

	if (existsSync(tasksDir)) {
		for (const name of readdirSync(tasksDir)) {
			if (!declared.has(name)) errors.push(`tarefa não declarada no manifesto: ${name}`);
		}
	}

	const recomputed = computeDatasetSha256(
		manifest.tasks.map((t) => ({ task_id: t.task_id, manifest_sha256: t.manifest_sha256, files: t.files })),
	);
	if (recomputed !== manifest.dataset_sha256) errors.push("dataset_sha256 não confere com as tarefas declaradas");

	return { ok: errors.length === 0, errors, tasksDir, manifest };
}

/** Carrega o diretório de tarefas somente se a fatia passar na verificação de integridade. */
export function loadVerifiedSlice(manifestPath: string): { tasksDir: string; manifest: SliceManifest } {
	const result = verifySliceManifest(manifestPath);
	if (!result.ok || result.manifest === undefined) {
		throw new Error(`fatia externa rejeitada (${manifestPath}): ${result.errors.join("; ")}`);
	}
	return { tasksDir: result.tasksDir, manifest: result.manifest };
}

export function writeSliceManifest(manifestPath: string, manifest: SliceManifest): void {
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
