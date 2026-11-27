// Renderização pura do cabeçalho, da barra de status e do bloco do prompt. Sem I/O: as linhas são devolvidas prontas.
import type { SlashCommand } from "./commands.ts";
import { type EditorState, popupItems } from "./line_editor.ts";

export interface RenderStyle {
	readonly color: boolean;
}

export interface HeaderInfo {
	readonly version: string;
	readonly cwd: string;
	readonly auth: string;
	readonly model: string;
	readonly effort: string;
	readonly policy: string;
	readonly budget: number;
	readonly updateNotice: string | null;
}

export interface SessionUsage {
	readonly input: number;
	readonly output: number;
	readonly total: number;
}

export interface StatusInfo {
	readonly cwd: string;
	readonly branch: string | null;
	readonly model: string;
	readonly effort: string;
	readonly policy: string;
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

const SHORTCUTS = "/ comandos · ! shell · Esc cancelar · Ctrl+C sair";
const POPUP_WINDOW = 8;

export function paint(style: RenderStyle, code: string, text: string): string {
	return style.color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

export function renderHeader(info: HeaderInfo, width: number, style: RenderStyle): string[] {
	const w = Math.max(20, width - 1);
	const row = (label: string, value: string) => ` ${paint(style, "2", label.padEnd(10))} ${clip(value, w - 12)}`;
	const lines = [
		` ${paint(style, "1;36", `dv-agent v${info.version}`)}`,
		paint(style, "2", "─".repeat(w)),
		row("workspace", info.cwd),
		row("modelo", info.model === "" ? "nenhum — use /login" : `${info.model} · ${info.effort}`),
		row("auth", info.auth),
		row("política", `${info.policy} · orçamento ${info.budget} tokens`),
	];
	if (info.updateNotice !== null) {
		lines.push(paint(style, "33", clip(` Atualização disponível: ${info.updateNotice} — rode /update ou dv update`, w)));
	}
	lines.push(paint(style, "2", clip(` Dica: ${SHORTCUTS}`, w)));
	return lines;
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

/** Texto da barra de status (sem cores; o bloco do prompt aplica o estilo). */
export function renderStatusLine(info: StatusInfo, width: number): string {
	const { input, output, total } = info.usage;
	const parts = [
		info.cwd,
		info.branch === null ? "sem git" : `⎇ ${info.branch}`,
		`${info.model === "" ? "sem modelo" : info.model} · ${info.effort}`,
		info.policy,
		`tok ${formatCount(input)} in · ${formatCount(output)} out · ${formatCount(total)} total`,
		info.cost,
	];
	const left = parts.join(" · ");
	return clip(`${left}  │  ${SHORTCUTS}`, Math.max(20, width - 1));
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
