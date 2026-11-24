// Parser mínimo de argumentos para as CLIs do repositório: --chave valor e flags booleanas (--live).
// Com `allowed`, o parser é estrito: flag fora da lista, flag repetida ou token posicional é erro.
// Sem `allowed`, mantém o comportamento permissivo usado pelas CLIs antigas (probe, smoke).
export function parseArgs(
	argv: readonly string[],
	allowed?: readonly string[],
	repeatable: readonly string[] = [],
): Map<string, string | true> {
	const out = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] ?? "";
		if (!token.startsWith("--")) throw new Error(`argumento inesperado: ${token}`);
		const key = token.slice(2);
		if (allowed !== undefined) {
			if (!allowed.includes(key)) {
				throw new Error(`flag desconhecida: --${key} (aceitas: ${allowed.map((a) => `--${a}`).join(", ")})`);
			}
			if (out.has(key) && !repeatable.includes(key)) throw new Error(`flag repetida: --${key}`);
		}
		const next = argv[i + 1];
		const previous = out.get(key);
		if (next === undefined || next.startsWith("--")) {
			if (repeatable.includes(key) && previous !== undefined) {
				throw new Error(`--${key} repetida exige valor`);
			}
			out.set(key, true);
		} else {
			out.set(key, repeatable.includes(key) && typeof previous === "string" ? `${previous}\u0000${next}` : next);
			i += 1;
		}
	}
	return out;
}
