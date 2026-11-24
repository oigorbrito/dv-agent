// Roteiros offline por tarefa do corpus. Cada tarefa pode trazer offline/cheap/ (solução errada) e offline/strong/
// (solução correta), gravadas via write_file. Sem a pasta offline/, o chamador usa o roteiro legado (offline_scripts.ts).
// Provider faux: não avalia modelo real; serve para validar o harness (promoção de degrau, oráculo, ledger).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type Turn, textTurn, toolTurn, usage } from "@dv-agent/core";

interface FixtureFile {
	rel: string;
	abs: string;
}

/** Arquivos de um diretório, recursivo, com caminho relativo em POSIX e ordem lexicográfica estável. */
function listFiles(root: string): FixtureFile[] {
	const out: FixtureFile[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) walk(abs);
			else out.push({ rel: relative(root, abs).split(sep).join("/"), abs });
		}
	};
	walk(root);
	return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Turnos do modelo faux para a tarefa. Retorna undefined quando a tarefa não tem pasta offline/ (roteiro legado).
 * faux-cheap → cheap; faux-strong e faux-editor → strong; faux-architect → plano em texto (sem ferramentas).
 */
export function fixtureTurns(
	taskDir: string,
	modelId: string,
	options: { bashOnly?: boolean } = {},
): Turn[] | undefined {
	const root = join(resolve(taskDir), "offline");
	if (!existsSync(root)) return undefined;
	const u = (): ReturnType<typeof usage> => usage(1000, 100, { reasoning: 0 });
	if (modelId === "faux-architect") {
		return [textTurn("Plano: implementar os requisitos de SPEC.md nos módulos do workspace.", u())];
	}
	const variant =
		modelId === "faux-strong" || modelId === "faux-editor" ? "strong" : modelId === "faux-cheap" ? "cheap" : undefined;
	if (variant === undefined) throw new Error(`modelo faux sem roteiro na tarefa: ${modelId}`);
	const dir = join(root, variant);
	if (!existsSync(dir)) throw new Error(`roteiro ausente: ${dir}`);
	const files = listFiles(dir);
	const turns: Turn[] = files.map((file, index) => {
		if (options.bashOnly) {
			const hex = Buffer.from(readFileSync(file.abs)).toString("hex");
			const cmd = `python -c "import pathlib; p = pathlib.Path('${file.rel}'); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(bytes.fromhex('${hex}'))"`;
			return toolTurn("run_bash", { command: cmd }, u(), `${variant}-${index}`);
		}
		return toolTurn(
			"write_file",
			{ path: file.rel, content: readFileSync(file.abs, "utf8") },
			u(),
			`${variant}-${index}`,
		);
	});
	turns.push(textTurn("alteração feita", u()));
	return turns;
}
