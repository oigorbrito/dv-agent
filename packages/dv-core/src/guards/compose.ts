// Compõe interceptores de before_tool_call: o primeiro que bloqueia vence e os seguintes não rodam.
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";

export type BeforeToolCallHook = (
	context: BeforeToolCallContext,
) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;

/** Encadeia hooks em ordem. Retorna o primeiro bloqueio encontrado. */
export function composeBeforeToolCall(
	hooks: readonly BeforeToolCallHook[],
): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	return async (context) => {
		for (const hook of hooks) {
			const result = await hook(context);
			if (result?.block) return result;
		}
		return undefined;
	};
}
