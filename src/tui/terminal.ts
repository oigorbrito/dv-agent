// Implementação TTY de ReplIO: raw mode próprio em Node, bloco de prompt redesenhável e seletor com setas.
import { emitKeypressEvents } from "node:readline";
import { osc52Sequence } from "./clipboard.ts";
import type { ClipboardResult, LineResult, ReplIO } from "./io.ts";
import { clip, type Frame, paint, type RenderStyle, renderPromptBlock } from "./render.ts";
import { applyKey, createEditorState, type EditorState, type KeyEvent } from "./line_editor.ts";

const SELECT_WINDOW = 10;
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

type KeyHandler = (key: KeyEvent) => void;

interface CollectOptions {
	readonly secret: boolean;
	readonly isolated: boolean;
}

export class TerminalUI implements ReplIO {
	readonly tty = true;
	private editor: EditorState = createEditorState();
	private frame: (() => Frame) | null = null;
	private drawnRows = 0;
	private cursorRow = 0;
	private keyHandler: KeyHandler | null = null;
	private active = false;
	private readonly style: RenderStyle;

	private readonly input: NodeJS.ReadStream;
	private readonly output: NodeJS.WriteStream;

	constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
		this.input = input;
		this.output = output;
		this.style = { color: output.isTTY === true && process.env.NO_COLOR === undefined };
	}

	start(): void {
		if (this.active) return;
		emitKeypressEvents(this.input);
		this.input.setRawMode?.(true);
		this.input.on("keypress", this.onKeypress);
		this.input.resume();
		this.active = true;
	}

	stop(): void {
		if (!this.active) return;
		this.eraseBlock();
		this.input.off("keypress", this.onKeypress);
		this.input.setRawMode?.(false);
		this.input.pause();
		this.active = false;
		this.output.write(SHOW_CURSOR);
	}

	print(text: string): void {
		this.eraseBlock();
		const normalized = text.replace(/\r?\n/g, "\r\n");
		this.output.write(normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`);
		this.refresh();
	}

	clearScreen(): void {
		this.eraseBlock();
		this.output.write("\u001b[2J\u001b[3J\u001b[H");
		this.refresh();
	}

	readLine(status: string): Promise<LineResult> {
		return this.collect("›", status, { secret: false, isolated: false });
	}

	async ask(question: string, options?: { readonly secret?: boolean }): Promise<string> {
		const parts = question.split("\n");
		const last = (parts.pop() ?? "").replace(/\s+$/, "");
		if (parts.length > 0) this.print(`${parts.join("\n")}\n`);
		const result = await this.collect(last, "Enter confirma · Esc cancela", {
			secret: options?.secret === true,
			isolated: true,
		});
		return result.kind === "submit" ? result.text.trim() : "";
	}

	select(title: string, labels: readonly string[], initial = 0): Promise<number | null> {
		if (labels.length === 0) return Promise.resolve(null);
		return new Promise((resolve) => {
			const count = labels.length;
			let index = Math.max(0, Math.min(initial, count - 1));
			const finish = (value: number | null) => {
				this.keyHandler = null;
				this.frame = null;
				this.eraseBlock();
				const chosen = value === null ? "cancelado" : (labels[value] ?? "");
				this.output.write(`${paint(this.style, "2", `${title}:`)} ${chosen}\r\n`);
				this.output.write(SHOW_CURSOR);
				resolve(value);
			};
			this.keyHandler = (key) => {
				if (key.name === "up") index = (index - 1 + count) % count;
				else if (key.name === "down") index = (index + 1) % count;
				else if (key.name === "return" || key.name === "enter") return finish(index);
				else if (key.name === "escape" || (key.ctrl === true && key.name === "c")) return finish(null);
				else return;
				this.refresh();
			};
			this.frame = () => this.selectFrame(title, labels, index);
			this.output.write(HIDE_CURSOR);
			this.refresh();
		});
	}

	suspend<T>(fn: () => T): T {
		this.eraseBlock();
		const wasActive = this.active;
		if (wasActive) {
			this.input.off("keypress", this.onKeypress);
			this.input.setRawMode?.(false);
			this.input.pause();
		}
		try {
			return fn();
		} finally {
			if (wasActive) {
				this.input.setRawMode?.(true);
				this.input.on("keypress", this.onKeypress);
				this.input.resume();
			}
			this.refresh();
		}
	}

	/** Escreve a sequência OSC 52 sem tocar no modo mouse: a seleção nativa do terminal continua disponível. */
	copyToClipboard(text: string): ClipboardResult {
		const { sequence, truncated } = osc52Sequence(text);
		this.eraseBlock();
		this.output.write(sequence);
		this.refresh();
		return { written: true, truncated };
	}

	watchInterrupt(handler: (() => void) | null): void {
		this.keyHandler =
			handler === null
				? null
				: (key) => {
						if (key.name === "escape" || (key.ctrl === true && key.name === "c")) handler();
					};
	}

	private readonly onKeypress = (str: string | undefined, key: KeyEvent | undefined): void => {
		this.keyHandler?.({ str, name: key?.name, ctrl: key?.ctrl, meta: key?.meta });
	};

	private collect(label: string, status: string, options: CollectOptions): Promise<LineResult> {
		return new Promise((resolve) => {
			let editor = options.isolated ? createEditorState() : this.editor;
			const finish = (result: LineResult) => {
				this.keyHandler = null;
				this.frame = null;
				this.eraseBlock();
				if (result.kind === "submit") {
					const echo = options.secret ? "•".repeat(result.text.length) : result.text;
					this.output.write(`${paint(this.style, "36", label)} ${echo}\r\n`);
				}
				if (!options.isolated) this.editor = editor;
				resolve(result);
			};
			this.keyHandler = (key) => {
				const outcome = applyKey(editor, key);
				editor = outcome.state;
				if (outcome.action === undefined) {
					this.refresh();
					return;
				}
				finish(outcome.action);
			};
			this.frame = () =>
				renderPromptBlock(editor, {
					status,
					width: this.width(),
					style: this.style,
					label,
					masked: options.secret,
				});
			this.refresh();
		});
	}

	private selectFrame(title: string, labels: readonly string[], index: number): Frame {
		const width = this.width();
		const start = Math.max(0, Math.min(index - Math.floor(SELECT_WINDOW / 2), labels.length - SELECT_WINDOW));
		const lines = [paint(this.style, "1", clip(title, width - 1))];
		for (let i = start; i < Math.min(labels.length, start + SELECT_WINDOW); i += 1) {
			const label = clip(labels[i] ?? "", width - 6);
			lines.push(i === index ? paint(this.style, "1;36", `  › ${label}`) : `    ${label}`);
		}
		lines.push(paint(this.style, "2", "  ↑/↓ navegar · Enter confirma · Esc cancela"));
		return { lines, cursorRow: 0, cursorCol: 0 };
	}

	private width(): number {
		return Math.max(40, this.output.columns ?? 80);
	}

	private refresh(): void {
		if (this.frame !== null) this.drawBlock(this.frame());
	}

	private drawBlock(frame: Frame): void {
		this.eraseBlock();
		this.output.write(frame.lines.join("\r\n"));
		const up = frame.lines.length - 1 - frame.cursorRow;
		const move = (up > 0 ? `\u001b[${up}A` : "") + "\r" + (frame.cursorCol > 0 ? `\u001b[${frame.cursorCol}C` : "");
		this.output.write(move);
		this.drawnRows = frame.lines.length;
		this.cursorRow = frame.cursorRow;
	}

	private eraseBlock(): void {
		if (this.drawnRows === 0) return;
		this.output.write((this.cursorRow > 0 ? `\u001b[${this.cursorRow}A` : "") + "\r\u001b[J");
		this.drawnRows = 0;
		this.cursorRow = 0;
	}
}
