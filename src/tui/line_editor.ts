// Editor de linha puro (sem I/O): texto, cursor, histórico, popup de comandos `/` e atalhos.
import { matchSlashCommands, type SlashCommand } from "./commands.ts";
import type { LineResult } from "./io.ts";

/** Subconjunto do evento de teclado emitido por `readline.emitKeypressEvents`. */
export interface KeyEvent {
	str?: string | undefined;
	name?: string | undefined;
	ctrl?: boolean | undefined;
	meta?: boolean | undefined;
}

export interface EditorState {
	readonly buffer: string;
	readonly cursor: number;
	readonly history: readonly string[];
	/** Posição no histórico durante navegação com ↑/↓; null quando editando o rascunho. */
	readonly historyPos: number | null;
	readonly draft: string;
	readonly popupIndex: number;
	readonly popupDismissed: boolean;
}

export type EditorAction = LineResult;

export interface EditorResult {
	readonly state: EditorState;
	readonly action?: EditorAction;
}

export function createEditorState(history: readonly string[] = []): EditorState {
	return {
		buffer: "",
		cursor: 0,
		history,
		historyPos: null,
		draft: "",
		popupIndex: 0,
		popupDismissed: false,
	};
}

/** Comandos exibidos no popup agora (vazio quando o popup está fechado). */
export function popupItems(state: EditorState): readonly SlashCommand[] {
	return state.popupDismissed ? [] : matchSlashCommands(state.buffer);
}

function selectedItem(state: EditorState): SlashCommand | undefined {
	const items = popupItems(state);
	return items[Math.min(state.popupIndex, items.length - 1)];
}

/** Altera o texto; qualquer edição reabre o popup e volta a seleção ao topo. */
function edit(state: EditorState, buffer: string, cursor: number): EditorState {
	const changed = buffer !== state.buffer;
	return {
		...state,
		buffer,
		cursor: Math.max(0, Math.min(cursor, buffer.length)),
		popupDismissed: changed ? false : state.popupDismissed,
		popupIndex: changed ? 0 : state.popupIndex,
	};
}

function moveSelection(state: EditorState, delta: number): EditorState {
	const count = popupItems(state).length;
	const next = (((state.popupIndex + delta) % count) + count) % count;
	return { ...state, popupIndex: next };
}

function recallHistory(state: EditorState, direction: -1 | 1): EditorState {
	const { history, historyPos } = state;
	if (history.length === 0) return state;
	if (direction === -1) {
		const pos = historyPos === null ? history.length - 1 : Math.max(0, historyPos - 1);
		const draft = historyPos === null ? state.buffer : state.draft;
		return { ...edit(state, history[pos] ?? "", 9999), historyPos: pos, draft };
	}
	if (historyPos === null) return state;
	if (historyPos < history.length - 1) {
		const pos = historyPos + 1;
		return { ...edit(state, history[pos] ?? "", 9999), historyPos: pos };
	}
	return { ...edit(state, state.draft, 9999), historyPos: null, draft: "" };
}

function submit(state: EditorState): EditorResult {
	const item = selectedItem(state);
	if (item !== undefined) {
		if (item.args !== undefined) {
			return { state: edit(state, `/${item.name} `, 9999) };
		}
		return finishLine(state, `/${item.name}`);
	}
	const text = state.buffer.trim();
	if (text === "") return { state };
	return finishLine(state, text);
}

function finishLine(state: EditorState, text: string): EditorResult {
	const last = state.history[state.history.length - 1];
	const history = last === text ? state.history : [...state.history, text];
	const cleared: EditorState = {
		...createEditorState(history),
		popupDismissed: false,
	};
	return { state: cleared, action: { kind: "submit", text } };
}

function insert(state: EditorState, text: string): EditorState {
	const next = state.buffer.slice(0, state.cursor) + text + state.buffer.slice(state.cursor);
	return { ...edit(state, next, state.cursor + text.length), historyPos: null };
}

function deleteRange(state: EditorState, from: number, to: number): EditorState {
	const next = state.buffer.slice(0, from) + state.buffer.slice(to);
	return { ...edit(state, next, from), historyPos: null };
}

function completeSelected(state: EditorState): EditorState {
	const item = selectedItem(state);
	if (item === undefined) return state;
	return edit(state, `/${item.name}${item.args === undefined ? "" : " "}`, 9999);
}

function handleCtrl(state: EditorState, name: string | undefined): EditorResult {
	switch (name) {
		case "c":
			if (state.buffer === "") return { state, action: { kind: "interrupt" } };
			return { state: edit(createEditorState(state.history), "", 0) };
		case "d":
			if (state.buffer === "") return { state, action: { kind: "eof" } };
			return { state: deleteRange(state, state.cursor, state.cursor + 1) };
		case "a":
			return { state: { ...state, cursor: 0 } };
		case "e":
			return { state: { ...state, cursor: state.buffer.length } };
		case "u":
			return { state: deleteRange(state, 0, state.cursor) };
		case "k":
			return { state: deleteRange(state, state.cursor, state.buffer.length) };
		default:
			return { state };
	}
}

function handleNamed(state: EditorState, name: string | undefined): EditorResult | undefined {
	switch (name) {
		case "return":
		case "enter":
			return submit(state);
		case "escape":
			if (popupItems(state).length > 0) return { state: { ...state, popupDismissed: true } };
			if (state.buffer !== "") return { state: edit(createEditorState(state.history), "", 0) };
			return { state, action: { kind: "escape" } };
		case "up":
			if (popupItems(state).length > 0) return { state: moveSelection(state, -1) };
			return { state: recallHistory(state, -1) };
		case "down":
			if (popupItems(state).length > 0) return { state: moveSelection(state, 1) };
			return { state: recallHistory(state, 1) };
		case "tab":
			return { state: completeSelected(state) };
		case "left":
			return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
		case "right":
			return { state: { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) } };
		case "home":
			return { state: { ...state, cursor: 0 } };
		case "end":
			return { state: { ...state, cursor: state.buffer.length } };
		case "backspace":
			if (state.cursor === 0) return { state };
			return { state: deleteRange(state, state.cursor - 1, state.cursor) };
		case "delete":
			return { state: deleteRange(state, state.cursor, state.cursor + 1) };
		default:
			return undefined;
	}
}

/** Aplica uma tecla ao editor. Teclas sem efeito devolvem o mesmo estado. */
export function applyKey(state: EditorState, key: KeyEvent): EditorResult {
	if (key.ctrl === true) return handleCtrl(state, key.name);
	if (key.meta === true) return { state };
	const named = handleNamed(state, key.name);
	if (named !== undefined) return named;
	const text = key.str;
	if (text !== undefined && text !== "" && /^[^\u0000-\u001f\u007f]+$/u.test(text)) {
		return { state: insert(state, text) };
	}
	return { state };
}
