// Assinatura de uma chamada de ferramenta: nome + SHA-256 dos argumentos canônicos. Os argumentos brutos nunca são guardados.
import type { AgentToolCall } from "@earendil-works/pi-agent-core";
import { canonicalJson, sha256Hex } from "../util/canonical.ts";

/** SHA-256 dos argumentos com chaves ordenadas. Mesmo conteúdo, mesmo digest. */
export function argumentsSha256(args: unknown): string {
	return sha256Hex(canonicalJson(args));
}

/** Assinatura de repetição: nome da ferramenta + digest dos argumentos. */
export function toolSignature(toolCall: AgentToolCall): string {
	return `${toolCall.name}\u0000${argumentsSha256(toolCall.arguments)}`;
}
