// Sinais estáticos do workspace, extraídos antes de qualquer chamada ao provedor. Funções puras: quem lê o disco é o chamador.

export interface SourceFile {
	/** Caminho relativo ao workspace, com `/` como separador. */
	path: string;
	content: string;
}

export interface StaticSignals {
	/** Arquivos-fonte Python no workspace (`.py`). */
	source_files: number;
	/** Linhas não vazias e não comentadas dos arquivos-fonte. */
	loc: number;
	/**
	 * Maior cadeia de módulos locais encadeados por import (contada em módulos). Módulo isolado vale 1;
	 * sem imports locais o valor é 1 quando há algum módulo, e 0 quando não há nenhum.
	 */
	import_depth: number;
}

const IMPORT_LINE = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/gm;

/** Nome de módulo a partir do caminho: `a/b.py` -> `a.b`, `a/__init__.py` -> `a`. */
function moduleName(path: string): string {
	const noExt = path.replace(/\.py$/, "");
	return noExt.endsWith("/__init__")
		? noExt.slice(0, -"/__init__".length).replace(/\//g, ".")
		: noExt.replace(/\//g, ".");
}

/** Resolve um import ao módulo local mais específico existente (`a.b.c` -> `a.b.c`, depois `a.b`, depois `a`). */
function resolveLocal(name: string, modules: ReadonlySet<string>): string | undefined {
	const parts = name.split(".");
	for (let n = parts.length; n >= 1; n--) {
		const candidate = parts.slice(0, n).join(".");
		if (modules.has(candidate)) return candidate;
	}
	return undefined;
}

export function extractPythonSignals(files: readonly SourceFile[]): StaticSignals {
	const sources = files.filter((f) => f.path.endsWith(".py")).sort((a, b) => (a.path < b.path ? -1 : 1));
	const loc = sources.reduce(
		(sum, f) =>
			sum + f.content.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trim().startsWith("#")).length,
		0,
	);

	const modules = new Set(sources.map((f) => moduleName(f.path)));
	const graph = new Map<string, Set<string>>();
	for (const file of sources) {
		const self = moduleName(file.path);
		const deps = new Set<string>();
		for (const match of file.content.matchAll(IMPORT_LINE)) {
			const target = resolveLocal(match[1] ?? match[2] ?? "", modules);
			if (target !== undefined && target !== self) deps.add(target);
		}
		graph.set(self, deps);
	}

	const depthOf = (node: string, stack: ReadonlySet<string>): number => {
		if (stack.has(node)) return 0; // ciclo de imports: não expande de novo
		const next = new Set(stack).add(node);
		let best = 0;
		for (const dep of [...(graph.get(node) ?? [])].sort()) best = Math.max(best, depthOf(dep, next));
		return 1 + best;
	};

	let importDepth = 0;
	for (const node of [...modules].sort()) importDepth = Math.max(importDepth, depthOf(node, new Set()));

	return { source_files: sources.length, loc, import_depth: importDepth };
}
