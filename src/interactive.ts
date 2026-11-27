// Modo interativo e de tarefa única do `dv`: detecta autenticação, conecta workspace tools ao executeRung
// e grava ledgers silenciosamente em .dv/runs/<timestamp>/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	CONTRACT_ID,
	CONTRACT_V5_ID,
	createWorkspaceTools,
	DEFAULT_SYSTEM_PROMPT,
	executeRung,
	type ModelRef,
} from "@dv-agent/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "../packages/dv-eval/src/auth/file_credential_store.ts";
import { type LiveAuthMode, openLiveSession } from "../packages/dv-eval/src/auth/live_session.ts";
import { resolveAuthPath } from "../packages/dv-eval/src/auth/subscription.ts";
import { findPackageRoot } from "../packages/dv-eval/src/package_paths.ts";
import { loadApprovedProbes } from "../packages/dv-eval/src/probe/provider_probe.ts";
import { readLedgerMetrics } from "../packages/dv-eval/src/smoke/ledger_metrics.ts";
import { parseModelRef, type PolicyName } from "../packages/dv-eval/src/smoke/runner.ts";

export type InteractivePolicy = Extract<PolicyName, "single" | "ladder" | "predictive-harness-router">;

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

export interface SessionTokens {
	calls: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_MAX_COST_USD = 5;
const VERSION_CHECK_TIMEOUT_MS = 1_500;
const ENV_KEY_CANDIDATES: readonly { provider: string; envVar: string; defaultModel: string }[] = [
	{ provider: "anthropic", envVar: "ANTHROPIC_API_KEY", defaultModel: "claude-haiku-5-5" },
	{ provider: "openai", envVar: "OPENAI_API_KEY", defaultModel: "gpt-4.1" },
	{ provider: "google", envVar: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash" },
	{ provider: "openrouter", envVar: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.5" },
	{ provider: "deepseek", envVar: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
	{ provider: "groq", envVar: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
];

export function loadDvUserConfig(homeDir: string = homedir()): DvUserConfig {
	const configPath = join(homeDir, ".dv", "config.json");
	if (!existsSync(configPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		const policy =
			raw.policy === "single" || raw.policy === "ladder" || raw.policy === "predictive-harness-router"
				? raw.policy
				: undefined;
		return {
			...(typeof raw.model === "string" && raw.model.includes("/") ? { model: raw.model } : {}),
			...(policy === undefined ? {} : { policy }),
			...(typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
		};
	} catch {
		return {};
	}
}

function firstModelForProvider(provider: string): string {
	const known = ENV_KEY_CANDIDATES.find((c) => c.provider === provider)?.defaultModel;
	if (known !== undefined) return known;
	if (getBuiltinProviders().includes(provider as never)) {
		const models = getBuiltinModels(provider as never);
		if (models.length > 0 && models[0] !== undefined) return models[0].id;
	}
	return "claude-haiku-5-5";
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

	const preferred = configuredModel ? parseModelRef(configuredModel) : undefined;
	if (preferred !== undefined) {
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
		const envMatch = ENV_KEY_CANDIDATES.find((c) => c.provider === preferred.provider && Boolean(env[c.envVar]?.trim()));
		if (envMatch !== undefined) {
			return {
				provider: preferred.provider,
				modelId: preferred.modelId,
				authMode: "api-key",
				authPath,
				source: `env:${envMatch.envVar}`,
			};
		}
	}

	const oauthEntry = stored.find((item) => item.type === "oauth");
	if (oauthEntry !== undefined) {
		return {
			provider: oauthEntry.providerId,
			modelId: firstModelForProvider(oauthEntry.providerId),
			authMode: "subscription",
			authPath,
			source: authPath,
		};
	}

	for (const candidate of ENV_KEY_CANDIDATES) {
		if (env[candidate.envVar]?.trim()) {
			return {
				provider: candidate.provider,
				modelId: candidate.defaultModel,
				authMode: "api-key",
				authPath,
				source: `env:${candidate.envVar}`,
			};
		}
	}

	return null;
}

export function authMissingGuidance(authPath: string): string {
	return [
		`Nenhuma sessão ou API key encontrada (verificado ${authPath} e variáveis de ambiente).`,
		"Autentique um provedor antes de executar:",
		"  - Antigravity (ACP): dv auth login agy",
		"  - Assinatura (Anthropic/Codex): npx @earendil-works/pi-ai@1.6.0 login anthropic",
		"  - API key: defina ANTHROPIC_API_KEY, OPENAI_API_KEY ou GEMINI_API_KEY",
		"Ou use /login no modo interativo.",
	].join("\n");
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

function extractAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg === undefined || msg.role !== "assistant") continue;
		const assistant = msg as AssistantMessage;
		const parts = assistant.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text);
		if (parts.length > 0) return parts.join("\n");
		if (assistant.errorMessage) return `[erro] ${assistant.errorMessage}`;
	}
	return "";
}

function createSilentRunDir(cwd: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = join(cwd, ".dv", "runs", stamp);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function runSingleTaskTurn(options: {
	cwd: string;
	prompt: string;
	modelRef: ModelRef;
	authMode: LiveAuthMode;
	authPath: string;
	policy: InteractivePolicy;
	maxTokens: number;
	sessionTokens: SessionTokens;
	turnIndex: number;
}): Promise<number> {
	const runDir = createSilentRunDir(options.cwd);
	const ledgerPath = join(runDir, `turn-${options.turnIndex}.ledger.jsonl`);
	const packageRoot = findPackageRoot(import.meta.dirname);
	const probesDir = join(packageRoot, "packages", "dv-eval", "probe-results");
	const approvedProbes = existsSync(probesDir) ? loadApprovedProbes(probesDir) : new Set<string>();

	const session = await openLiveSession({
		authMode: options.authMode,
		provider: options.modelRef.provider,
		modelId: options.modelRef.modelId,
		authPath: options.authPath,
		workspaceRoot: options.cwd,
	});
	const tools = createWorkspaceTools({ workspaceRoot: options.cwd });
	const result = await executeRung({
		ledgerPath,
		runId: `dv-cli-${options.turnIndex}`,
		harnessVariant: `dv-interactive:${options.policy}`,
		referenceProvenance: { workspace: options.cwd },
		datasetSha256: "interactive",
		taskDefinitionSha256: "interactive",
		model: session.model,
		systemPrompt: DEFAULT_SYSTEM_PROMPT,
		tools,
		prompt: options.prompt,
		streamFn: session.streamFn,
		priceBook: session.priceBook,
		maxCostUsd: options.authMode === "subscription" ? 0 : DEFAULT_MAX_COST_USD,
		maxTotalTokens: options.maxTokens,
		doomLoopMaxIdenticalConsecutive: 3,
		approvedProbes,
		contractId: options.modelRef.provider === "agy" ? CONTRACT_V5_ID : CONTRACT_ID,
		...(options.modelRef.reasoningEffort === undefined ? {} : { reasoningEffort: options.modelRef.reasoningEffort }),
	});

	const metrics = readLedgerMetrics(ledgerPath);
	options.sessionTokens.calls += metrics.calls;
	options.sessionTokens.prompt_tokens += metrics.prompt_tokens;
	options.sessionTokens.completion_tokens += metrics.completion_tokens;
	options.sessionTokens.total_tokens += metrics.total_tokens;

	const reply = extractAssistantText(result.messages);
	if (reply !== "") process.stdout.write(`${reply}\n`);
	if (result.status !== "completed") {
		console.error(`[dv] turno encerrado com status=${result.status}`);
		return 1;
	}
	return 0;
}

export function formatReplHelp(): string {
	return [
		"Comandos do REPL:",
		"  /help                                        Mostra esta ajuda",
		"  /model [provider/model]                      Mostra ou altera o modelo atual",
		"  /policy [single|ladder|predictive-harness-router]  Mostra ou altera a política",
		"  /tokens                                      Mostra tokens acumulados da sessão",
		"  /login [provider]                            Mostra instruções oficiais de login",
		"  /exit                                        Encerra a sessão",
	].join("\n");
}

export async function runInteractiveMode(options: {
	initialPrompt?: string;
	currentVersion: string;
}): Promise<number> {
	const cwd = process.cwd();
	const userConfig = loadDvUserConfig();
	const detected = await detectDefaultAuth(process.env, userConfig.model);
	const maxTokens = userConfig.maxTokens ?? DEFAULT_MAX_TOKENS;
	let policy: InteractivePolicy = userConfig.policy ?? "ladder";
	let modelRef: ModelRef | undefined = detected
		? { provider: detected.provider, modelId: detected.modelId }
		: userConfig.model
			? parseModelRef(userConfig.model)
			: undefined;
	let authMode: LiveAuthMode = detected?.authMode ?? "api-key";
	const authPath = detected?.authPath ?? resolveAuthPath();
	const sessionTokens: SessionTokens = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

	// Checagem não-bloqueante de versão no npm (timeout 1.5s, nunca falha offline).
	const updatePromise = checkNpmUpdateNonBlocking(options.currentVersion);

	if (options.initialPrompt !== undefined && options.initialPrompt.trim() !== "") {
		if (modelRef === undefined) {
			console.error(authMissingGuidance(authPath));
			return 1;
		}
		const code = await runSingleTaskTurn({
			cwd,
			prompt: options.initialPrompt,
			modelRef,
			authMode,
			authPath,
			policy,
			maxTokens,
			sessionTokens,
			turnIndex: 1,
		});
		const latest = await updatePromise;
		if (latest !== null) {
			console.error(`[dv] nova versão disponível (${latest}); execute "dv update" para atualizar.`);
		}
		return code;
	}

	process.stdout.write(`dv-agent ${options.currentVersion} — workspace: ${cwd}\n`);
	if (modelRef === undefined) {
		process.stdout.write(`${authMissingGuidance(authPath)}\n`);
	} else {
		process.stdout.write(
			`Modelo: ${modelRef.provider}/${modelRef.modelId} | Política: ${policy} | Orçamento: ${maxTokens} tokens\n`,
		);
	}
	process.stdout.write('Digite uma tarefa ou /help para comandos.\n');

	void updatePromise.then((latest) => {
		if (latest !== null) {
			process.stdout.write(`\n[dv] nova versão disponível (${latest}); execute "dv update" para atualizar.\n`);
		}
	});

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let turnIndex = 0;
	try {
		for (;;) {
			let line: string;
			try {
				line = await rl.question("dv> ");
			} catch {
				break;
			}
			const trimmed = line.trim();
			if (trimmed === "") continue;
			if (trimmed === "/exit" || trimmed === "/quit") break;
			if (trimmed === "/help") {
				process.stdout.write(`${formatReplHelp()}\n`);
				continue;
			}
			if (trimmed === "/tokens") {
				process.stdout.write(`${JSON.stringify(sessionTokens)}\n`);
				continue;
			}
			if (trimmed === "/model" || trimmed.startsWith("/model ")) {
				const arg = trimmed.slice("/model".length).trim();
				if (arg === "") {
					process.stdout.write(
						modelRef ? `Modelo atual: ${modelRef.provider}/${modelRef.modelId}\n` : "Nenhum modelo configurado.\n",
					);
				} else {
					try {
						modelRef = parseModelRef(arg);
						if (modelRef.provider === "agy") authMode = "subscription";
						process.stdout.write(`Modelo alterado para ${modelRef.provider}/${modelRef.modelId}\n`);
					} catch (error) {
						console.error(error instanceof Error ? error.message : String(error));
					}
				}
				continue;
			}
			if (trimmed === "/policy" || trimmed.startsWith("/policy ")) {
				const arg = trimmed.slice("/policy".length).trim();
				if (arg === "") {
					process.stdout.write(`Política atual: ${policy}\n`);
				} else if (arg === "single" || arg === "ladder" || arg === "predictive-harness-router") {
					policy = arg;
					process.stdout.write(`Política alterada para ${policy}\n`);
				} else {
					console.error("Política inválida. Use: single | ladder | predictive-harness-router");
				}
				continue;
			}
			if (trimmed === "/login" || trimmed.startsWith("/login ")) {
				const provider = trimmed.slice("/login".length).trim() || "agy";
				if (provider === "agy") {
					process.stdout.write("Execute no terminal: dv auth login agy\n");
				} else {
					process.stdout.write(`Execute no terminal: npx @earendil-works/pi-ai@1.6.0 login ${provider}\n`);
				}
				continue;
			}
			if (trimmed.startsWith("/")) {
				console.error(`Comando desconhecido: ${trimmed}. Use /help.`);
				continue;
			}
			if (modelRef === undefined) {
				console.error(authMissingGuidance(authPath));
				continue;
			}
			turnIndex += 1;
			try {
				await runSingleTaskTurn({
					cwd,
					prompt: trimmed,
					modelRef,
					authMode,
					authPath,
					policy,
					maxTokens,
					sessionTokens,
					turnIndex,
				});
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
	} finally {
		rl.close();
	}
	return 0;
}
