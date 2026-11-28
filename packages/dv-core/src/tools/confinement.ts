// Confinamento de caminhos e denylist de comandos para as ferramentas de workspace.
// A fronteira real das ferramentas de arquivo é o caminho resolvido (com realpath); a denylist de run_bash é defesa
// em profundidade e não é um sandbox de processo.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class WorkspaceViolation extends Error {
	readonly code: "path_traversal" | "destructive_command" | "invalid_path";

	constructor(code: WorkspaceViolation["code"], message: string) {
		super(message);
		this.name = "WorkspaceViolation";
		this.code = code;
	}
}

/** Raiz real do workspace (com symlinks resolvidos). Falha se a raiz não existir. */
export function realWorkspaceRoot(workspaceRoot: string): string {
	return realpathSync(resolve(workspaceRoot));
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Resolve um caminho relativo dentro do workspace. Recusa caminho absoluto, `..` que escape, e symlink/junction
 * cujo destino real esteja fora da raiz. Para arquivo ainda inexistente, confere o ancestral existente mais próximo.
 */
export function resolveInWorkspace(rootReal: string, input: string): string {
	if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
		throw new WorkspaceViolation("invalid_path", "caminho vazio ou inválido");
	}
	if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
		throw new WorkspaceViolation("path_traversal", `caminho absoluto recusado: ${input}`);
	}
	const target = resolve(rootReal, input);
	if (!isInside(rootReal, target)) {
		throw new WorkspaceViolation("path_traversal", `caminho fora do workspace: ${input}`);
	}
	// Procura o componente mais próximo que existe como entrada, inclusive link quebrado (lstat não segue o link).
	// existsSync seria falso para link quebrado e deixaria o caminho passar: um link para fora seria criado por escrita.
	let existing = target;
	while (!entryExists(existing) && existing !== dirname(existing)) existing = dirname(existing);
	let real: string;
	try {
		real = realpathSync(existing);
	} catch {
		// Link cujo destino não resolve: não é possível provar que fica dentro da raiz. Falha fechada.
		throw new WorkspaceViolation("path_traversal", `link sem destino resolvível no workspace: ${input}`);
	}
	if (!isInside(rootReal, real)) {
		throw new WorkspaceViolation("path_traversal", `caminho aponta para fora do workspace via link: ${input}`);
	}
	return target;
}

function entryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Tokens de comando que apontam para fora do workspace ou são destrutivos, com o motivo. */
const DESTRUCTIVE_PATTERNS: readonly [RegExp, string][] = [
	[/\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)\b/, "rm recursivo ou forçado"],
	[/\b(del|erase)\s+[^\n]*\/[sSqQ]\b/i, "del com /s ou /q"],
	[/\b(rd|rmdir)\s+[^\n]*\/[sS]\b/i, "rd/rmdir com /s"],
	[/\bRemove-Item\b[^\n]*-Recurse\b/i, "Remove-Item recursivo"],
	[/\bformat\s+[a-zA-Z]:/i, "format de unidade"],
	[/\b(mkfs|diskpart|shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b/i, "comando de sistema"],
	[/\bdd\s+[^\n]*\bof=/, "dd com saída"],
	[/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+[^\n]*(--force|-f)\b)/, "git destrutivo"],
	[/\b(chmod|chown)\s+-R\b/, "chmod/chown recursivo"],
	[/\b(sudo|runas)\b/, "elevação de privilégio"],
	[/\breg\s+delete\b/i, "reg delete"],
	[/\|\s*(sh|bash|zsh)\b/, "pipe para shell"],
	// Link simbólico pode apontar para fora sem passar pelos tokens de caminho (ex.: ln -s "$HOME/x" link).
	[/(^|[;&|(\s])ln\s/, "criação de link simbólico (ln)"],
	[/:\(\)\s*\{/, "fork bomb"],
];

const SAFE_ABSOLUTE = new Set(["/dev/null"]);

/** Recusa comando destrutivo ou com caminho que escape do workspace. Não garante isolamento de processo. */
export function assertCommandAllowed(command: string, rootReal: string): void {
	for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(command)) throw new WorkspaceViolation("destructive_command", `comando recusado (${reason})`);
	}
	const tokens = command
		.split(/[\s;&|()<>]+/)
		.map((t) => t.replace(/^["'`]+|["'`]+$/g, ""))
		.filter(Boolean);
	for (const token of tokens) {
		if (SAFE_ABSOLUTE.has(token)) continue;
		const escapesByPath = /(^|[\\/])\.\.([\\/]|$)/.test(token);
		// HOME em forma de variável também é caminho de home, mesmo sem o til.
		const home = token.startsWith("~") || /^\$\{?HOME\b/.test(token);
		const absolute = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(token);
		if (escapesByPath) throw new WorkspaceViolation("path_traversal", `comando com '..' recusado: ${token}`);
		if (home) throw new WorkspaceViolation("path_traversal", `comando com caminho home recusado: ${token}`);
		if (absolute && !isInside(rootReal, resolve(rootReal, token))) {
			throw new WorkspaceViolation("path_traversal", `comando com caminho fora do workspace recusado: ${token}`);
		}
	}
}
