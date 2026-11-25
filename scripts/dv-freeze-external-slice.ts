// Congela a fatia externa: passa todas as tarefas pelo intake_gate fail-closed (com dry-run faux) e grava o manifesto.
// Exemplo: node scripts/dv-freeze-external-slice.ts --slice-dir experiments/p1/external-terminal-bench-slice-v1
// Saída: experiments/p1/external-terminal-bench-slice-v1.json (dataset_sha256, tarefas, proveniência).
// Códigos de saída: 0 congelada; 1 erro de uso ou tarefa bloqueada pelo gate (nada é gravado).
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "../packages/dv-eval/src/cli/args.ts";
import {
	buildSliceManifest,
	SLICE_TASKS_DIR,
	type SliceProvenance,
	writeSliceManifest,
} from "../packages/dv-eval/src/intake/index.ts";

let args: Map<string, string | true>;
try {
	args = parseArgs(process.argv.slice(2), ["slice-dir", "manifest"]);
} catch (error) {
	console.error(`erro: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
const sliceDirArg = args.get("slice-dir");
if (typeof sliceDirArg !== "string") {
	console.error("erro: --slice-dir DIR é obrigatório");
	process.exit(1);
}
const sliceDir = resolve(sliceDirArg);
const sliceId = basename(sliceDir);
const manifestPath = resolve(
	typeof args.get("manifest") === "string" ? (args.get("manifest") as string) : `${sliceDir}.json`,
);
const tasksDir = join(sliceDir, SLICE_TASKS_DIR);
const provenance = JSON.parse(readFileSync(join(sliceDir, "provenance.json"), "utf8")) as SliceProvenance;

try {
	const manifest = await buildSliceManifest({
		sliceId,
		tasksDir,
		tasksDirRelative: relative(dirname(manifestPath), tasksDir).split("\\").join("/"),
		provenance,
	});
	writeSliceManifest(manifestPath, manifest);
	console.log(`ok: ${manifest.tasks.length} tarefa(s) congeladas em ${manifestPath}`);
	console.log(`dataset_sha256: ${manifest.dataset_sha256}`);
	for (const t of manifest.tasks) console.log(`  ${t.task_id} (${t.tier}) manifest_sha256=${t.manifest_sha256}`);
} catch (error) {
	console.error(`erro: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
