// Gate offline de integridade para fatias e tarefas externas importadas (experiments/external-queue/tasks/).
// Bloqueia vazamentos de .git, soluções ou oráculo; verifica pre/post patch e conformidade v4/v5 com --auth-mode faux.
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CONTRACT_ID,
	CONTRACT_V5_ID,
	checkLedgerConformance,
	executeRung,
	fauxRuntime,
	type PriceBook,
	textTurn,
	usage,
} from "@dv-agent/core";
import { type EvalTask, loadTask, runOracle } from "../oracle/verifier.ts";
import { applyUnifiedDiff } from "./patch_applier.ts";

export interface TaskManifestEntry {
	task_id: string;
	manifest_sha256: string;
	files: { path: string; sha256: string }[];
}

export interface IntakeManifest {
	schema: "dv-intake-manifest-v1";
	generated_at: string;
	dataset_sha256: string;
	tasks: TaskManifestEntry[];
}

export interface IntakeGateResult {
	task_id: string;
	ok: boolean;
	gate_errors: string[];
	violations: string[];
	dry_run_conformance?: {
		v4_ok: boolean;
		v5_ok: boolean;
	};
	manifest_entry?: TaskManifestEntry;
}

export interface IntakeBatchResult {
	ok: boolean;
	dataset_sha256: string;
	manifest_path?: string;
	tasks: IntakeGateResult[];
	violations: string[];
}

export interface ExternalTaskDefinition extends EvalTask {
	reference_patch?: string;
	gold_patch?: string;
}

/** Calcula SHA-256 estável contra variações de CRLF/LF em arquivos de texto. */
export function computeStableFileSha256(filePath: string): string {
	const buf = readFileSync(filePath);
	if (buf.includes(0x00)) {
		return createHash("sha256").update(buf).digest("hex");
	}
	const text = buf.toString("utf8").replace(/\r\n/g, "\n");
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Coleta e calcula os hashes de todos os arquivos da tarefa (excluindo .git) de forma determinística. */
export function hashTaskFiles(taskDir: string): { path: string; sha256: string }[] {
	const out: { path: string; sha256: string }[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				out.push({
					path: relative(taskDir, full).split(sep).join("/"),
					sha256: computeStableFileSha256(full),
				});
			}
		}
	};
	walk(taskDir);
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Executa uma verificação dry-run determinística com provider faux para aferir conformidade v4 e v5. */
async function dryRunFauxConformance(task: EvalTask): Promise<{ v4_ok: boolean; v5_ok: boolean }> {
	const tempOut = mkdtempSync(join(tmpdir(), "dv-dryrun-"));
	try {
		const ledgerPathV4 = join(tempOut, "ledger-v4.jsonl");
		const ledgerPathV5 = join(tempOut, "ledger-v5.jsonl");

		const makeOptions = (ledgerPath: string, contractId: string) => {
			const runtime = fauxRuntime("anthropic", ["dv-cheap"]);
			runtime.script([textTurn("Dry run faux check for intake gate", usage(100, 10, { reasoning: 0 }))]);
			const priceBook: PriceBook = {
				kind: "metered",
				id: "mock-free",
				source: "intake-dryrun",
				entries: {
					"anthropic/dv-cheap": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			};
			return {
				ledgerPath,
				runId: `dryrun-${contractId}`,
				harnessVariant: "intake-gate",
				referenceProvenance: { task_id: task.id, mode: "dry-run-faux" },
				datasetSha256: "0".repeat(64),
				taskDefinitionSha256: "0".repeat(64),
				model: runtime.modelOf("dv-cheap"),
				tools: [],
				prompt: task.prompt,
				streamFn: runtime.streamFn,
				priceBook,
				maxCostUsd: 0.05,
				contractId,
				doomLoopMaxIdenticalConsecutive: 3,
			};
		};

		await executeRung(makeOptions(ledgerPathV4, CONTRACT_ID));
		const confV4 = checkLedgerConformance(ledgerPathV4);

		await executeRung(makeOptions(ledgerPathV5, CONTRACT_V5_ID));
		const confV5 = checkLedgerConformance(ledgerPathV5);

		return {
			v4_ok: confV4.ok,
			v5_ok: confV5.ok,
		};
	} finally {
		rmSync(tempOut, { recursive: true, force: true });
	}
}

/**
 * Valida uma única tarefa candidata aplicando as regras estritas do gate offline.
 */
export async function validateTaskIntake(taskDir: string): Promise<IntakeGateResult> {
	const gateErrors: string[] = [];

	let task: ExternalTaskDefinition;
	try {
		task = loadTask(taskDir) as ExternalTaskDefinition;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			task_id: "unknown",
			ok: false,
			gate_errors: [`SCHEMA_VIOLATION: ${msg}`],
			violations: [`schema inválido em ${taskDir}: ${msg}`],
		};
	}

	const task_id = task.id;
	const taskDirReal = resolve(taskDir);
	const workspaceDir = resolve(taskDirReal, task.workspace_dir);
	const oracleDir = resolve(taskDirReal, task.oracle.dir);
	const within = (root: string, target: string): boolean => {
		const path = relative(root, target);
		return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
	};
	if (!within(taskDirReal, workspaceDir) || !within(taskDirReal, oracleDir)) {
		gateErrors.push("SCHEMA_VIOLATION: workspace_dir e oracle.dir devem permanecer dentro do diretório da tarefa");
	}
	if (!existsSync(workspaceDir) || !lstatSync(workspaceDir).isDirectory()) {
		gateErrors.push(`SCHEMA_VIOLATION: workspace ausente ou inválido: ${workspaceDir}`);
	}
	if (!existsSync(oracleDir) || !lstatSync(oracleDir).isDirectory()) {
		gateErrors.push(`SCHEMA_VIOLATION: diretório do oráculo ausente ou inválido: ${oracleDir}`);
	}

	// 1. Isolamento do oráculo fora do workspace exposto (ORACLE_PATH_LEAK)
	const relOracleToWorkspace = relative(workspaceDir, oracleDir);
	const oracleInsideWorkspace =
		!relOracleToWorkspace.startsWith("..") && !isAbsolute(relOracleToWorkspace) && relOracleToWorkspace !== "";
	if (oracleInsideWorkspace || oracleDir === workspaceDir) {
		gateErrors.push(`ORACLE_PATH_LEAK: diretório do oráculo (${oracleDir}) reside dentro do workspace exposto`);
	}

	// 2. Bloqueio de vazamento de .git (GIT_LEAK_DETECTED) e solução (SOLUTION_LEAK_DETECTED)
	if (existsSync(workspaceDir)) {
		const walkWorkspace = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				const rel = relative(workspaceDir, full).split(sep).join("/");
				const lowerName = entry.name.toLowerCase();

				if (lowerName === ".git") {
					gateErrors.push(`GIT_LEAK_DETECTED: vazamento de .git detectado no workspace exposto: ${rel}`);
				}

				if (entry.isSymbolicLink()) {
					let pointsToOracle = false;
					try {
						const linkTarget = resolve(dir, readlinkSync(full));
						pointsToOracle = within(oracleDir, linkTarget) || within(linkTarget, oracleDir);
					} catch {
						// Um symlink ilegível também é bloqueado abaixo (fail-closed).
					}
					gateErrors.push(
						`${pointsToOracle ? "ORACLE_PATH_LEAK" : "SYMLINK_LEAK_DETECTED"}: symlink proibido no workspace exposto: ${rel}`,
					);
					continue;
				}

				if (entry.isFile()) {
					const isSolutionFile =
						lowerName === "gold.patch" ||
						lowerName === "solution.patch" ||
						lowerName === "reference.patch" ||
						lowerName === "reference_patch" ||
						(task.reference_patch && lowerName === task.reference_patch.toLowerCase()) ||
						(task.gold_patch && lowerName === task.gold_patch.toLowerCase());

					if (isSolutionFile) {
						gateErrors.push(`SOLUTION_LEAK_DETECTED: arquivo de solução vazado no workspace exposto: ${rel}`);
					}
				} else if (entry.isDirectory()) {
					walkWorkspace(full);
				}
			}
		};
		walkWorkspace(workspaceDir);
	}

	// Se já houver violação estrutural de vazamento, rejeita imediatamente (fail-closed)
	if (gateErrors.length > 0) {
		return {
			task_id,
			ok: false,
			gate_errors: gateErrors,
			violations: [...gateErrors],
		};
	}

	// 3. Verificação de que o oráculo reprova o estado inicial (PRE_PATCH_ORACLE_PASSED bloqueia)
	const tempPreOut = mkdtempSync(join(tmpdir(), "dv-intake-pre-"));
	try {
		const preResult = await runOracle({
			taskDir: taskDirReal,
			candidateDir: workspaceDir,
			outdir: tempPreOut,
		});
		if (preResult.verdict === "PASS" || preResult.outcome === "SOLVED") {
			gateErrors.push(
				`PRE_PATCH_ORACLE_PASSED: workspace inicial foi aprovado pelo oráculo antes da aplicação de patch`,
			);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gateErrors.push(`PRE_PATCH_ORACLE_EXECUTION_ERROR: falha ao rodar oráculo inicial: ${msg}`);
	} finally {
		rmSync(tempPreOut, { recursive: true, force: true });
	}

	// 4. Verificação de aprovação da referência pós-patch quando declarada (GOLD_PATCH_FAILED bloqueia)
	let patchPath: string | undefined;
	if (task.reference_patch) {
		patchPath = resolve(taskDirReal, task.reference_patch);
	} else if (task.gold_patch) {
		patchPath = resolve(taskDirReal, task.gold_patch);
	} else {
		for (const candidate of ["gold.patch", "solution.patch", "reference.patch"]) {
			const candidatePath = join(taskDirReal, candidate);
			if (existsSync(candidatePath)) {
				patchPath = candidatePath;
				break;
			}
		}
	}

	if (!patchPath) {
		gateErrors.push(
			"GOLD_PATCH_FAILED: tarefa externa não declara um patch de referência (reference_patch ou gold_patch)",
		);
	} else if (!within(taskDirReal, patchPath) || within(workspaceDir, patchPath)) {
		gateErrors.push("GOLD_PATCH_FAILED: patch de referência deve existir fora do workspace e dentro da tarefa");
	} else if (!existsSync(patchPath) || !lstatSync(patchPath).isFile()) {
		gateErrors.push(`GOLD_PATCH_FAILED: patch de referência ausente ou inválido: ${patchPath}`);
	} else {
		const tempCandidate = mkdtempSync(join(tmpdir(), "dv-intake-patched-cand-"));
		const tempPostOut = mkdtempSync(join(tmpdir(), "dv-intake-post-"));
		try {
			cpSync(workspaceDir, tempCandidate, { recursive: true });
			const patchContent = readFileSync(patchPath, "utf8");
			try {
				applyUnifiedDiff(patchContent, tempCandidate);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				gateErrors.push(`GOLD_PATCH_FAILED: falha ao aplicar patch de referência (${patchPath}): ${msg}`);
			}

			if (gateErrors.length === 0) {
				const postResult = await runOracle({
					taskDir: taskDirReal,
					candidateDir: tempCandidate,
					outdir: tempPostOut,
				});
				if (postResult.verdict !== "PASS" || postResult.outcome !== "SOLVED") {
					gateErrors.push(
						`GOLD_PATCH_FAILED: referência pós-patch reprovada pelo oráculo (veredicto: ${postResult.verdict}, desfecho: ${postResult.outcome})`,
					);
				}
			}
		} finally {
			rmSync(tempCandidate, { recursive: true, force: true });
			rmSync(tempPostOut, { recursive: true, force: true });
		}
	}

	// 5. Dry-run determinístico com --auth-mode faux validando conformidade v4 / v5
	let dryRunConformance = { v4_ok: false, v5_ok: false };
	try {
		dryRunConformance = await dryRunFauxConformance(task);
		if (!dryRunConformance.v4_ok || !dryRunConformance.v5_ok) {
			gateErrors.push(
				`CONFORMANCE_FAILED: dry-run faux violou regras de conformidade (v4: ${dryRunConformance.v4_ok}, v5: ${dryRunConformance.v5_ok})`,
			);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gateErrors.push(`CONFORMANCE_FAILED: erro no dry-run faux: ${msg}`);
	}

	if (gateErrors.length > 0) {
		return {
			task_id,
			ok: false,
			gate_errors: gateErrors,
			violations: [...gateErrors],
			dry_run_conformance: dryRunConformance,
		};
	}

	// 6. Geração de manifesto imutável da tarefa
	const files = hashTaskFiles(taskDirReal);
	const filesCanonical = `${JSON.stringify(files)}\n`.replace(/\r\n/g, "\n");
	const manifest_sha256 = createHash("sha256").update(filesCanonical).digest("hex");

	const manifestEntry: TaskManifestEntry = {
		task_id,
		manifest_sha256,
		files,
	};

	return {
		task_id,
		ok: true,
		gate_errors: [],
		violations: [],
		dry_run_conformance: dryRunConformance,
		manifest_entry: manifestEntry,
	};
}

/**
 * Valida todas as tarefas pendentes na fila de tarefas externas e gera o manifesto consolidado.
 */
export async function validateTasksBatch(tasksRootDir: string, manifestOutputDir?: string): Promise<IntakeBatchResult> {
	if (!existsSync(tasksRootDir)) {
		return {
			ok: true,
			dataset_sha256: "0".repeat(64),
			tasks: [],
			violations: [],
		};
	}

	const taskDirs: string[] = [];
	for (const entry of readdirSync(tasksRootDir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const candidate = join(tasksRootDir, entry.name);
			if (existsSync(join(candidate, "task.json"))) {
				taskDirs.push(candidate);
			}
		}
	}

	const taskResults: IntakeGateResult[] = [];
	const allViolations: string[] = [];
	const manifestEntries: TaskManifestEntry[] = [];

	for (const dir of taskDirs) {
		const result = await validateTaskIntake(dir);
		taskResults.push(result);
		if (!result.ok) {
			allViolations.push(...result.violations);
		} else if (result.manifest_entry) {
			manifestEntries.push(result.manifest_entry);
		}
	}

	// Ordena por (task_id, manifest_sha256)
	manifestEntries.sort((a, b) => {
		const cmp = a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
		return cmp !== 0 ? cmp : a.manifest_sha256.localeCompare(b.manifest_sha256);
	});

	// Calcula dataset_sha256 determinístico com eol=lf
	const tasksPayload = `${JSON.stringify(manifestEntries, null, 2)}\n`.replace(/\r\n/g, "\n");
	const dataset_sha256 = createHash("sha256").update(tasksPayload).digest("hex");

	let manifestPath: string | undefined;
	if (manifestOutputDir && manifestEntries.length > 0) {
		mkdirSync(manifestOutputDir, { recursive: true });
		manifestPath = join(manifestOutputDir, "manifest.json");
		const manifest: IntakeManifest = {
			schema: "dv-intake-manifest-v1",
			generated_at: new Date().toISOString(),
			dataset_sha256,
			tasks: manifestEntries,
		};
		const outText = `${JSON.stringify(manifest, null, 2)}\n`.replace(/\r\n/g, "\n");
		writeFileSync(manifestPath, outText, "utf8");
	}

	return {
		ok: allViolations.length === 0,
		dataset_sha256,
		manifest_path: manifestPath,
		tasks: taskResults,
		violations: allViolations,
	};
}
