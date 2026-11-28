// Overlay local de modelos do pi-ai, mantido fora do código vendorizado (UPSTREAM_PIN.json: sem modificações).
// Consultado antes do catálogo gerado. Cada entrada aqui declara de onde vêm seus metadados.
//
// gpt-6.1-luna (openai-codex): removido do catálogo upstream na 1.7.0. Mantido aqui porque é o modelo que o projeto
// quer usar quando a conta ChatGPT estiver habilitada. Limites conhecidos:
//   - Disponibilidade depende da conta: hoje o backend recusa com conta ChatGPT ("not supported when using Codex
//     with a ChatGPT account", probe live 2026-11; ver BENCHMARK-REPORT.md, seção 7). A entrada não prova acesso.
//   - api, janela e preços são herdados de gpt-6-luna e não verificados para o 6.1.
import type { BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/** Entrada do overlay: id e nome próprios, com metadados herdados de um modelo do catálogo. */
interface OverlayEntry {
	readonly provider: "openai-codex";
	readonly id: string;
	readonly name: string;
	readonly inheritFrom: string;
}

const OVERLAY_ENTRIES: readonly OverlayEntry[] = [
	{ provider: "openai-codex", id: "gpt-6.1-luna", name: "GPT-6.1 Luna", inheritFrom: "gpt-6-luna" },
];

/** Modelo de chat no formato do catálogo (campos usados pelo dv-eval). */
export type ChatModel = Record<string, unknown> & { id: string; name: string; api: string };

/** Lê um modelo de chat: primeiro o overlay local, depois o catálogo gerado do pi-ai. */
export function getChatModel(provider: BuiltinProvider, modelId: string): ChatModel | undefined {
	const entry = OVERLAY_ENTRIES.find((e) => e.provider === provider && e.id === modelId);
	if (entry !== undefined) {
		const base = getBuiltinModel(provider, entry.inheritFrom as never) as unknown as ChatModel | undefined;
		if (base === undefined) throw new Error(`overlay ${provider}/${modelId}: base ${entry.inheritFrom} ausente`);
		return { ...base, id: entry.id, name: entry.name };
	}
	return getBuiltinModel(provider, modelId as never) as unknown as ChatModel | undefined;
}

/** Ids de modelos de chat do overlay, para testes e diagnóstico. */
export function overlayModelIds(): readonly string[] {
	return OVERLAY_ENTRIES.map((e) => `${e.provider}/${e.id}`);
}
