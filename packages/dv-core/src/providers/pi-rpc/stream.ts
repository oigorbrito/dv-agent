// Adaptador pi-rpc (@earendil-works/pi-coding-agent --mode rpc) como StreamFn do executeRung.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { SpawnFn } from "../agy/acp_client.ts";
import { promptFromContext } from "../agy/stream.ts";
import { runPiRpcTurn } from "./rpc_client.ts";

export interface PiRpcStreamOptions {
	cwd: string;
	timeoutMs?: number;
	thinkingLevel?: string;
	command?: readonly string[];
	spawn?: SpawnFn;
}

export function createPiRpcStreamFn(options: PiRpcStreamOptions): StreamFn {
	return (model, context, streamOptions) => {
		const stream = createAssistantMessageEventStream();
		void executeRpcStream(stream, model, context, options, streamOptions?.signal);
		return stream;
	};
}

async function executeRpcStream(
	stream: AssistantMessageEventStream,
	model: Model<string>,
	context: Context,
	options: PiRpcStreamOptions,
	signal: AbortSignal | undefined,
): Promise<void> {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial });

	const result = await runPiRpcTurn({
		cwd: options.cwd,
		provider: model.provider,
		modelId: model.id,
		prompt: promptFromContext(context),
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.command === undefined ? {} : { command: options.command }),
		...(options.spawn === undefined ? {} : { spawn: options.spawn }),
		...(signal === undefined ? {} : { signal }),
		onTextDelta: (delta) => {
			partial.content = [{ type: "text", text: delta }];
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
		},
	});

	const finalMessage: AssistantMessage = {
		role: "assistant",
		content: result.text === "" ? [] : [{ type: "text", text: result.text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
			cacheWrite: result.usage.cacheWrite,
			totalTokens: result.usage.totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.usage.costTotal },
		},
		stopReason: result.stopReason,
		...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
		timestamp: Date.now(),
	};

	if (result.stopReason === "error" || result.stopReason === "aborted") {
		stream.push({ type: "error", reason: result.stopReason, error: finalMessage });
	} else {
		stream.push({ type: "done", reason: result.stopReason, message: finalMessage });
	}
	stream.end(finalMessage);
}
