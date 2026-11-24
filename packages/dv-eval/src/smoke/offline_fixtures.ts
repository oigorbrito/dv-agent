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

/** Bytes por chamada run_bash no modo bash-only. Mantém cada linha de comando abaixo do limite do cmd.exe (8191). */
export const BASH_WRITE_CHUNK_BYTES = 2048;

/**
 * Grava um arquivo só com run_bash, em blocos de BASH_WRITE_CHUNK_BYTES (a primeira chamada grava, as seguintes
 * acrescentam ao conteúdo anterior). Um bloco único em hex estoura a linha de comando do Windows em arquivos grandes.
 */
function bashWriteTurns(file: FixtureFile, idPrefix: string, u: () => ReturnType<typeof usage>): Turn[] {
	const bytes = readFileSync(file.abs);
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < bytes.length; offset += BASH_WRITE_CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, offset + BASH_WRITE_CHUNK_BYTES));
	}
	if (chunks.length === 0) chunks.push(Buffer.alloc(0));
	return chunks.map((chunk, n) => {
		const data = `bytes.fromhex('${chunk.toString("hex")}')`;
		const body = n === 0 ? data : `p.read_bytes() + ${data}`;
		const cmd = `python -c "import pathlib; p = pathlib.Path('${file.rel}'); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(${body})"`;
		return toolTurn("run_bash", { command: cmd }, u(), `${idPrefix}-${n}`);
	});
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
	const turns: Turn[] = files.flatMap((file, index): Turn[] => {
		if (options.bashOnly) return bashWriteTurns(file, `${variant}-${index}`, u);
		return [
			toolTurn("write_file", { path: file.rel, content: readFileSync(file.abs, "utf8") }, u(), `${variant}-${index}`),
		];
	});
	turns.push(textTurn("alteração feita", u()));
	return turns;
}
