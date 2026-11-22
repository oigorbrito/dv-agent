// Sessão de assinatura do pi (OAuth de plano: Claude Pro/Max, ChatGPT Plus/Pro). Usa o auth.json do pi-ai, sem
// variável de ambiente de API key. Nunca imprime tokens: mensagens citam só provedor e caminho do arquivo.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { FileCredentialStore } from "./file_credential_store.ts";

/** Pi-ai pinado no repositório: o comando de login usa a mesma versão. */
const PI_AI_PACKAGE = "@earendil-works/pi-ai@1.6.0";

/** Sessão ausente ou inadequada. A mensagem diz como autenticar, sem expor segredo. */
export class SubscriptionLoginRequired extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubscriptionLoginRequired";
	}
}

/**
 * Caminho do auth.json. Ordem: DV_AUTH_FILE; PI_CODING_AGENT_DIR/auth.json (mesma variável do pi); ~/.pi/agent/auth.json.
 */
export function resolveAuthPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.DV_AUTH_FILE) return env.DV_AUTH_FILE;
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "auth.json");
}

function loginInstructions(providerId: string, authPath: string): string {
	const dir = join(authPath, "..");
	return [
		`Sessão de assinatura de "${providerId}" não encontrada em ${authPath}.`,
		"Autentique pelo pi-ai. O token é gravado com permissão 0600; não cole token em chat, log ou arquivo.",
		`  1. mkdir -p "${dir}" && cd "${dir}"`,
		`  2. npx ${PI_AI_PACKAGE} login ${providerId}`,
		"     (siga o link no navegador e cole o código quando pedido; o comando grava auth.json no diretório atual)",
		"Depois rode de novo com --auth-mode subscription. Para outro arquivo, defina DV_AUTH_FILE.",
	].join("\n");
}

/**
 * Confere que o provedor oferece assinatura (flag isSubscription do pi-ai) e que há credencial OAuth guardada.
 * Não há fallback para API key: credencial api_key com este modo é erro explícito.
 */
export async function requireSubscriptionSession(
	store: FileCredentialStore,
	provider: Provider,
): Promise<Extract<Credential, { type: "oauth" }>> {
	if (provider.auth.oauth?.isSubscription !== true) {
		throw new SubscriptionLoginRequired(`o provedor "${provider.id}" não oferece autenticação por assinatura no pi-ai`);
	}
	const credential = await store.read(provider.id);
	if (credential === undefined) throw new SubscriptionLoginRequired(loginInstructions(provider.id, store.authPath));
	if (credential.type !== "oauth") {
		throw new SubscriptionLoginRequired(
			`a credencial guardada para "${provider.id}" é api_key, não sessão de assinatura; use --auth-mode api-key ou faça login OAuth`,
		);
	}
	return credential;
}
