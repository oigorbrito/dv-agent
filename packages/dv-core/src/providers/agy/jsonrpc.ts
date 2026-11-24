// JSON-RPC 2.0 sobre stdio com uma mensagem JSON por linha (framing do ACP). Sem dependências.
// Requisições do agente ao cliente que não são implementadas recebem erro -32601, para o agente não ficar esperando.
import type { Readable, Writable } from "node:stream";
import { redactText } from "../../ledger/redact.ts";

export class JsonRpcError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "JsonRpcError";
		this.code = code;
		this.data = data;
	}
}

/** Falha de transporte: fluxo fechado, timeout, cancelamento ou quadro inválido. Não é erro do modelo. */
export class TransportError extends Error {
	readonly kind: "closed" | "timeout" | "aborted" | "protocol";
	constructor(kind: "closed" | "timeout" | "aborted" | "protocol", message: string) {
		super(message);
		this.name = "TransportError";
		this.kind = kind;
	}
}

export const METHOD_NOT_FOUND = -32601;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
	signal?: AbortSignal;
}

export type NotificationHandler = (params: unknown) => void;
export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export class JsonRpcConnection {
	private nextId = 1;
	private buffer = "";
	private readonly pending = new Map<number, Pending>();
	private readonly handlers = new Map<string, NotificationHandler>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private failure: Error | undefined;
	private readonly output: Writable;

	constructor(input: Readable, output: Writable) {
		this.output = output;
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => this.onData(chunk));
		input.on("end", () => this.failAll(new TransportError("closed", "stdout do agente encerrado")));
		input.on("error", (error) => this.failAll(new TransportError("closed", `erro de leitura: ${error.message}`)));
		output.on("error", (error) => this.failAll(new TransportError("closed", `erro de escrita: ${error.message}`)));
	}

	on(method: string, handler: NotificationHandler): void {
		this.handlers.set(method, handler);
	}

	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	/** Envia uma requisição e espera a resposta. Timeout e cancelamento rejeitam com TransportError. */
	request(method: string, params: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		if (options.signal?.aborted) return Promise.reject(new TransportError("aborted", `${method} cancelado`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new TransportError("timeout", `${method} sem resposta em ${options.timeoutMs} ms`));
			}, options.timeoutMs);
			const entry: Pending = { resolve, reject, timer };
			if (options.signal !== undefined) {
				const onAbort = () => {
					this.settle(id);
					reject(new TransportError("aborted", `${method} cancelado`));
				};
				entry.onAbort = onAbort;
				entry.signal = options.signal;
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, entry);
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	/** Rejeita todas as pendências e impede novas requisições. */
	failAll(error: Error): void {
		if (this.failure !== undefined) return;
		this.failure = error;
		for (const id of [...this.pending.keys()]) {
			const entry = this.pending.get(id);
			this.settle(id);
			entry?.reject(error);
		}
	}

	private settle(id: number): void {
		const entry = this.pending.get(id);
		if (entry === undefined) return;
		clearTimeout(entry.timer);
		if (entry.signal !== undefined && entry.onAbort !== undefined) {
			entry.signal.removeEventListener("abort", entry.onAbort);
		}
		this.pending.delete(id);
	}

	private write(message: object): void {
		if (this.failure !== undefined) return;
		this.output.write(`${JSON.stringify(message)}\n`);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line !== "") this.dispatch(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private dispatch(line: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Quadro que não é JSON quebra o framing: a conexão não é mais confiável.
			this.failAll(new TransportError("protocol", "quadro não é JSON no stdout do agente"));
			return;
		}
		if (message === null || typeof message !== "object") {
			this.failAll(new TransportError("protocol", "quadro JSON-RPC não é objeto"));
			return;
		}
		const method = message.method;
		const id = message.id;
		if (typeof method === "string") {
			if (id === undefined) {
				this.handlers.get(method)?.(message.params);
				return;
			}
			const handler = this.requestHandlers.get(method);
			if (handler === undefined) {
				this.write({
					jsonrpc: "2.0",
					id,
					error: { code: METHOD_NOT_FOUND, message: `método não suportado pelo cliente: ${method}` },
				});
				return;
			}
			void Promise.resolve()
				.then(() => handler(message.params))
				.then((result) => this.write({ jsonrpc: "2.0", id, result }))
				.catch((error: unknown) => {
					const text = error instanceof Error ? error.message : String(error);
					const safe = redactText(text)
						.replace(/[\r\n\t]+/g, " ")
						.slice(0, 300);
					this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: safe } });
				});
			return;
		}
		if (typeof id !== "number") return;
		const entry = this.pending.get(id);
		if (entry === undefined) return;
		this.settle(id);
		const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
		if (error !== undefined) {
			const code = typeof error.code === "number" ? error.code : -32603;
			const text = typeof error.message === "string" ? error.message : "erro JSON-RPC sem mensagem";
			entry.reject(new JsonRpcError(code, text, error.data));
			return;
		}
		entry.resolve(message.result);
	}
}
