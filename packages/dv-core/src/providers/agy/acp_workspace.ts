// Handlers ACP v1 para fs e terminal. Todos os caminhos passam pelo confinamento do dv-core.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
	assertCommandAllowed,
	realWorkspaceRoot,
	resolveInWorkspace,
	WorkspaceViolation,
} from "../../tools/confinement.ts";
import { atomicWriteFile, truncateHeadTail } from "../../tools/workspace_tools.ts";

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const MAX_OUTPUT_LIMIT = 1024 * 1024;
const TERMINAL_TIMEOUT_MS = 60_000;
const MAX_TERMINALS = 8;

interface TerminalRecord {
	id: string;
	child: ChildProcess;
	output: string;
	outputLimit: number;
	truncated: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	exited: Promise<void>;
	timeout: ReturnType<typeof setTimeout>;
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("parâmetros ACP inválidos");
	return value as Record<string, unknown>;
}

function pathWithinRoot(root: string, input: unknown): string {
	if (typeof input !== "string" || input.length === 0 || !isAbsolute(input)) {
		throw new WorkspaceViolation("invalid_path", "ACP exige caminho absoluto");
	}
	const absolute = resolve(input);
	const rel = relative(root, absolute);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new WorkspaceViolation("path_traversal", "caminho ACP fora do workspace");
	}
	return resolveInWorkspace(root, rel || ".");
}

function captureTail(current: string, chunk: Buffer, limit: number): { value: string; truncated: boolean } {
	const next = current + chunk.toString("utf8");
	if (Buffer.byteLength(next, "utf8") <= limit) return { value: next, truncated: false };
	const bytes = Buffer.from(next, "utf8");
	let start = Math.max(0, bytes.length - limit);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return { value: bytes.subarray(start).toString("utf8"), truncated: true };
}

/** Registra no JsonRpcConnection os métodos ACP v1 suportados pelo cliente. */
export function registerAcpWorkspaceHandlers(
	connection: { onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void },
	workspaceRoot: string,
	sessionId: string,
): { close(): Promise<void> } {
	const root = realWorkspaceRoot(workspaceRoot);
	const terminals = new Map<string, TerminalRecord>();
	let nextId = 1;
	const requireSession = (params: Record<string, unknown>): void => {
		if (params.sessionId !== sessionId) throw new Error("sessionId inválido");
	};
	const getTerminal = (params: Record<string, unknown>): TerminalRecord => {
		requireSession(params);
		const terminalId = params.terminalId;
		if (typeof terminalId !== "string") throw new Error("terminalId ausente");
		const terminal = terminals.get(terminalId);
		if (terminal === undefined) throw new Error("terminal inexistente ou liberado");
		return terminal;
	};
	connection.onRequest("fs/read_text_file", (raw) => {
		const params = object(raw);
		requireSession(params);
		const target = pathWithinRoot(root, params.path);
		const content = readFileSync(target, "utf8");
		if (content.includes("\0")) throw new Error("arquivo binário recusado");
		if (params.line === undefined && params.limit === undefined)
			return { content: truncateHeadTail(content, DEFAULT_OUTPUT_LIMIT) };
		const line = params.line ?? 1;
		const limit = params.limit ?? 2000;
		if (!Number.isInteger(line) || (line as number) < 1 || !Number.isInteger(limit) || (limit as number) < 1) {
			throw new Error("line/limit inválidos");
		}
		return {
			content: content
				.split("\n")
				.slice((line as number) - 1, (line as number) - 1 + (limit as number))
				.join("\n"),
		};
	});
	connection.onRequest("fs/write_text_file", (raw) => {
		const params = object(raw);
		requireSession(params);
		if (typeof params.content !== "string") throw new Error("content inválido");
		atomicWriteFile(pathWithinRoot(root, params.path), params.content);
		return {};
	});
	connection.onRequest("terminal/create", (raw) => {
		const params = object(raw);
		requireSession(params);
		if (terminals.size >= MAX_TERMINALS) throw new Error("limite de terminais simultâneos atingido");
		if (typeof params.command !== "string" || params.command.length === 0) throw new Error("command inválido");
		const args = params.args ?? [];
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("args inválidos");
		const cwd = params.cwd === undefined ? root : pathWithinRoot(root, params.cwd);
		assertCommandAllowed([basename(params.command), ...(args as string[])].join(" "), root);
		const requestedLimit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
		if (!Number.isInteger(requestedLimit) || (requestedLimit as number) < 1)
			throw new Error("outputByteLimit inválido");
		const outputLimit = Math.min(requestedLimit as number, MAX_OUTPUT_LIMIT);
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (params.env !== undefined) {
			if (!Array.isArray(params.env)) throw new Error("env inválido");
			for (const entry of params.env) {
				const item = object(entry);
				if (
					typeof item.name !== "string" ||
					!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) ||
					typeof item.value !== "string"
				) {
					throw new Error("entrada env inválida");
				}
				if (["PATH", "PATHEXT", "COMSPEC", "HOME", "USERPROFILE"].includes(item.name.toUpperCase())) {
					throw new Error(`override de ${item.name} recusado`);
				}
				env[item.name] = item.value;
			}
		}
		const child = spawn(params.command, args as string[], {
			cwd,
			env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const id = `dv-terminal-${nextId++}`;
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolvePromise) => {
			resolveExit = resolvePromise;
		});
		const terminal: TerminalRecord = {
			id,
			child,
			output: "",
			outputLimit,
			truncated: false,
			exitCode: null,
			signal: null,
			exited,
			timeout: setTimeout(() => killTerminal(terminal), TERMINAL_TIMEOUT_MS),
		};
		const append = (chunk: Buffer): void => {
			const result = captureTail(terminal.output, chunk, outputLimit);
			terminal.output = result.value;
			terminal.truncated ||= result.truncated;
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", () => {
			terminal.exitCode = 1;
			clearTimeout(terminal.timeout);
			resolveExit();
		});
		child.once("close", (code, signal) => {
			terminal.exitCode = code;
			terminal.signal = signal;
			clearTimeout(terminal.timeout);
			resolveExit();
		});
		terminals.set(id, terminal);
		return { terminalId: id };
	});
	connection.onRequest("terminal/output", (raw) => {
		const terminal = getTerminal(object(raw));
		return {
			output: terminal.output,
			truncated: terminal.truncated,
			...(terminal.exitCode === null && terminal.signal === null
				? {}
				: { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } }),
		};
	});
	connection.onRequest("terminal/wait_for_exit", async (raw) => {
		const terminal = getTerminal(object(raw));
		await terminal.exited;
		return { exitCode: terminal.exitCode, signal: terminal.signal };
	});
	connection.onRequest("terminal/kill", (raw) => {
		killTerminal(getTerminal(object(raw)));
		return {};
	});
	connection.onRequest("terminal/release", async (raw) => {
		const terminal = getTerminal(object(raw));
		if (terminal.exitCode === null && terminal.signal === null) {
			killTerminal(terminal);
			await terminal.exited;
		}
		terminals.delete(terminal.id);
		return {};
	});
	return {
		async close() {
			for (const terminal of terminals.values()) killTerminal(terminal);
			await Promise.all([...terminals.values()].map((terminal) => terminal.exited));
			terminals.clear();
		},
	};
}

function killTerminal(terminal: TerminalRecord): void {
	if (terminal.exitCode !== null || terminal.signal !== null) return;
	const pid = terminal.child.pid;
	if (pid === undefined) {
		terminal.child.kill("SIGKILL");
		return;
	}
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			terminal.child.kill("SIGKILL");
		}
	}
}
