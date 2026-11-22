// Suporte de teste offline: preço fixo, diretórios temporários e ferramenta de escrita em memória.
// O runtime faux fica em src/testing/faux_runtime.ts (compartilhado com dv-eval).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PriceBook, PriceEntry } from "../src/index.ts";

export type { Turn } from "../src/testing/faux_runtime.ts";
export { fauxRuntime, textTurn, toolTurn, usage } from "../src/testing/faux_runtime.ts";

/** Preço fixo do teste: 1 USD por 1M input, 4 por 1M output. Cache com preços próprios. */
export const TEST_PRICE: PriceEntry = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

export function tempDir(name: string): string {
	return mkdtempSync(join(tmpdir(), `dv-${name}-`));
}

export function priceBookFor(keys: readonly string[]): PriceBook {
	const entries: Record<string, PriceEntry> = {};
	for (const key of keys) entries[key] = TEST_PRICE;
	return { id: "test-prices-v1", source: "dv-core test fixture", entries };
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
