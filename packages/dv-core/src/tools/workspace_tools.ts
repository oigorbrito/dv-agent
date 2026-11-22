// Ferramentas nativas de workspace (AgentTool do pi-agent-core), confinadas a um workspaceRoot.
// read_file, write_file (atômica), edit_file (substituição exata verificada) e run_bash (não interativa, com timeout).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { assertCommandAllowed, realWorkspaceRoot, resolveInWorkspace, WorkspaceViolation } from "./confinement.ts";

export interface WorkspaceToolsOptions {
	/** Raiz do workspace. Deve existir. Todos os caminhos e o cwd de run_bash ficam dentro dela. */
	workspaceRoot: string;
	/** Timeout padrão de run_bash, em ms. */
	bashTimeoutMs?: number;
	/** Limite de bytes devolvidos ao modelo por leitura ou saída de comando (truncamento cabeça+cauda). */
	maxOutputBytes?: number;
}

const DEFAULT_BASH_TIMEOUT_MS = 60_000;
const MAX_BASH_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;
/** Captura máxima em memória por fluxo de run_bash, antes do truncamento. */
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

/** Cria as quatro ferramentas de workspace para um mesmo workspaceRoot. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): AgentTool[] {
	const rootReal = realWorkspaceRoot(options.workspaceRoot);
	const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const bashTimeout = options.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
	return [
		readFileTool(rootReal, maxOutput),
		writeFileTool(rootReal),
		editFileTool(rootReal),
		runBashTool(rootReal, maxOutput, bashTimeout),
	];
}

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

/** Trunca mantendo início e fim, para que diagnósticos finais de um comando não sumam. */
export function truncateHeadTail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const half = Math.floor(maxBytes / 2);
	const head = sliceChars(text, 0, half);
	const tail = sliceChars(text, text.length - half, text.length);
	const omitted = text.length - head.length - tail.length;
	return `${head}\n[... ${omitted} caracteres omitidos ...]\n${tail}`;
}

/** Fatia por caracteres sem separar um par substituto (surrogate pair) no corte. */
function sliceChars(text: string, start: number, end: number): string {
	let s = start;
	let e = end;
	if (s > 0 && isLowSurrogate(text.charCodeAt(s))) s += 1;
	if (e < text.length && isLowSurrogate(text.charCodeAt(e))) e -= 1;
	return text.slice(s, e);
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Escrita atômica: arquivo temporário no mesmo diretório, fsync, depois rename sobre o destino. */
export function atomicWriteFile(target: string, data: string): void {
	if (existsSync(target) && statSync(target).isDirectory()) {
		throw new WorkspaceViolation("invalid_path", `destino é um diretório: ${target}`);
	}
	mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const fd = openSync(temp, "wx");
		try {
			writeFileSync(fd, data, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function readFileTool(rootReal: string, maxOutput: number): AgentTool {
	return {
		name: "read_file",
		label: "read_file",
		description:
			"Lê um arquivo de texto do workspace. Use offset (linha inicial, 1-based) e limit (número de linhas) para trechos.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Caminho relativo ao workspace." },
				offset: { type: "integer", minimum: 1, description: "Primeira linha a ler (1-based)." },
				limit: { type: "integer", minimum: 1, description: "Máximo de linhas." },
			},
			required: ["path"],
		},
		execute: async (_id, params) => {
			const {
				path,
				offset = 1,
				limit = DEFAULT_READ_LINES,
			} = params as { path: string; offset?: number; limit?: number };
			const target = resolveInWorkspace(rootReal, path);
			const size = statSync(target).size;
			if (size > MAX_READ_FILE_BYTES) throw new Error(`arquivo grande demais (${size} bytes > ${MAX_READ_FILE_BYTES})`);
			const raw = readFileSync(target, "utf8");
			if (raw.includes("\0")) throw new Error(`arquivo binário, leitura de texto recusada: ${path}`);
			const lines = raw.split("\n");
			const first = Math.min(offset, lines.length + 1);
			const selected = lines.slice(first - 1, first - 1 + limit);
			const last = first - 1 + selected.length;
			if (selected.length === 0) {
				return textResult(`[${path}: offset ${offset} além do fim; arquivo tem ${lines.length} linhas]`, {
					path,
					total_lines: lines.length,
				});
			}
			const header = `[${path}: linhas ${first}-${last} de ${lines.length}]`;
			return textResult(`${header}\n${truncateHeadTail(selected.join("\n"), maxOutput)}`, {
				path,
				total_lines: lines.length,
				first_line: first,
				last_line: last,
			});
		},
	};
}

function writeFileTool(rootReal: string): AgentTool {
	return {
		name: "write_file",
		label: "write_file",
		description: "Cria ou sobrescreve um arquivo do workspace de forma atômica. Cria diretórios intermediários.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
		execute: async (_id, params) => {
			const { path, content } = params as { path: string; content: string };
			const target = resolveInWorkspace(rootReal, path);
			atomicWriteFile(target, content);
			return textResult(`gravado ${path} (${Buffer.byteLength(content, "utf8")} bytes)`, { path });
		},
	};
}

function editFileTool(rootReal: string): AgentTool {
	return {
		name: "edit_file",
		label: "edit_file",
		description:
			"Substitui um trecho exato (old_text) por new_text em um arquivo. Falha se old_text não existir ou aparecer mais de uma vez; nesse caso inclua mais contexto.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_text: { type: "string", minLength: 1 },
				new_text: { type: "string" },
			},
			required: ["path", "old_text", "new_text"],
		},
		execute: async (_id, params) => {
			const { path, old_text, new_text } = params as { path: string; old_text: string; new_text: string };
			if (old_text.length === 0) throw new Error("old_text vazio");
			if (old_text === new_text) throw new Error("old_text e new_text são idênticos: nada a alterar");
			const target = resolveInWorkspace(rootReal, path);
			const original = readFileSync(target, "utf8");
			// Arquivo com fim de linha CRLF: o trecho do modelo chega com LF, então converte para casar exatamente.
			const crlf = original.includes("\r\n") && !old_text.includes("\r\n");
			const needle = crlf ? old_text.replaceAll("\n", "\r\n") : old_text;
			const replacement = crlf ? new_text.replaceAll("\n", "\r\n") : new_text;
			const occurrences = countOccurrences(original, needle);
			if (occurrences === 0) {
				throw new Error(`trecho não encontrado em ${path}: confira espaços, indentação e quebras de linha`);
			}
			if (occurrences > 1) {
				throw new Error(`trecho ambíguo em ${path}: ${occurrences} ocorrências; inclua mais contexto em old_text`);
			}
			const index = original.indexOf(needle);
			const updated = original.slice(0, index) + replacement + original.slice(index + needle.length);
			atomicWriteFile(target, updated);
			return textResult(`editado ${path}: 1 substituição`, { path, replacements: 1 });
		},
	};
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let index = text.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

function runBashTool(rootReal: string, maxOutput: number, defaultTimeout: number): AgentTool {
	return {
		name: "run_bash",
		label: "run_bash",
		description:
			"Executa um comando não interativo no diretório do workspace, com timeout. Saída truncada. Comandos destrutivos e caminhos externos são recusados.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				timeout_ms: { type: "integer", minimum: 1000, maximum: MAX_BASH_TIMEOUT_MS },
			},
			required: ["command"],
		},
		execute: async (_id, params, signal) => {
			const { command, timeout_ms } = params as { command: string; timeout_ms?: number };
			assertCommandAllowed(command, rootReal);
			const timeoutMs = Math.min(timeout_ms ?? defaultTimeout, MAX_BASH_TIMEOUT_MS);
			const run = await runProcess(command, rootReal, timeoutMs, signal);
			const output = truncateHeadTail(run.output, maxOutput);
			if (run.timedOut) throw new Error(`timeout após ${timeoutMs} ms\n${output}`);
			if (run.exitCode !== 0) throw new Error(`saída ${run.exitCode}\n${output}`);
			return textResult(output === "" ? "(sem saída)" : output, { exit_code: 0, timed_out: false });
		},
	};
}

interface ProcessRun {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
}

/** Executa o comando com cwd fixo, stdin fechado, captura limitada e encerramento da árvore no timeout ou abort. */
function runProcess(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<ProcessRun> {
	return new Promise((resolvePromise, reject) => {
		const child: ChildProcess = spawn(command, {
			cwd,
			shell: true,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			// Em POSIX, grupo próprio para matar os filhos junto com o shell.
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const capture = (current: string, chunk: Buffer): string =>
			current.length >= MAX_CAPTURE_CHARS ? current : current + chunk.toString("utf8");
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = capture(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = capture(stderr, chunk);
		});
		const kill = (): void => killTree(child);
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = (): void => kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const output = stderr === "" ? stdout : `${stdout}${stdout === "" ? "" : "\n"}[stderr]\n${stderr}`;
			resolvePromise({ output, exitCode: code, timedOut });
		});
	});
}

/** Encerra o shell e seus filhos. Windows: taskkill /T. POSIX: grupo de processos. */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}
