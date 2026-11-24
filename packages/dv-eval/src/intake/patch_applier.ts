// Aplica patches em formato unified diff de forma determinística, sem depender do executável git.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

interface FileDiff {
	oldPath: string;
	newPath: string;
	hunks: Hunk[];
}

function cleanPath(raw: string): string {
	let path = raw.trim().replaceAll("\\", "/");
	if (path.startsWith('"') && path.endsWith('"')) {
		path = path.slice(1, -1);
	}
	if (path.startsWith("a/") || path.startsWith("b/")) {
		path = path.slice(2);
	}
	return path;
}

/** Interpreta um patch unified diff em estruturas de arquivos e hunks. */
export function parseUnifiedDiff(diffText: string): FileDiff[] {
	const lines = diffText.replace(/\r\n/g, "\n").split("\n");
	const files: FileDiff[] = [];
	let currentFile: FileDiff | null = null;
	let currentHunk: Hunk | null = null;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;

		if (line.startsWith("--- ")) {
			const oldPath = cleanPath(line.slice(4));
			i += 1;
			if (i < lines.length && lines[i]!.startsWith("+++ ")) {
				const newPath = cleanPath(lines[i]!.slice(4));
				currentFile = { oldPath, newPath, hunks: [] };
				files.push(currentFile);
				currentHunk = null;
				i += 1;
				continue;
			}
		}

		if (line.startsWith("@@ ")) {
			const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
			if (match && currentFile) {
				const oldStart = Number.parseInt(match[1]!, 10);
				const oldLines = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
				const newStart = Number.parseInt(match[3]!, 10);
				const newLines = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
				currentHunk = { oldStart, oldLines, newStart, newLines, lines: [] };
				currentFile.hunks.push(currentHunk);
				i += 1;
				continue;
			}
		}

		if (currentHunk) {
			if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
				currentHunk.lines.push(line);
			} else if (line.startsWith("\\ No newline at end of file")) {
				// Ignora marcador
			}
		}

		i += 1;
	}

	return files;
}

/** Aplica um patch em texto a um diretório de destino. */
export function applyUnifiedDiff(diffText: string, targetDir: string): void {
	const fileDiffs = parseUnifiedDiff(diffText);
	if (fileDiffs.length === 0) {
		throw new Error("Nenhum diff válido encontrado no payload de patch.");
	}

	for (const diff of fileDiffs) {
		const isDelete = diff.newPath === "/dev/null";
		const isCreate = diff.oldPath === "/dev/null";
		const targetRel = isDelete ? diff.oldPath : diff.newPath;
		if (!targetRel || targetRel === "/dev/null" || isAbsolute(targetRel) || /^[a-zA-Z]:/.test(targetRel)) {
			throw new Error(`Tentativa de path traversal no patch: ${targetRel}`);
		}
		const root = resolve(targetDir);
		const targetAbs = resolve(root, targetRel);
		const relativeTarget = relative(root, targetAbs);
		if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
			throw new Error(`Tentativa de path traversal no patch: ${targetRel}`);
		}
		const pathSegments = relativeTarget.split(sep);
		const basename = pathSegments.at(-1)?.toLowerCase();
		if (
			pathSegments.some((segment) => segment.toLowerCase() === ".git") ||
			["gold.patch", "solution.patch", "reference.patch", "reference_patch"].includes(basename ?? "")
		) {
			throw new Error(`Patch não pode criar ou alterar metadados privados: ${targetRel}`);
		}

		// Rejeita symlinks no caminho de escrita, inclusive o próprio arquivo-alvo.
		let cursor = root;
		for (const segment of relativeTarget.split(sep)) {
			cursor = join(cursor, segment);
			if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
				throw new Error(`Symlink não permitido no caminho do patch: ${targetRel}`);
			}
		}

		let originalLines: string[] = [];
		if (existsSync(targetAbs)) {
			originalLines = readFileSync(targetAbs, "utf8").replace(/\r\n/g, "\n").split("\n");
			if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
				originalLines.pop();
			}
		} else if (!isCreate) {
			throw new Error(`Arquivo alvo não existe para modificação: ${targetRel}`);
		}
		if (diff.hunks.length === 0) throw new Error(`Patch sem hunks para ${targetRel}`);

		const resultLines: string[] = [...originalLines];
		let offset = 0;

		for (const hunk of diff.hunks) {
			const targetIndex = (hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1) + offset;
			const newSlice: string[] = [];
			const oldSlice: string[] = [];

			for (const hline of hunk.lines) {
				if (hline.startsWith("+")) {
					newSlice.push(hline.slice(1));
				} else if (hline.startsWith("-")) {
					oldSlice.push(hline.slice(1));
				} else if (hline.startsWith(" ")) {
					const context = hline.slice(1);
					oldSlice.push(context);
					newSlice.push(context);
				}
			}
			if (oldSlice.length !== hunk.oldLines || newSlice.length !== hunk.newLines) {
				throw new Error(`Contagem de linhas do hunk inválida em ${targetRel}`);
			}
			if (targetIndex < 0 || targetIndex + oldSlice.length > resultLines.length) {
				throw new Error(`Hunk fora dos limites em ${targetRel}`);
			}
			for (let line = 0; line < oldSlice.length; line += 1) {
				if (resultLines[targetIndex + line] !== oldSlice[line]) {
					throw new Error(`Contexto do hunk não confere em ${targetRel} (linha ${targetIndex + line + 1})`);
				}
			}

			resultLines.splice(targetIndex, oldSlice.length, ...newSlice);
			offset += newSlice.length - oldSlice.length;
		}

		if (isDelete) {
			if (resultLines.length !== 0) throw new Error(`Patch de exclusão não removeu todo o conteúdo de ${targetRel}`);
			rmSync(targetAbs, { force: true });
		} else {
			mkdirSync(dirname(targetAbs), { recursive: true });
			writeFileSync(targetAbs, `${resultLines.join("\n")}\n`, "utf8");
		}
	}
}
