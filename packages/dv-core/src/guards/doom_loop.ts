// Detector de doom loop: bloqueia em before_tool_call a N+1-ésima chamada idêntica consecutiva (mesmo nome e mesmos argumentos).
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { toolSignature } from "./tool_signature.ts";

export interface DoomLoopOptions {
	/** Quantas chamadas idênticas consecutivas são permitidas. A chamada seguinte é bloqueada. */
	maxIdenticalConsecutive: number;
}

/** Interceptor de before_tool_call. Chamadas bloqueadas não reiniciam o streak: continuar repetindo continua bloqueado. */
export class DoomLoopDetector {
	readonly maxIdenticalConsecutive: number;
	blocks: number;
	private lastSignature: string | undefined;
	private streak: number;

	constructor(options: DoomLoopOptions) {
		this.maxIdenticalConsecutive = options.maxIdenticalConsecutive;
		this.blocks = 0;
		this.lastSignature = undefined;
		this.streak = 0;
	}

	beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
		const signature = toolSignature(context.toolCall);
		const repeats = signature === this.lastSignature;
		if (repeats && this.streak >= this.maxIdenticalConsecutive) {
			this.blocks += 1;
			return {
				block: true,
				reason: `doom_loop: ${context.toolCall.name} repetido ${this.streak + 1} vezes com os mesmos argumentos (limite ${this.maxIdenticalConsecutive})`,
			};
		}
		this.streak = repeats ? this.streak + 1 : 1;
		this.lastSignature = signature;
		return undefined;
	}
}
