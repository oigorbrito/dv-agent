// Renderização pura do cabeçalho, da barra de status e do bloco do prompt. Sem I/O: as linhas são devolvidas prontas.
import type { SlashCommand } from "./commands.ts";
import { type EditorState, popupItems } from "./line_editor.ts";

export interface RenderStyle {
	readonly color: boolean;
}

/** Abertura compacta: versão, diretório e (opcional) um único aviso curto. Detalhes ficam em /status, /tokens e /help. */
export interface HeaderInfo {
	readonly version: string;
	readonly cwd: string;
	/** Diretório pessoal: quando `cwd` está dentro dele, exibe `~` no lugar. */
	readonly homeDir?: string;
	/** Aviso curto (ex.: atualização disponível, sem modelo ativo). Nulo = nenhuma linha extra. */
	readonly notice: string | null;
}

export interface SessionUsage {
	readonly input: number;
	readonly output: number;
	readonly total: number;
}

export interface StatusInfo {
	readonly cwd: string;
	readonly branch: string | null;
	/** `provedor/modelo`; vazio quando não há modelo ativo. */
	readonly model: string;
	readonly effort: string;
	readonly usage: SessionUsage;
	/** Rótulo de custo/modo: `sub`, `US$ 0.0123` ou `n/d` (ver formatCostMode). */
	readonly cost: string;
}

export interface Frame {
	readonly lines: readonly string[];
	/** Índice (em `lines`) da linha onde o cursor deve ficar. */
	readonly cursorRow: number;
	/** Coluna (0-based) do cursor dentro da linha. */
	readonly cursorCol: number;
}

const POPUP_WINDOW = 8;
const STATUS_GAP = 3;

export function paint(style: RenderStyle, code: string, text: string): string {
	return style.color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

/** Troca o prefixo do diretório pessoal por `~` (preserva os separadores originais). */
export function abbreviatePath(cwd: string, homeDir: string | undefined): string {
	if (homeDir === undefined || homeDir === "") return cwd;
	const home = homeDir.replace(/[\\/]+$/, "");
	if (home === "") return cwd;
	const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
	const rest = cwd.slice(home.length);
	const inside = norm(cwd).startsWith(norm(home)) && (rest === "" || /^[\\/]/.test(rest));
	return inside ? `~${rest}` : cwd;
}

/** Abertura: 2 linhas fixas (nome/versão e diretório) + 1 aviso opcional. */
export function renderHeader(info: HeaderInfo, width: number, style: RenderStyle): string[] {
	const w = Math.max(20, width - 1);
	const lines = [
		` ${paint(style, "1;36", clip(`dv-agent v${info.version}`, w - 1))}`,
		` ${paint(style, "2", clip(abbreviatePath(info.cwd, info.homeDir), w - 1))}`,
	];
	if (info.notice !== null) {
		lines.push(paint(style, "33", clip(` ${info.notice}`, w)));
	}
	return lines;
}

/** Última pasta do caminho (ex.: `D:/projetos/dv-agent` → `dv-agent`). */
function folderName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter((part) => part !== "");
	return parts[parts.length - 1] ?? cwd;
}

/**
 * Barra de status em duas pontas: à esquerda pasta, branch, tokens e modo; à direita modelo e esforço.
 * Se não couber, reduz o lado esquerdo (sem branch, depois só total de tokens) antes de cortar qualquer coisa.
 */
export function renderStatusLine(info: StatusInfo, width: number): string {
	const w = Math.max(20, width - 1);
	const { input, output, total } = info.usage;
	const folder = folderName(info.cwd);
	const branch = info.branch === null ? null : `⎇ ${info.branch}`;
	const right = info.model === "" ? "sem modelo · /login" : `${info.model} · ${info.effort}`;
	const candidates = [
		[folder, branch, `tok ${formatCount(input)} in · ${formatCount(output)} out · ${formatCount(total)} total`, info.cost],
		[folder, branch, `tok ${formatCount(total)}`, info.cost],
		[folder, `tok ${formatCount(total)}`, info.cost],
		[`tok ${formatCount(total)}`, info.cost],
	].map((parts) => parts.filter((part): part is string => part !== null).join(" · "));

	for (const left of candidates) {
		const room = w - left.length - right.length - STATUS_GAP;
		if (room >= 0) return `${left}${" ".repeat(STATUS_GAP + room)}${right}`;
	}
	// Nem o lado mais curto cabe: corta a esquerda, nunca o modelo.
	const leftRoom = w - right.length - STATUS_GAP;
	if (leftRoom >= 8) return `${clip(candidates[candidates.length - 1] ?? "", leftRoom)}${" ".repeat(STATUS_GAP)}${right}`;
	return clip(right, w);
}

/** Contagem compacta de tokens: 999, 1.2k, 3.45M. */
export function formatCount(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Custo/modo para a barra: assinatura sem custo em USD mostra `sub`; assinatura com custo estimado mostra o estimado;
 * api-key mostra US$; `n/d` quando alguma chamada não tem preço.
 */
export function formatCostMode(costUsd: number | null, subscription: boolean): string {
	if (subscription) {
		return costUsd !== null && costUsd > 0 ? `sub · est. US$ ${costUsd.toFixed(4)}` : "sub";
	}
	return costUsd === null ? "n/d" : `US$ ${costUsd.toFixed(4)}`;
}

function popupLine(cmd: SlashCommand, selected: boolean, width: number, style: RenderStyle): string {
	const name = `/${cmd.name}${cmd.args === undefined ? "" : ` ${cmd.args}`}`;
	const plain = clip(` ${selected ? "›" : " "} ${name.padEnd(30)} ${cmd.description}`, width);
	return selected ? paint(style, "1;36", plain) : paint(style, "2", plain);
}

/** Bloco do prompt: regra, linha de entrada, popup de comandos (quando ativo), regra e barra de status. */
export function renderPromptBlock(
	editor: EditorState,
	options: { status: string; width: number; style: RenderStyle; label: string; masked: boolean },
): Frame {
	const { width, style } = options;
	const rule = paint(style, "2", "─".repeat(Math.max(10, width - 1)));
	const shown = options.masked ? "•".repeat(editor.buffer.length) : editor.buffer;
	const inputLine = `${paint(style, "36", options.label)} ${clip(shown, width - options.label.length - 4)}`;
	const lines: string[] = [rule, inputLine];
	const items = popupItems(editor);
	if (items.length > 0) {
		const selected = Math.min(editor.popupIndex, items.length - 1);
		const start = Math.max(0, Math.min(selected - Math.floor(POPUP_WINDOW / 2), items.length - POPUP_WINDOW));
		const visible = items.slice(Math.max(0, start), Math.max(0, start) + POPUP_WINDOW);
		for (const [offset, cmd] of visible.entries()) {
			lines.push(popupLine(cmd, start + offset === selected, width - 1, style));
		}
		if (items.length > POPUP_WINDOW) lines.push(paint(style, "2", `   ${items.length} comandos — continue digitando`));
	}
	lines.push(rule, renderStatusFooter(options.status, width, style));
	const inputCol = options.label.length + 1 + Math.min(editor.cursor, Math.max(0, width - options.label.length - 4));
	return { lines, cursorRow: 1, cursorCol: inputCol };
}

function renderStatusFooter(status: string, width: number, style: RenderStyle): string {
	return paint(style, "2", clip(status, Math.max(20, width - 1)));
}
