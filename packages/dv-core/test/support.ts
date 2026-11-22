// Suporte de teste offline: provider faux do pi-ai (stream mockado), ferramenta em memória e tabela de preços fixa.
//
// O faux do pi-ai substitui o usage da resposta por uma estimativa (tamanho do texto / 4) e nunca informa reasoning.
// Para exercitar a telemetria com valores declarados, cada turno leva o usage que o teste quer medir, e o stream
// envolvido reescreve o usage do evento `done` com esse valor. É um shim de teste: não representa o provedor real.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createModels,
	type FauxContentBlock,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonObject,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { PriceBook, PriceEntry } from "../src/index.ts";

/** Preço fixo do teste: 1 USD por 1M input, 4 por 1M output. Cache com preços próprios. */
export const TEST_PRICE: PriceEntry = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

/** Um turno do modelo: a resposta a ser devolvida e o usage medido para ela. */
export interface Turn {
	message: AssistantMessage;
	usage: Usage;
}

export function tempDir(name: string): string {
	return mkdtempSync(join(tmpdir(), `dv-${name}-`));
}

export function priceBookFor(keys: readonly string[]): PriceBook {
	const entries: Record<string, PriceEntry> = {};
	for (const key of keys) entries[key] = TEST_PRICE;
	return { id: "test-prices-v1", source: "dv-core test fixture", entries };
}

export function usage(input: number, output: number, extra: { cacheRead?: number; cacheWrite?: number; reasoning?: number } = {}): Usage {
	const cacheRead = extra.cacheRead ?? 0;
	const cacheWrite = extra.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		...(extra.reasoning === undefined ? {} : { reasoning: extra.reasoning }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
	};
}

function turnOf(content: string | FauxContentBlock | FauxContentBlock[], u: Usage, stopReason: "stop" | "toolUse"): Turn {
	return { message: fauxAssistantMessage(content, { stopReason }), usage: u };
}

/** Turno em que o modelo chama uma ferramenta. */
export function toolTurn(name: string, args: JsonObject, u: Usage, id?: string): Turn {
	return turnOf(fauxToolCall(name, args, { id: id ?? `call_${Math.random().toString(36).slice(2, 10)}` }), u, "toolUse");
}

/** Turno de texto final. */
export function textTurn(text: string, u: Usage): Turn {
	return turnOf(fauxText(text), u, "stop");
}

export interface FauxRuntime {
	faux: FauxProviderHandle;
	streamFn: StreamFn;
	modelOf(id: string): Model<string>;
	/** Define os turnos (respostas + usage) consumidos em ordem, uma por chamada ao provedor. */
	script(turns: readonly Turn[]): void;
}

/** Provider faux com modelos dados, exposto como StreamFn do agente. */
export function fauxRuntime(provider: string, modelIds: readonly string[]): FauxRuntime {
	const faux = fauxProvider({
		provider,
		models: modelIds.map((id) => ({ id, name: id, reasoning: false, input: ["text"] })),
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const declared: Usage[] = [];
	const streamFn: StreamFn = (model, context, options) => {
		const inner = models.streamSimple(model, context, options);
		const declaredUsage = declared.shift();
		return declaredUsage === undefined ? inner : withUsage(inner, declaredUsage);
	};
	return {
		faux,
		streamFn,
		modelOf: (id) => {
			const model = faux.getModel(id);
			if (model === undefined) throw new Error(`modelo faux ausente: ${id}`);
			return model;
		},
		script: (turns) => {
			faux.setResponses(turns.map((turn) => turn.message));
			declared.push(...turns.map((turn) => turn.usage));
		},
	};
}

/** Reescreve o usage do evento `done` (fim da resposta) com o valor declarado. Demais eventos passam intactos. */
function withUsage(inner: AssistantMessageEventStream, declared: Usage): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of inner) {
			if (event.type === "done") {
				outer.push({ ...event, message: { ...event.message, usage: declared } });
			} else {
				outer.push(event);
			}
		}
		outer.end();
	})();
	return outer;
}

/** Ferramenta de escrita em memória. Cada workspace é um Map próprio (workspace limpo por degrau). */
export function writeFileTool(workspace: Map<string, string>, onExecute?: () => void): AgentTool {
	return {
		name: "write_file",
		label: "write_file",
		description: "Grava conteúdo em um arquivo do workspace.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
		execute: async (_toolCallId, params) => {
			onExecute?.();
			const { path, content } = params as { path: string; content: string };
			workspace.set(path, content);
			return { content: [{ type: "text", text: `wrote ${path}: ${content}` }], details: {} };
		},
	};
}
