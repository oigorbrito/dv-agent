// Parser mínimo de argumentos para as CLIs do repositório: --chave valor e flags booleanas (--live).
export function parseArgs(argv: readonly string[]): Map<string, string | true> {
	const out = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] ?? "";
		if (!token.startsWith("--")) throw new Error(`argumento inesperado: ${token}`);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out.set(token.slice(2), true);
		} else {
			out.set(token.slice(2), next);
			i += 1;
		}
	}
	return out;
}
