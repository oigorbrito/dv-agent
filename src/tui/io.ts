// Contrato de E/S do REPL, com a implementação não-TTY (linha a linha). A versão TTY fica em terminal.ts.
import type { Interface } from "node:readline";

export type LineResult =
	| { readonly kind: "submit"; readonly text: string }
	| { readonly kind: "interrupt" }
	| { readonly kind: "eof" }
	| { readonly kind: "escape" };

export interface ReplIO {
	readonly tty: boolean;
	start(): void;
	stop(): void;
	print(text: string): void;
	clearScreen(): void;
	/** Lê uma entrada do usuário; `status` é exibido só no modo TTY. */
	readLine(status: string): Promise<LineResult>;
	ask(question: string, options?: { readonly secret?: boolean }): Promise<string>;
	/** Menu de escolha. Devolve o índice escolhido ou null (cancelado). */
	select(title: string, labels: readonly string[], initial?: number): Promise<number | null>;
	/** Executa `fn` com o terminal em modo normal (ex.: processos filhos com herança de stdio). */
	suspend<T>(fn: () => T): T;
	/** Recebe Esc/Ctrl+C enquanto um turno roda. Passe null para remover. */
	watchInterrupt(handler: (() => void) | null): void;
	/** Copia texto via OSC 52 (só acionado por `/copy`). `written` é false sem terminal interativo. */
	copyToClipboard(text: string): ClipboardResult;
}

export interface ClipboardResult {
	readonly written: boolean;
	readonly truncated: boolean;
}

/**
 * Fila de linhas do readline. Não usa `rl.question`, porque com stdin em pipe as linhas podem chegar antes da
 * pergunta e seriam descartadas.
 */
export class LineQueue {
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string | null) => void> = [];
	private closed = false;

	constructor(rl: Interface) {
		rl.on("line", (line) => {
			const waiter = this.waiters.shift();
			if (waiter !== undefined) waiter(line);
			else this.lines.push(line);
		});
		rl.on("close", () => {
			this.closed = true;
			for (const waiter of this.waiters.splice(0)) waiter(null);
		});
	}

	next(): Promise<string | null> {
		const line = this.lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		if (this.closed) return Promise.resolve(null);
		return new Promise((resolve) => this.waiters.push(resolve));
	}
}

export function createPlainIo(
	queue: LineQueue | null,
	output: { write(text: string): unknown },
	close: () => void = () => {},
): ReplIO {
	const readText = async (): Promise<string | null> => (queue === null ? null : queue.next());
	return {
		tty: false,
		start() {},
		stop() {
			close();
		},
		print(text) {
			output.write(text);
		},
		clearScreen() {},
		async readLine() {
			output.write("dv> ");
			const line = await readText();
			if (line === null) return { kind: "eof" };
			return { kind: "submit", text: line };
		},
		async ask(question) {
			output.write(question);
			return ((await readText()) ?? "").trim();
		},
		async select(title, labels) {
			const options = labels.map((label, i) => `  ${i + 1}. ${label}`).join("\n");
			output.write(`${title}\n${options}\n`);
			const answer = (await this.ask("Escolha: ")).trim();
			if (answer === "" || answer === "0") return null;
			const index = Number(answer) - 1;
			return Number.isInteger(index) && index >= 0 && index < labels.length ? index : null;
		},
		suspend(fn) {
			return fn();
		},
		watchInterrupt() {},
		copyToClipboard() {
			return { written: false, truncated: false };
		},
	};
}
