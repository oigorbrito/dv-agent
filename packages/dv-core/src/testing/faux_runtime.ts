// Runtime faux para testes e smoke offline: provider faux do pi-ai (stream mockado) com usage declarado por turno.
//
// O faux do pi-ai substitui o usage da resposta por uma estimativa (tamanho do texto / 4) e nunca informa reasoning.
// Cada turno leva o usage que se quer medir, e o stream envolvido reescreve o usage do evento `done` com esse valor.
// É um shim de teste: não representa o comportamento de um provedor real.

import type { StreamFn } from "@earendil-works/pi-agent-core";
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

/** Um turno do modelo: a resposta a ser devolvida e o usage medido para ela. */
export interface Turn {
	message: AssistantMessage;
	usage: Usage;
}

/** Usage declarado. `reasoning` omitido significa que o transporte não informou. */
export function usage(
	input: number,
	output: number,
	extra: { cacheRead?: number; cacheWrite?: number; reasoning?: number } = {},
): Usage {
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

function turnOf(
	content: string | FauxContentBlock | FauxContentBlock[],
	u: Usage,
	stopReason: "stop" | "toolUse",
): Turn {
	return { message: fauxAssistantMessage(content, { stopReason }), usage: u };
}

/** Turno em que o modelo chama uma ferramenta. */
export function toolTurn(name: string, args: JsonObject, u: Usage, id?: string): Turn {
	return turnOf(
		fauxToolCall(name, args, { id: id ?? `call_${Math.random().toString(36).slice(2, 10)}` }),
		u,
		"toolUse",
	);
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
