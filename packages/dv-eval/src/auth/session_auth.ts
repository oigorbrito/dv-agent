// Camada mínima de login (browser/api-key) e checagem de sessão para provedores pi-ai e agy.
// Não usa OAuth reverso nem proxy; delega ao fluxo oficial do pi-ai (auth.json) ou ao binário oficial do agy.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { AcpClient, AGY_MODELS, AGY_PROVIDER, DV_CLIENT_IDENTITY, sanitizeTransportMessage } from "@dv-agent/core";
import type { AuthInteraction, AuthPrompt, AuthType, Credential } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { type BuiltinProvider, builtinProviders, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { CredentialFileError, FileCredentialStore } from "./file_credential_store.ts";
import { resolveAuthPath } from "./subscription.ts";

export type AuthLoginMode = "browser" | "api-key";
export type AuthCheckStatus = "ready" | "not_ready" | "invalid";

export interface AuthCheckResult {
	status: AuthCheckStatus;
	provider: string;
	authType?: "api_key" | "oauth" | "local_login";
	reason?: string;
}

export interface CheckAuthOptions {
	provider: string;
	authPath?: string;
	refresh?: boolean;
	cwd?: string;
	timeoutMs?: number;
	openAgy?: (options: { cwd: string; modelId: string; timeoutMs: number }) => Promise<{ close(): Promise<void> }>;
}

export interface LoginAuthOptions {
	provider: string;
	mode: AuthLoginMode;
	authPath?: string;
	interaction?: AuthInteraction;
	getDeviceId?: () => string;
	checkAgy?: () => Promise<AuthCheckResult>;
}

export interface LoginAuthResult {
	provider: string;
	mode: AuthLoginMode;
	authPath?: string;
	message: string;
}

const DEFAULT_AGY_CHECK_TIMEOUT_MS = 30_000;

/** Checa se o provedor está pronto para uso (0 = ready, 1 = not_ready, 2 = invalid). */
export async function checkAuthSession(options: CheckAuthOptions): Promise<AuthCheckResult> {
	if (options.provider === AGY_PROVIDER) {
		const open = options.openAgy ?? ((opts) => AcpClient.open(opts));
		const modelId = AGY_MODELS[0]?.modelId ?? "gemini-3.8-flash-high";
		let client: { close(): Promise<void> } | undefined;
		try {
			client = await open({
				cwd: options.cwd ?? process.cwd(),
				modelId,
				timeoutMs: options.timeoutMs ?? DEFAULT_AGY_CHECK_TIMEOUT_MS,
			});
			return { status: "ready", provider: AGY_PROVIDER, authType: "local_login" };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { status: "not_ready", provider: AGY_PROVIDER, reason: sanitizeTransportMessage(detail) };
		} finally {
			await client?.close();
		}
	}

	if (!getBuiltinProviders().includes(options.provider as BuiltinProvider)) {
		return { status: "not_ready", provider: options.provider, reason: "provider_not_found" };
	}
	const provider = builtinProviders().find((p) => p.id === options.provider);
	if (provider === undefined) {
		return { status: "not_ready", provider: options.provider, reason: "provider_not_found" };
	}

	const authPath = options.authPath ?? resolveAuthPath();
	const store = new FileCredentialStore(authPath);
	try {
		const models = createModels({ credentials: store, identity: DV_CLIENT_IDENTITY });
		models.setProvider(provider);
		const auth = await models.checkAuth(options.provider);
		if (!auth) return { status: "not_ready", provider: options.provider, reason: "credentials_not_configured" };
		if (options.refresh === true && !(await models.getAuth(options.provider))) {
			return { status: "not_ready", provider: options.provider, reason: "credentials_not_configured" };
		}
		return { status: "ready", provider: options.provider, authType: auth.type };
	} catch (error) {
		if (error instanceof CredentialFileError) {
			return { status: "invalid", provider: options.provider, reason: "invalid_state" };
		}
		return { status: "invalid", provider: options.provider, reason: "invalid_state" };
	}
}

function createTerminalInteraction(signal: AbortSignal): { interaction: AuthInteraction; close(): void } {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const interaction: AuthInteraction = {
		signal,
		prompt: async (authPrompt: AuthPrompt) => {
			if (authPrompt.type === "select") {
				const list = authPrompt.options.map((opt, idx) => `  ${idx + 1}. ${opt.label} (${opt.id})`).join("\n");
				const answer = await rl.question(`${authPrompt.message}\n${list}\nEscolha (número ou id): `);
				const trimmed = answer.trim();
				const index = Number(trimmed) - 1;
				return Number.isInteger(index) && authPrompt.options[index] !== undefined
					? authPrompt.options[index].id
					: trimmed;
			}
			const suffix = authPrompt.placeholder ? ` (${authPrompt.placeholder})` : "";
			const answer = await rl.question(`${authPrompt.message}${suffix}: `);
			return answer.trim();
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					console.log(`\nAbra esta URL no navegador:\n${event.url}`);
					if (event.instructions) console.log(event.instructions);
					break;
				case "device_code":
					console.log(`\nAbra esta URL no navegador:\n${event.verificationUri}`);
					console.log(`Código: ${event.userCode}`);
					break;
				case "info":
				case "progress":
					console.log(event.message);
					break;
			}
		},
	};
	return { interaction, close: () => rl.close() };
}

/** Executa login oficial do provedor (browser OAuth ou api-key) sem expor segredos. */
export async function loginAuthSession(options: LoginAuthOptions): Promise<LoginAuthResult> {
	if (options.provider === AGY_PROVIDER) {
		if (options.mode === "api-key") {
			throw new Error("agy usa o login local oficial do próprio agy (sem --api-key)");
		}
		const check = await (options.checkAgy ? options.checkAgy() : checkAuthSession({ provider: AGY_PROVIDER }));
		if (check.status === "ready") {
			return {
				provider: AGY_PROVIDER,
				mode: "browser",
				message: "Sessão local oficial do agy já está pronta.",
			};
		}
		throw new Error(
			`Sessão do agy indisponível (${check.reason ?? "não autenticado"}). Faça login no aplicativo/CLI oficial do Antigravity (agy) no ambiente e rode "dv auth check --provider agy".`,
		);
	}

	if (!getBuiltinProviders().includes(options.provider as BuiltinProvider)) {
		throw new Error(`provedor desconhecido no pi-ai: ${options.provider}`);
	}
	const provider = builtinProviders().find((p) => p.id === options.provider);
	if (provider === undefined) throw new Error(`provedor sem implementação no pi-ai: ${options.provider}`);

	const authType: AuthType = options.mode === "api-key" ? "api_key" : "oauth";
	if (authType === "oauth" && !provider.auth.oauth) {
		throw new Error(`provedor "${options.provider}" não oferece login OAuth (browser) no pi-ai; tente --api-key`);
	}
	if (authType === "api_key" && !provider.auth.apiKey) {
		throw new Error(`provedor "${options.provider}" não aceita --api-key no pi-ai`);
	}

	const authPath = options.authPath ?? resolveAuthPath();
	const store = new FileCredentialStore(authPath);
	const models = createModels({ credentials: store, identity: DV_CLIENT_IDENTITY });
	models.setProvider(provider);

	const controller = new AbortController();
	const owned = options.interaction === undefined ? createTerminalInteraction(controller.signal) : undefined;
	const interaction = options.interaction ?? owned!.interaction;
	try {
		const credential: Credential = await models.login(options.provider, authType, interaction, {
			getDeviceId: options.getDeviceId ?? randomUUID,
		});
		const savedAs = credential.type === "oauth" ? "sessão OAuth (browser)" : "API key";
		return {
			provider: options.provider,
			mode: options.mode,
			authPath,
			message: `Credencial (${savedAs}) de "${options.provider}" salva em ${authPath} (0600).`,
		};
	} finally {
		owned?.close();
	}
}
