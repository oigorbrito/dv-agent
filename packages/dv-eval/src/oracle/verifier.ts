// Oráculo externo: executa o verificador da tarefa fora do loop do agente, em cópia isolada, e grava result.json.
// O verificador vem da pasta da tarefa (não do workspace do agente), e o workspace é copiado sem symlinks.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import {
	checkLedgerConformance,
	classifyVerification,
	ledgerSha256,
	type OracleVerdict,
	type Verification,
} from "@dv-agent/core";
import { type LedgerSummary, readLedgerSummary } from "./ledger_summary.ts";

export const ORACLE_RESULT_SCHEMA = "dv-oracle-result-v1";

/** Tarefa calibrada: contrato mínimo lido de task.json. */
export interface EvalTask {
	schema: "dv-eval-task-v1";
	id: string;
	prompt: string;
	workspace_dir: string;
	oracle: { dir: string; command: string[]; timeout_ms: number };
}

export interface OracleInput {
	taskDir: string;
	candidateDir: string;
	outdir: string;
	ledgerPath?: string;
}

export interface OracleResult {
	schema: typeof ORACLE_RESULT_SCHEMA;
	task_id: string;
	/** PASS / FAIL / NO_VERDICT: veredito do verificador (exit 0 / 1 / outro ou timeout). */
	verdict: OracleVerdict;
	/** SOLVED / FAILURE / INCONCLUSIVE: derivado do veredito. */
	outcome: "SOLVED" | "FAILURE" | "INCONCLUSIVE";
	exit_code: number | null;
	timed_out: boolean;
	stdout_tail: string;
	stderr_tail: string;
	oracle: { entry: string; sha256: string };
	candidate: { files: { path: string; sha256: string }[] };
	ledger: {
		path: string;
		sha256: string;
		conformance_ok: boolean;
		violations: string[];
		summary: LedgerSummary;
	} | null;
	verification: Verification;
}

/** Lê task.json e valida o schema mínimo. */
export function loadTask(taskDir: string): EvalTask {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as EvalTask;
	if (task.schema !== "dv-eval-task-v1") throw new Error(`schema de tarefa inesperado: ${String(task.schema)}`);
	return task;
}

/** SHA-256 de cada arquivo regular do diretório (recursivo), ordenado por caminho relativo. */
export function hashTree(root: string): { path: string; sha256: string }[] {
	const out: { path: string; sha256: string }[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				out.push({
					path: relative(root, full).split(sep).join("/"),
					sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
				});
			}
		}
	};
	walk(root);
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Cópia do workspace do agente para o oráculo. Sem symlinks (um link não leva o verificador para fora) e sem
 * bytecode (__pycache__ ou .pyc plantado pelo agente não pode ser executado pelo verificador).
 */
export function copyCandidate(src: string, dst: string): void {
	cpSync(src, dst, {
		recursive: true,
		filter: (path) => {
			if (lstatSync(path).isSymbolicLink()) return false;
			const name = basename(path);
			return name !== "__pycache__" && !name.endsWith(".pyc");
		},
	});
}

function tail(text: string, max = 4000): string {
	return text.length <= max ? text : text.slice(text.length - max);
}

function verdictOf(exitCode: number | null, timedOut: boolean): OracleVerdict {
	if (timedOut || exitCode === null) return "NO_VERDICT";
	if (exitCode === 0) return "PASS";
	if (exitCode === 1) return "FAIL";
	return "NO_VERDICT";
}

const OUTCOME: Record<OracleVerdict, OracleResult["outcome"]> = {
	PASS: "SOLVED",
	FAIL: "FAILURE",
	NO_VERDICT: "INCONCLUSIVE",
};

/** Roda o verificador isolado e grava outdir/result.json. Não depende de nada que o agente tenha escrito além do workspace. */
export async function runOracle(input: OracleInput): Promise<OracleResult> {
	const task = loadTask(input.taskDir);
	const oracleDir = resolve(input.taskDir, task.oracle.dir);
	const entry = task.oracle.command[task.oracle.command.length - 1] ?? "";
	const isolated = mkdtempSync(join(tmpdir(), "dv-oracle-"));
	const workDir = join(isolated, "work");
	const verifierDir = join(isolated, "oracle");
	try {
		copyCandidate(input.candidateDir, workDir);
		cpSync(oracleDir, verifierDir, { recursive: true });
		const run = await execVerifier(task.oracle.command, verifierDir, workDir, task.oracle.timeout_ms);
		const verdict = verdictOf(run.exitCode, run.timedOut);
		const ledger = input.ledgerPath === undefined ? null : ledgerEvidence(input.ledgerPath);
		const verification = classifyVerification({
			oracle: verdict,
			doomLoopBlocks: ledger?.summary.doom_loop_blocks ?? 0,
			budgetTripped: ledger?.summary.run_status === "budget_exceeded",
			budgetUnverifiable: ledger?.summary.ceiling_status === "unverifiable",
			providerError: ledger?.summary.run_status === "provider_error",
		});
		const result: OracleResult = {
			schema: ORACLE_RESULT_SCHEMA,
			task_id: task.id,
			verdict,
			outcome: OUTCOME[verdict],
			exit_code: run.exitCode,
			timed_out: run.timedOut,
			stdout_tail: tail(run.stdout),
			stderr_tail: tail(run.stderr),
			oracle: {
				entry,
				sha256: createHash("sha256")
					.update(readFileSync(join(oracleDir, entry)))
					.digest("hex"),
			},
			candidate: { files: hashTree(input.candidateDir) },
			ledger,
			verification,
		};
		mkdirSync(input.outdir, { recursive: true });
		writeFileSync(join(input.outdir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
		return result;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

function ledgerEvidence(path: string): NonNullable<OracleResult["ledger"]> {
	const conformance = checkLedgerConformance(path);
	return {
		path,
		sha256: ledgerSha256(path),
		conformance_ok: conformance.ok,
		violations: conformance.violations,
		summary: readLedgerSummary(path),
	};
}

interface VerifierRun {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

/** Forma mínima de spawn usada pelo oráculo (injetável em teste). */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Executável alternativo para `python` quando ele não existe no PATH (ex.: WSL/Linux sem python-is-python3). */
const PYTHON_FALLBACK = "python3";

/**
 * Executa o comando do verificador com cwd no workspace copiado e PYTHONPATH apontando para ele.
 * Se o programa `python` falhar com ENOENT, tenta `python3`; qualquer outro caso mantém o comportamento original.
 */
export function execVerifier(
	command: string[],
	verifierDir: string,
	workDir: string,
	timeoutMs: number,
	spawnFn: SpawnFn = spawn,
): Promise<VerifierRun> {
	const [program, ...args] = command;
	if (program === undefined) throw new Error("comando do verificador vazio");
	const scriptArgs = args.map((arg) => (arg.endsWith(".py") ? join(verifierDir, arg) : arg));
	const launch = (exe: string): Promise<VerifierRun> =>
		new Promise((done, fail) => {
			const child = spawnFn(exe, scriptArgs, {
				cwd: workDir,
				env: { ...process.env, PYTHONPATH: workDir, PYTHONDONTWRITEBYTECODE: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.on("error", (error) => {
				clearTimeout(timer);
				fail(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				done({ exitCode: code, timedOut, stdout, stderr });
			});
		});
	return launch(program).catch((error: NodeJS.ErrnoException) => {
		if (program === "python" && error.code === "ENOENT") return launch(PYTHON_FALLBACK);
		throw error;
	});
}
