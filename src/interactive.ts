// Autenticação, preferências (~/.dv/config.json), menu de login e atualização do `dv`.
// A sessão interativa (REPL) fica em repl.ts.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGY_MODELS, AGY_PROVIDER, DV_CLIENT_IDENTITY, isAgyModel, type ModelRef } from "@dv-agent/core";
import { createModels } from "@earendil-works/pi-ai";
import {
	type BuiltinProvider,
	builtinProviders,
	getBuiltinModel,
	getBuiltinModels,
	getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { loginAgy } from "../packages/dv-eval/src/auth/agy_auth.ts";
import { FileCredentialStore } from "../packages/dv-eval/src/auth/file_credential_store.ts";
import { type LiveAuthMode } from "../packages/dv-eval/src/auth/live_session.ts";
import { resolveAuthPath } from "../packages/dv-eval/src/auth/subscription.ts";
import { parseModelRef, type PolicyName } from "../packages/dv-eval/src/smoke/runner.ts";

export type InteractivePolicy = Extract<PolicyName, "single" | "ladder" | "architect-editor" | "predictive-harness-router">;

export const POLICIES: readonly InteractivePolicy[] = [
	"ladder",
	"single",
	"predictive-harness-router",
	"architect-editor",
];

export interface DvUserConfig {
	model?: string;
	policy?: InteractivePolicy;
	maxTokens?: number;
}

export interface DetectedAuth {
	provider: string;
	modelId: string;
	authMode: LiveAuthMode;
	authPath: string;
	source: string;
}

export const DEFAULT_MAX_TOKENS = 200_000;
export const DEFAULT_MAX_COST_USD = 5;
const VERSION_CHECK_TIMEOUT_MS = 1_500;

export const PROVIDER_DEFAULTS: readonly {
	provider: string;
	envVar?: string;
	preferredModels: readonly string[];
	tier: "free" | "paid";
}[] = [
	{
		provider: "anthropic",
		envVar: "ANTHROPIC_API_KEY",
		preferredModels: ["claude-haiku-4-5", "claude-fable-5-2", "claude-fable-5"],
		tier: "paid",
	},
	{
		provider: "openai-codex",
		preferredModels: ["gpt-5.6-luna", "gpt-5.6-sol"],
		tier: "paid",
	},
	{
		provider: "openai",
		envVar: "OPENAI_API_KEY",
		preferredModels: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
		tier: "paid",
	},
	{
		provider: "google",
		envVar: "GEMINI_API_KEY",
		preferredModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
		tier: "free",
	},
	{
		provider: "groq",
		envVar: "GROQ_API_KEY",
		preferredModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
		tier: "free",
	},
	{
		provider: "openrouter",
		envVar: "OPENROUTER_API_KEY",
		preferredModels: ["anthropic/claude-fable-5", "~anthropic/claude-haiku-latest"],
		tier: "paid",
	},
	{
		provider: "deepseek",
		envVar: "DEEPSEEK_API_KEY",
		preferredModels: ["deepseek-flash", "deepseek-v4-pro"],
		tier: "paid",
	},
];

/** Verifica se provider/modelId existe no catálogo suportado (agy ou pi-ai). Rejeita placeholders como radius/balanced. */
export function isValidCatalogModel(provider: string, modelId: string): boolean {
	if (provider === "radius") return false;
	if (provider === AGY_PROVIDER) return isAgyModel(modelId);
	if (!getBuiltinProviders().includes(provider as BuiltinProvider)) return false;
	return getBuiltinModel(provider as BuiltinProvider, modelId as never) !== undefined;
}

/** Devolve o primeiro modelo válido do catálogo para o provedor informado, ou null se o provedor não existir. */
export function defaultModelForProvider(provider: string): string | null {
	if (provider === AGY_PROVIDER) return AGY_MODELS[0]?.modelId ?? null;
	if (!getBuiltinProviders().includes(provider as BuiltinProvider)) return null;
	const entry = PROVIDER_DEFAULTS.find((c) => c.provider === provider);
	for (const candidate of entry?.preferredModels ?? []) {
		if (isValidCatalogModel(provider, candidate)) return candidate;
	}
	const all = getBuiltinModels(provider as BuiltinProvider);
	return all[0]?.id ?? null;
}

/** Lista de provedores do catálogo (pi-ai) mais o provedor agy, para seletores. */
export function catalogProviders(): string[] {
	return [...getBuiltinProviders().map((p) => p as string), AGY_PROVIDER];
}

/** Lista de modelos válidos de um provedor do catálogo. */
export function catalogModels(provider: string): string[] {
	if (provider === AGY_PROVIDER) return AGY_MODELS.map((m) => m.modelId);
	if (!getBuiltinProviders().includes(provider as BuiltinProvider)) return [];
	return getBuiltinModels(provider as BuiltinProvider).map((m) => m.id);
}

/** Formata provider/modelId com o sufixo `:effort` quando houver esforço definido (formato aceito por parseModelRef). */
export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}${ref.reasoningEffort === undefined ? "" : `:${ref.reasoningEffort}`}`;
}

export function loadDvUserConfig(homeDir: string = homedir()): DvUserConfig {
	const configPath = join(homeDir, ".dv", "config.json");
	if (!existsSync(configPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		const policy = POLICIES.find((p) => p === raw.policy);
		let validModel: string | undefined;
		if (typeof raw.model === "string" && raw.model.includes("/")) {
			try {
				const parsed = parseModelRef(raw.model);
				if (isValidCatalogModel(parsed.provider, parsed.modelId)) {
					validModel = formatModelRef(parsed);
				}
			} catch {
				validModel = undefined;
			}
		}
		return {
			...(validModel === undefined ? {} : { model: validModel }),
			...(policy === undefined ? {} : { policy }),
			...(typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
		};
	} catch {
		return {};
	}
}

export function saveDvUserConfig(patch: DvUserConfig, homeDir: string = homedir()): string {
	const dir = join(homeDir, ".dv");
	mkdirSync(dir, { recursive: true });
	const configPath = join(dir, "config.json");
	const current = loadDvUserConfig(homeDir);
	const merged: DvUserConfig = {
		...current,
		...patch,
	};
	writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	return configPath;
}

export async function detectDefaultAuth(
	env: NodeJS.ProcessEnv = process.env,
	configuredModel?: string,
): Promise<DetectedAuth | null> {
	const authPath = resolveAuthPath(env);
	const store = new FileCredentialStore(authPath);
	let stored: readonly { providerId: string; type: string }[] = [];
	try {
		stored = await store.list();
	} catch {
		stored = [];
	}

	if (configuredModel !== undefined) {
		try {
			const preferred = parseModelRef(configuredModel);
			if (isValidCatalogModel(preferred.provider, preferred.modelId)) {
				const matchStored = stored.find((item) => item.providerId === preferred.provider);
				if (matchStored !== undefined) {
					return {
						provider: preferred.provider,
						modelId: preferred.modelId,
						authMode: matchStored.type === "oauth" ? "subscription" : "api-key",
						authPath,
						source: authPath,
					};
				}
				const envEntry = PROVIDER_DEFAULTS.find(
					(c) => c.provider === preferred.provider && c.envVar !== undefined && Boolean(env[c.envVar]?.trim()),
				);
				if (envEntry !== undefined && envEntry.envVar !== undefined) {
					return {
						provider: preferred.provider,
						modelId: preferred.modelId,
						authMode: "api-key",
						authPath,
						source: `env:${envEntry.envVar}`,
					};
				}
			}
		} catch {
			// Modelo configurado inválido: ignora e segue para detecção por provedor autenticado.
		}
	}

	for (const item of stored) {
		if (item.type !== "oauth") continue;
		const modelId = defaultModelForProvider(item.providerId);
		if (modelId !== null) {
			return {
				provider: item.providerId,
				modelId,
				authMode: "subscription",
				authPath,
				source: authPath,
			};
		}
	}

	for (const item of stored) {
		if (item.type !== "api_key") continue;
		const modelId = defaultModelForProvider(item.providerId);
		if (modelId !== null) {
			return {
				provider: item.providerId,
				modelId,
				authMode: "api-key",
				authPath,
				source: authPath,
			};
		}
	}

	for (const candidate of PROVIDER_DEFAULTS) {
		if (candidate.envVar !== undefined && env[candidate.envVar]?.trim()) {
			const modelId = defaultModelForProvider(candidate.provider);
			if (modelId !== null) {
				return {
					provider: candidate.provider,
					modelId,
					authMode: "api-key",
					authPath,
					source: `env:${candidate.envVar}`,
				};
			}
		}
	}

	return null;
}

export function authMissingGuidance(authPath: string): string {
	return [
		`Nenhuma sessão ou API key válida encontrada (verificado ${authPath} e variáveis de ambiente).`,
		"Escolha uma opção de autenticação:",
		"  1) Browser / assinatura: dv --login (ou /login no REPL) -> anthropic, openai-codex ou agy",
		"  2) Chave de API (api-key): defina ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY ou salve via /login",
		"  3) Rota gratuita (free) ou paga (paid): configurável interativamente via dv --login",
	].join("\n");
}

export interface InteractiveLoginContext {
	ask: (prompt: string) => Promise<string>;
	write: (text: string) => void;
	authPath: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	loginOAuth?: (provider: string, authPath: string) => Promise<void>;
	/** Seletor com setas (TTY). Sem ele, o menu é numerado e lido com `ask`. */
	select?: (title: string, labels: readonly string[]) => Promise<number | null>;
}

const LOGIN_OPTIONS: readonly string[] = [
	"Login via browser / assinatura (anthropic, openai-codex, agy)",
	"Chave de API (api-key: anthropic, openai, google, groq, openrouter, deepseek)",
	"Rota gratuita (free: google/gemini-2.5-flash ou groq/llama-3.3-70b-versatile)",
	"Rota paga (paid: anthropic/claude-haiku-4-5 ou openai/gpt-4.1)",
	"Cancelar",
];

async function defaultOAuthLogin(
	providerId: string,
	authPath: string,
	ask: (prompt: string) => Promise<string>,
	write: (text: string) => void,
): Promise<void> {
	if (providerId === AGY_PROVIDER) {
		await loginAgy();
		return;
	}
	const provider = builtinProviders().find((p) => p.id === providerId);
	if (provider === undefined || !provider.auth.oauth) {
		throw new Error(`provedor "${providerId}" não oferece login OAuth (browser) no pi-ai`);
	}
	const store = new FileCredentialStore(authPath);
	const models = createModels({ credentials: store, identity: DV_CLIENT_IDENTITY });
	models.setProvider(provider);
	await models.login(
		providerId,
		"oauth",
		{
			signal: new AbortController().signal,
			prompt: async (authPrompt) => {
				if (authPrompt.type === "select") {
					const opts = authPrompt.options.map((o, i) => `  ${i + 1}. ${o.label} (${o.id})`).join("\n");
					const ans = (await ask(`${authPrompt.message}\n${opts}\nEscolha: `)).trim();
					const idx = Number(ans) - 1;
					return Number.isInteger(idx) && authPrompt.options[idx] !== undefined ? authPrompt.options[idx].id : ans;
				}
				return (await ask(`${authPrompt.message}: `)).trim();
			},
			notify: (event) => {
				if (event.type === "auth_url") write(`\nAbra esta URL no navegador:\n${event.url}\n`);
				else if (event.type === "device_code") write(`\nURL: ${event.verificationUri}\nCódigo: ${event.userCode}\n`);
				else if (event.type === "info" || event.type === "progress") write(`${event.message}\n`);
			},
		},
		{ getDeviceId: randomUUID },
	);
}

/** Menu de autenticação e seleção de modelo válido (browser, api-key, free, paid). */
export async function promptLoginMenu(ctx: InteractiveLoginContext): Promise<DetectedAuth | null> {
	const env = ctx.env ?? process.env;
	const homeDir = ctx.homeDir ?? homedir();
	let choice: string;
	if (ctx.select !== undefined) {
		const index = await ctx.select("Configuração de autenticação do dv", LOGIN_OPTIONS);
		choice = index === null || index === LOGIN_OPTIONS.length - 1 ? "0" : String(index + 1);
	} else {
		ctx.write(
			[
				"\nConfiguração de autenticação do dv:",
				"  1) Login via browser / assinatura (anthropic, openai-codex, agy)",
				"  2) Chave de API (api-key: anthropic, openai, google, groq, openrouter, deepseek)",
				"  3) Rota gratuita (free: google/gemini-2.5-flash ou groq/llama-3.3-70b-versatile)",
				"  4) Rota paga (paid: anthropic/claude-haiku-4-5 ou openai/gpt-4.1)",
				"  0) Cancelar",
				"",
			].join("\n"),
		);
		choice = (await ctx.ask("Escolha [1-4, 0 para sair]: ")).trim();
	}
	if (choice === "" || choice === "0") return null;

	let provider = "";
	let authMode: LiveAuthMode = "api-key";
	if (choice === "1") {
		const raw = (await ctx.ask("Provedor (anthropic | openai-codex | agy) [anthropic]: ")).trim() || "anthropic";
		provider = raw;
		authMode = "subscription";
		const oauthFn = ctx.loginOAuth ?? ((p, ap) => defaultOAuthLogin(p, ap, ctx.ask, ctx.write));
		await oauthFn(provider, ctx.authPath);
	} else if (choice === "2" || choice === "3" || choice === "4") {
		const defaultProv = choice === "3" ? "google" : "anthropic";
		const promptLabel =
			choice === "3"
				? "Provedor gratuito (google | groq) [google]: "
				: choice === "4"
					? "Provedor pago (anthropic | openai | openrouter | deepseek) [anthropic]: "
					: "Provedor para api-key (anthropic | openai | google | groq | openrouter | deepseek) [anthropic]: ";
		provider = (await ctx.ask(promptLabel)).trim() || defaultProv;
		authMode = "api-key";
		const entry = PROVIDER_DEFAULTS.find((c) => c.provider === provider);
		const envValue = entry?.envVar !== undefined ? env[entry.envVar]?.trim() : undefined;
		if (!envValue) {
			const key = (await ctx.ask(`Informe a API key para ${provider}: `)).trim();
			if (key === "") throw new Error(`API key vazia para ${provider}`);
			const store = new FileCredentialStore(ctx.authPath);
			await store.modify(provider, async () => ({ type: "api_key", key }));
		}
	} else {
		throw new Error(`opção inválida: ${choice}`);
	}

	const modelId = defaultModelForProvider(provider);
	if (modelId === null || !isValidCatalogModel(provider, modelId)) {
		throw new Error(`nenhum modelo válido encontrado no catálogo para o provedor "${provider}"`);
	}
	saveDvUserConfig({ model: `${provider}/${modelId}` }, homeDir);
	ctx.write(`Configurado ${provider}/${modelId} (${authMode}) em ${join(homeDir, ".dv", "config.json")}.\n`);
	return {
		provider,
		modelId,
		authMode,
		authPath: ctx.authPath,
		source: choice === "1" ? "oauth" : ctx.authPath,
	};
}

export async function checkNpmUpdateNonBlocking(
	currentVersion: string,
	fetchFn: typeof fetch = fetch,
): Promise<string | null> {
	try {
		const response = await fetchFn("https://registry.npmjs.org/@engfinecode/dv-agent/latest", {
			signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
			headers: { accept: "application/json" },
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { version?: unknown };
		if (typeof body.version === "string" && body.version !== "" && body.version !== currentVersion) {
			return body.version;
		}
		return null;
	} catch {
		return null;
	}
}

export function runSelfUpdate(): number {
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	const res = spawnSync(npmCmd, ["install", "-g", "@engfinecode/dv-agent@latest"], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	return res.status ?? 1;
}
