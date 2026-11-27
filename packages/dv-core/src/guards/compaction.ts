// Compactação intra-degrau: encurta saídas antigas de ferramenta antes de cada chamada ao modelo.
//
// Opt-in (executeRung: compaction "by_model"). Padrão "off" preserva as execuções congeladas.
// Calibração por porte: a tabela abaixo é um PONTO DE PARTIDA, não um resultado. Modelos econômicos recebem regras
// mais conservadoras (mantêm mais evidência). A calibração definitiva exige medir solve rate versus tokens no bench.

export type ModelClass = "economy" | "standard" | "frontier";

export interface CompactionRule {
	/** Quantas saídas de ferramenta mais recentes ficam intactas. */
	keepRecentToolResults: number;
	/** Limite de caracteres por saída antiga; acima disso a saída é reduzida (início + fim, com marcador). */
	maxCharsPerOlderResult: number;
}

export const COMPACTION_RULES: Readonly<Record<ModelClass, CompactionRule>> = {
	economy: { keepRecentToolResults: 8, maxCharsPerOlderResult: 8000 },
	standard: { keepRecentToolResults: 5, maxCharsPerOlderResult: 3000 },
	frontier: { keepRecentToolResults: 3, maxCharsPerOlderResult: 1500 },
};

/** Porte pelo identificador do modelo (sem o provedor). Desconhecido vira "standard". */
export function modelClassOf(modelId: string): ModelClass {
	// Casamento por token: "mini" não pode casar dentro de "gemini".
	const id = modelId.toLowerCase();
	const tokens = new Set(id.split(/[^a-z0-9]+/));
	if (["haiku", "lite", "mini", "nano"].some((t) => tokens.has(t)) || (tokens.has("flash") && tokens.has("low")))
		return "economy";
	if (
		["opus", "luna"].some((t) => tokens.has(t)) ||
		(tokens.has("flash") && tokens.has("high")) ||
		id.includes("gpt-5")
	)
		return "frontier";
	return "standard";
}

export interface CompactionStats {
	truncated: number;
	charsBefore: number;
	charsAfter: number;
}

interface ToolResultLike {
	role: string;
	content?: unknown;
}

const isToolResult = (message: unknown): message is ToolResultLike & { content: unknown[] } =>
	typeof message === "object" &&
	message !== null &&
	(message as ToolResultLike).role === "toolResult" &&
	Array.isArray((message as ToolResultLike).content);

/** Reduz texto acima do limite mantendo início (70%) e fim (30%) e um marcador com o número de caracteres omitidos. */
export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n[... ${omitted} caracteres omitidos pela compactação ...]\n${text.slice(text.length - tail)}`;
}

/**
 * Aplica a regra às saídas de ferramenta: as `keepRecentToolResults` mais recentes ficam intactas; as antigas com texto
 * acima do limite são reduzidas. Não altera a entrada (devolve mensagens novas quando algo muda).
 */
export function compactToolResults<M>(
	messages: readonly M[],
	rule: CompactionRule,
): { messages: M[]; stats: CompactionStats } {
	const toolIndexes: number[] = [];
	messages.forEach((message, index) => {
		if (isToolResult(message)) toolIndexes.push(index);
	});
	const olderCutoff = toolIndexes.length - rule.keepRecentToolResults;
	const older = new Set(olderCutoff > 0 ? toolIndexes.slice(0, olderCutoff) : []);
	const stats: CompactionStats = { truncated: 0, charsBefore: 0, charsAfter: 0 };
	const out = messages.map((message, index) => {
		if (!isToolResult(message)) return message;
		const charsBefore = textLength(message.content);
		stats.charsBefore += charsBefore;
		if (!older.has(index)) {
			stats.charsAfter += charsBefore;
			return message;
		}
		let changed = false;
		const content = message.content.map((part) => {
			const block = part as { type?: unknown; text?: unknown };
			if (block.type !== "text" || typeof block.text !== "string") return part;
			const next = truncateText(block.text, rule.maxCharsPerOlderResult);
			if (next === block.text) return part;
			changed = true;
			return { ...(part as object), text: next };
		});
		const charsAfter = textLength(content);
		stats.charsAfter += charsAfter;
		if (!changed) return message;
		stats.truncated += 1;
		return { ...(message as object), content } as M;
	});
	return { messages: out, stats };
}

function textLength(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.reduce<number>((sum, part) => {
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" ? sum + block.text.length : sum;
	}, 0);
}
