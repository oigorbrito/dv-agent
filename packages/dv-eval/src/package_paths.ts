// Localiza a raiz do checkout durante desenvolvimento ou da árvore de distribuição empacotada.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findPackageRoot(fromDirectory: string): string {
	let current = resolve(fromDirectory);
	for (;;) {
		if (
			existsSync(join(current, "UPSTREAM_PIN.json")) &&
			existsSync(join(current, "contracts", "run-accounting-contract-v4.json")) &&
			existsSync(join(current, "packages", "dv-eval"))
		) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`raiz do pacote dv-agent não encontrada acima de ${fromDirectory}`);
}
