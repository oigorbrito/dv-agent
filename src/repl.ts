// Sessão interativa do `dv` (REPL): cabeçalho, prompt com popup `/`, comandos de sessão/workspace, `!` shell e turnos.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
	AGY_PROVIDER,
	CONTRACT_ID,
	CONTRACT_V5_ID,
	createWorkspaceTools,
	DEFAULT_SYSTEM_PROMPT,
	executeRung,
	type ModelRef,
	type ReasoningEffort,
} from "@dv-agent/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../packages/dv-eval/src/auth/file_credential_store.ts";
import { type LiveAuthMode, openLiveSession } from "../packages/dv-eval/src/auth/live_session.ts";
import { resolveAuthPath } from "../packages/dv-eval/src/auth/subscription.ts";
import { findPackageRoot } from "../packages/dv-eval/src/package_paths.ts";
import { loadApprovedProbes } from "../packages/dv-eval/src/probe/provider_probe.ts";
import { type LedgerMetrics, readLedgerMetrics } from "../packages/dv-eval/src/smoke/ledger_metrics.ts";
import { parseModelRef } from "../packages/dv-eval/src/smoke/runner.ts";
import {
	authMissingGuidance,
	catalogModels,
	catalogProviders,
	checkNpmUpdateNonBlocking,
	DEFAULT_MAX_COST_USD,
	DEFAULT_MAX_TOKENS,
	detectDefaultAuth,
	type DetectedAuth,
	defaultModelForProvider,
	formatModelRef,
	type InteractivePolicy,
	isValidCatalogModel,
	loadDvUserConfig,
	POLICIES,
	PROVIDER_DEFAULTS,
	promptLoginMenu,
	runSelfUpdate,
	saveDvUserConfig,
	type DvUserConfig,
} from "./interactive.ts";
import { findSlashCommand, formatHelp } from "./tui/commands.ts";
import { OSC52_MAX_CHARS } from "./tui/clipboard.ts";
import { createPlainIo, LineQueue, type ReplIO } from "./tui/io.ts";
import {
	type HeaderInfo,
	formatCostMode,
	renderHeader,
	renderStatusLine,
	type RenderStyle,
	type StatusInfo,
} from "./tui/render.ts";
import { TerminalUI } from "./tui/terminal.ts";
import {
	type WorkspaceProfile,
	detectWorkspaceProfile,
	formatWorkspaceProfile,
} from "./tui/workspace_profile.ts";

export interface SessionTokens {
	calls: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** null quando alguma chamada não tem custo em USD (ex.: sessão de assinatura). */
	cost_usd: number | null;
}

export interface TurnRecord {
	index: number;
	prompt: string;
	reply: string;
	status: string;
	at: string;
}

export interface SessionState {
	id: string;
	/** Diretório `.dv/runs/<id>`; null até o primeiro turno ou `/new`. */
	dir: string | null;
	createdAt: string;
	turns: TurnRecord[];
	summary: string;
	nextIndex: number;
	tokens: SessionTokens;
}

export interface ReplState {
	readonly cwd: string;
	readonly version: string;
	readonly env: NodeJS.ProcessEnv;
	readonly homeDir: string;
	readonly authPath: string;
	modelRef: ModelRef | undefined;
	authMode: LiveAuthMode;
	policy: InteractivePolicy;
	maxTokens: number;
	session: SessionState;
	branch: string | null;
	busy: boolean;
	cancelRequested: boolean;
	updateNotice: string | null;
	/** Limiar (estimativa de tokens do histórico) da compactação automática; 0 desativa. */
	autoCompactTokens: number;
	/** Tipo de projeto detectado localmente em `cwd` no início da sessão. */
	workspace: WorkspaceProfile;
}

const SESSION_SCHEMA = "dv-cli-session-v1";
const EFFORT_LEVELS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const POLICY_HINTS: Readonly<Record<InteractivePolicy, string>> = {
	ladder: "escada de modelos (padrão)",
	single: "um único modelo",
	"predictive-harness-router": "roteamento preditivo do harness",
	"architect-editor": "papéis arquiteto/editor",
};
const CONTEXT_TURNS = 4;
const CONTEXT_CHARS = 24_000;
const SUMMARY_CHARS = 3_000;
const DEFAULT_AUTO_COMPACT_TOKENS = 6_000;
const AUTO_COMPACT_ENV = "DV_AUTO_COMPACT_TOKENS";
const SHELL_TIMEOUT_MS = 300_000;
const MAX_LISTED_LINES = 60;

type Turn = { readonly index: number; readonly prompt: string; readonly reply: string; readonly status: string };

function say(io: ReplIO, text: string): void {
	io.print(text.endsWith("\n") ? text : `${text}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clipText(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function emptyTokens(): SessionTokens {
	return {
		calls: 0,
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		cost_usd: 0,
	};
}

function newSession(): SessionState {
	return {
		id: new Date().toISOString().replace(/[:.]/g, "-"),
		dir: null,
		createdAt: new Date().toISOString(),
		turns: [],
		summary: "",
		nextIndex: 1,
		tokens: emptyTokens(),
	};
}

function accumulateTokens(total: SessionTokens, metrics: LedgerMetrics): void {
	total.calls += metrics.calls;
	total.prompt_tokens += metrics.prompt_tokens;
	total.completion_tokens += metrics.completion_tokens;
	total.total_tokens += metrics.total_tokens;
	total.cache_read_tokens += metrics.cache_read_tokens;
	total.cache_write_tokens += metrics.cache_write_tokens;
	if (metrics.cost_usd === null) total.cost_usd = null;
	else if (total.cost_usd !== null) total.cost_usd += metrics.cost_usd;
}

function runsDir(cwd: string): string {
	return join(cwd, ".dv", "runs");
}

function ensureSessionDir(state: ReplState): string {
	if (state.session.dir === null) {
		const dir = join(runsDir(state.cwd), state.session.id);
		mkdirSync(dir, { recursive: true });
		state.session.dir = dir;
	}
	return state.session.dir;
}

function persistSession(state: ReplState): void {
	const dir = ensureSessionDir(state);
	const s = state.session;
	const payload = {
		schema: SESSION_SCHEMA,
		id: s.id,
		cwd: state.cwd,
		createdAt: s.createdAt,
		updatedAt: new Date().toISOString(),
		nextIndex: s.nextIndex,
		summary: s.summary,
		turns: s.turns,
		tokens: s.tokens,
	};
	writeFileSync(join(dir, "session.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function safePersist(state: ReplState, io: ReplIO): void {
	try {
		persistSession(state);
	} catch (error) {
		say(io, `[aviso] não foi possível salvar a sessão: ${errorMessage(error)}`);
	}
}

function readSessionFile(path: string): SessionState {
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	if (raw.schema !== SESSION_SCHEMA || typeof raw.id !== "string") {
		throw new Error(`arquivo de sessão inválido: ${path}`);
	}
	return {
		id: raw.id,
		dir: dirname(path),
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
		turns: Array.isArray(raw.turns) ? (raw.turns as TurnRecord[]) : [],
		summary: typeof raw.summary === "string" ? raw.summary : "",
		nextIndex: typeof raw.nextIndex === "number" ? raw.nextIndex : 1,
		tokens: { ...emptyTokens(), ...((raw.tokens as Partial<SessionTokens> | undefined) ?? {}) },
	};
}

interface SessionListing {
	readonly dir: string;
	readonly createdAt: string;
	readonly turns: readonly TurnRecord[];
}

function listSessions(cwd: string): SessionListing[] {
	const root = runsDir(cwd);
	if (!existsSync(root)) return [];
	const found: SessionListing[] = [];
	for (const name of readdirSync(root)) {
		const file = join(root, name, "session.json");
		if (!existsSync(file)) continue;
		try {
			const session = readSessionFile(file);
			found.push({ dir: dirname(file), createdAt: session.createdAt, turns: session.turns });
		} catch {
			// Sessão corrompida ou de outra versão: ignorada na listagem.
		}
	}
	return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Mantém as últimas linhas inteiras que caibam em `max` caracteres (nunca corta uma linha no meio). */
function keepTail(text: string, max: number): string {
	if (text.length <= max) return text;
	const lines = text.split("\n");
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i] ?? "";
		if (size + line.length + 1 > max) break;
		kept.unshift(line);
		size += line.length + 1;
	}
	return kept.length > 0 ? kept.join("\n") : text.slice(-max);
}

/**
 * Monta o prompt enviado ao modelo: contexto do workspace (uma linha, detectada localmente), resumo compactado e
 * turnos recentes antes da nova solicitação.
 */
export function buildTurnPrompt(
	session: Pick<SessionState, "summary" | "turns">,
	prompt: string,
	workspaceLine = "",
): string {
	const recent = session.turns
		.slice(-CONTEXT_TURNS)
		.map((t) => `Usuário: ${clipText(t.prompt, 1_500)}\nAgente: ${clipText(t.reply, 2_000)}`)
		.join("\n\n");
	const history = [
		session.summary === "" ? "" : `Resumo da conversa anterior:\n${session.summary}`,
		recent === "" ? "" : `Turnos recentes:\n${recent}`,
	]
		.filter((part) => part !== "")
		.join("\n\n");
	const head = workspaceLine === "" ? "" : `Contexto do workspace (detectado localmente): ${workspaceLine}`;
	const context = [head, history === "" ? "" : keepTail(history, CONTEXT_CHARS)].filter((p) => p !== "").join("\n\n");
	if (context === "") return prompt;
	return `${context}\n\nNova solicitação:\n${prompt}`;
}

/** Estimativa barata (≈4 caracteres por token) do histórico guardado: resumo + turnos. Sem chamada ao modelo. */
export function historyTokens(session: Pick<SessionState, "summary" | "turns">): number {
	let chars = session.summary.length;
	for (const t of session.turns) chars += t.prompt.length + t.reply.length;
	return Math.ceil(chars / 4);
}

/** Resume os turnos antigos em texto (sem chamada ao modelo) e mantém só o último integralmente. Devolve quantos foram resumidos. */
export function compactSession(session: SessionState): number {
	if (session.turns.length <= 1) return 0;
	const old = session.turns.slice(0, -1);
	const lines = old.map((t) => `- #${t.index} ${clipText(t.prompt, 160)} → ${clipText(t.reply || t.status, 240)}`);
	const merged = [session.summary, ...lines].filter((line) => line !== "").join("\n");
	session.summary = keepTail(merged, SUMMARY_CHARS);
	session.turns = session.turns.slice(-1);
	return old.length;
}

/** Compacta sozinha quando o histórico estimado atinge `limitTokens` (0 desativa). Preserva o turno mais recente. */
export function autoCompactSession(session: SessionState, limitTokens: number): number {
	if (limitTokens <= 0 || session.turns.length <= 1) return 0;
	if (historyTokens(session) < limitTokens) return 0;
	return compactSession(session);
}

/** Lê `DV_AUTO_COMPACT_TOKENS` (inteiro ≥0; 0 desativa). Valor inválido cai no padrão. */
export function readAutoCompactTokens(env: NodeJS.ProcessEnv): number {
	const raw = env[AUTO_COMPACT_ENV]?.trim() ?? "";
	return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_AUTO_COMPACT_TOKENS;
}

function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
	const result = spawnSync("git", [...args], { cwd, encoding: "utf8", timeout: 15_000 });
	return { ok: result.status === 0, out: result.stdout ?? "" };
}

function readBranch(cwd: string): string | null {
	const result = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = result.out.trim();
	return result.ok && branch !== "" ? branch : null;
}

function commandExists(command: string): boolean {
	const locator = process.platform === "win32" ? "where" : "which";
	return spawnSync(locator, [command], { encoding: "utf8" }).status === 0;
}

function runtimeVersion(): string {
	try {
		const root = findPackageRoot(import.meta.dirname);
		const pkg = JSON.parse(
			readFileSync(join(root, "packages", "runtime-pi", "pi-ai", "package.json"), "utf8"),
		) as { version?: string };
		return pkg.version ?? "desconhecida";
	} catch {
		return "desconhecida";
	}
}

function nodeAtLeast(version: string, minimum: readonly number[]): boolean {
	const current = version.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < minimum.length; i += 1) {
		const have = current[i] ?? 0;
		const need = minimum[i] ?? 0;
		if (have !== need) return have > need;
	}
	return true;
}

function isEffort(value: string): value is ReasoningEffort {
	return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isPolicy(value: string): value is InteractivePolicy {
	return (POLICIES as readonly string[]).includes(value);
}

function describeAuth(provider: string, authMode: LiveAuthMode): string {
	const tier = PROVIDER_DEFAULTS.find((c) => c.provider === provider)?.tier;
	const mode = authMode === "subscription" ? "assinatura" : "api-key";
	return [mode, provider, tier].filter((part) => part !== undefined).join(" · ");
}

async function storedProviders(authPath: string): Promise<readonly { providerId: string; type: string }[]> {
	try {
		return await new FileCredentialStore(authPath).list();
	} catch {
		return [];
	}
}

async function authForProvider(state: ReplState, provider: string): Promise<LiveAuthMode | null> {
	if (provider === AGY_PROVIDER) return "subscription";
	const match = (await storedProviders(state.authPath)).find((item) => item.providerId === provider);
	if (match !== undefined) return match.type === "oauth" ? "subscription" : "api-key";
	const envVar = PROVIDER_DEFAULTS.find((c) => c.provider === provider)?.envVar;
	if (envVar !== undefined && state.env[envVar]?.trim()) return "api-key";
	return null;
}

function applyAuth(state: ReplState, provider: string, modelId: string, authMode: LiveAuthMode): void {
	const effort = state.modelRef?.reasoningEffort;
	state.modelRef = { provider, modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
	state.authMode = authMode;
}

function viewWidth(): number {
	return Math.max(40, process.stdout.columns ?? 80);
}

function viewStyle(): RenderStyle {
	return { color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined };
}

function headerInfo(state: ReplState): HeaderInfo {
	const notice =
		state.updateNotice !== null
			? `Atualização disponível: ${state.updateNotice} — /update`
			: state.modelRef === undefined
				? "Sem modelo ativo — use /login"
				: null;
	return { version: state.version, cwd: state.cwd, homeDir: state.homeDir, notice };
}

function statusText(state: ReplState): string {
	const ref = state.modelRef;
	const t = state.session.tokens;
	const info: StatusInfo = {
		cwd: state.cwd,
		branch: state.branch,
		model: ref === undefined ? "" : `${ref.provider}/${ref.modelId}`,
		effort: ref?.reasoningEffort ?? "padrão",
		usage: { input: t.prompt_tokens, output: t.completion_tokens, total: t.total_tokens },
		cost: formatCostMode(t.cost_usd, state.authMode === "subscription"),
	};
	return renderStatusLine(info, viewWidth());
}

function printHeader(state: ReplState, io: ReplIO): void {
	const lines = renderHeader(headerInfo(state), viewWidth(), viewStyle());
	say(io, lines.join("\n"));
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

function loadProbes(): ReadonlySet<string> {
	const probesDir = join(findPackageRoot(import.meta.dirname), "packages", "dv-eval", "probe-results");
	return existsSync(probesDir) ? loadApprovedProbes(probesDir) : new Set<string>();
}

/** Executa um turno do agente. Devolve 0 se completou, 1 caso contrário. */
async function runTurn(state: ReplState, io: ReplIO, prompt: string): Promise<number> {
	const ref = state.modelRef;
	if (ref === undefined) {
		say(io, authMissingGuidance(state.authPath));
		return 1;
	}
	if (!isValidCatalogModel(ref.provider, ref.modelId)) {
		say(io, `modelo inválido no catálogo: ${formatModelRef(ref)}. Use /model.`);
		return 1;
	}
	const session = state.session;
	const index = session.nextIndex;
	session.nextIndex += 1;
	const beforeTokens = historyTokens(session);
	const autoCompacted = autoCompactSession(session, state.autoCompactTokens);
	if (autoCompacted > 0) {
		say(
			io,
			`[dv] compactação automática: ${autoCompacted} turno(s) resumidos (histórico ≈${beforeTokens} → ≈${historyTokens(session)} tokens).`,
		);
		safePersist(state, io);
	}
	const modelPrompt = buildTurnPrompt(session, prompt, formatWorkspaceProfile(state.workspace));
	const dir = ensureSessionDir(state);
	const ledgerPath = join(dir, `turn-${index}.ledger.jsonl`);

	state.busy = true;
	state.cancelRequested = false;
	io.watchInterrupt(() => {
		if (state.cancelRequested) return;
		state.cancelRequested = true;
		say(io, "[dv] cancelando: o turno para antes da próxima chamada ao modelo.");
	});
	say(io, `[dv] ${formatModelRef(ref)} · ${state.policy} · turno ${index}…`);

	let status = "error";
	let reply = "";
	let code = 1;
	try {
		const live = await openLiveSession({
			authMode: state.authMode,
			provider: ref.provider,
			modelId: ref.modelId,
			authPath: state.authPath,
			workspaceRoot: state.cwd,
		});
		const streamFn: typeof live.streamFn = (m, c, o) => {
			if (state.cancelRequested) throw new Error("turno cancelado pelo usuário");
			return live.streamFn(m, c, o);
		};
		const result = await executeRung({
			ledgerPath,
			runId: `dv-cli-${index}`,
			harnessVariant: `dv-interactive:${state.policy}`,
			referenceProvenance: { workspace: state.cwd },
			datasetSha256: "interactive",
			taskDefinitionSha256: "interactive",
			model: live.model,
			systemPrompt: DEFAULT_SYSTEM_PROMPT,
			tools: createWorkspaceTools({ workspaceRoot: state.cwd }),
			prompt: modelPrompt,
			streamFn,
			priceBook: live.priceBook,
			maxCostUsd: state.authMode === "subscription" ? 0 : DEFAULT_MAX_COST_USD,
			maxTotalTokens: state.maxTokens,
			doomLoopMaxIdenticalConsecutive: 3,
			approvedProbes: loadProbes(),
			contractId: ref.provider === AGY_PROVIDER ? CONTRACT_V5_ID : CONTRACT_ID,
			...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
		});
		status = result.status;
		reply = extractAssistantText(result.messages);
		code = status === "completed" ? 0 : 1;
		try {
			accumulateTokens(session.tokens, readLedgerMetrics(ledgerPath));
		} catch {
			// Ledger ausente (falha antes da primeira chamada): sem tokens a somar.
		}
	} catch (error) {
		reply = `[erro] ${errorMessage(error)}`;
	} finally {
		state.busy = false;
		io.watchInterrupt(null);
	}

	if (reply !== "") say(io, reply);
	if (status !== "completed") say(io, `[dv] turno encerrado com status=${status}`);
	session.turns.push({ index, prompt, reply, status, at: new Date().toISOString() });
	safePersist(state, io);
	return code;
}

function runShell(state: ReplState, io: ReplIO, command: string): void {
	if (command === "") {
		say(io, "Uso: !<comando>, ex.: !git status (não usa tokens do modelo)");
		return;
	}
	const result = spawnSync(command, {
		cwd: state.cwd,
		shell: true,
		encoding: "utf8",
		timeout: SHELL_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
	});
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\s+$/, "");
	say(io, text === "" ? "(sem saída)" : text);
	if (result.error !== undefined) say(io, `[erro] ${result.error.message}`);
	else if (result.status !== 0) say(io, `[saída ${result.status ?? "sinal"}]`);
	state.branch = readBranch(state.cwd);
}

async function runLoginFlow(state: ReplState, io: ReplIO): Promise<void> {
	try {
		const logged = await promptLoginMenu({
			ask: (question) => io.ask(question),
			write: (text) => io.print(text),
			authPath: state.authPath,
			homeDir: state.homeDir,
			env: state.env,
			...(io.tty ? { select: (title: string, labels: readonly string[]) => io.select(title, labels) } : {}),
		});
		if (logged !== null) applyAuth(state, logged.provider, logged.modelId, logged.authMode);
	} catch (error) {
		say(io, errorMessage(error));
	}
}

async function logoutCommand(state: ReplState, io: ReplIO, args: string): Promise<void> {
	const provider = args === "" ? state.modelRef?.provider : args;
	if (provider === undefined) {
		say(io, "Informe o provedor: /logout <provedor>");
		return;
	}
	const stored = await storedProviders(state.authPath);
	if (!stored.some((item) => item.providerId === provider)) {
		say(io, `Nenhuma credencial salva para ${provider} em ${state.authPath}.`);
		return;
	}
	await new FileCredentialStore(state.authPath).delete(provider);
	say(io, `Credencial de ${provider} removida.`);
	if (state.modelRef?.provider !== provider) return;
	const fallback: DetectedAuth | null = await detectDefaultAuth(state.env);
	if (fallback !== null) {
		applyAuth(state, fallback.provider, fallback.modelId, fallback.authMode);
		say(io, `Modelo ativo: ${fallback.provider}/${fallback.modelId}.`);
	} else {
		state.modelRef = undefined;
		say(io, "Nenhuma outra credencial disponível. Use /login.");
	}
}

async function authCommand(state: ReplState, io: ReplIO): Promise<void> {
	const stored = await storedProviders(state.authPath);
	const envSet = PROVIDER_DEFAULTS.filter((c) => c.envVar !== undefined && state.env[c.envVar]?.trim());
	const ref = state.modelRef;
	const lines = [
		`Arquivo de credenciais: ${state.authPath} (${existsSync(state.authPath) ? "existe" : "não existe"})`,
		"Provedores salvos:",
		...(stored.length === 0
			? ["  (nenhum)"]
			: stored.map((item) => `  - ${item.providerId}: ${item.type === "oauth" ? "assinatura (oauth)" : "api-key"}`)),
		"Variáveis de ambiente (apenas nomes; valores ocultos):",
		...(envSet.length === 0 ? ["  (nenhuma)"] : envSet.map((c) => `  - ${c.envVar}`)),
		`Modelo ativo: ${ref === undefined ? "nenhum" : `${formatModelRef(ref)} · ${describeAuth(ref.provider, state.authMode)}`}`,
	];
	say(io, lines.join("\n"));
}

async function setModel(state: ReplState, io: ReplIO, candidate: ModelRef): Promise<void> {
	const effort = candidate.reasoningEffort ?? state.modelRef?.reasoningEffort;
	const next: ModelRef = {
		provider: candidate.provider,
		modelId: candidate.modelId,
		...(effort === undefined ? {} : { reasoningEffort: effort }),
	};
	state.modelRef = next;
	const mode = await authForProvider(state, next.provider);
	if (mode !== null) state.authMode = mode;
	saveDvUserConfig({ model: formatModelRef(next) }, state.homeDir);
	const auth = mode === null ? "sem credencial — use /login" : describeAuth(next.provider, mode);
	say(io, `Modelo: ${formatModelRef(next)} (${auth})`);
}

async function modelCommand(state: ReplState, io: ReplIO, args: string): Promise<void> {
	if (args !== "") {
		let candidate: ModelRef;
		try {
			candidate = parseModelRef(args);
		} catch (error) {
			say(io, errorMessage(error));
			return;
		}
		if (!isValidCatalogModel(candidate.provider, candidate.modelId)) {
			say(io, `Modelo ausente no catálogo: ${candidate.provider}/${candidate.modelId}`);
			return;
		}
		await setModel(state, io, candidate);
		return;
	}
	const providers = catalogProviders();
	const currentProvider = state.modelRef?.provider ?? "";
	const providerIndex = await io.select("Provedor", providers, Math.max(0, providers.indexOf(currentProvider)));
	if (providerIndex === null) return;
	const provider = providers[providerIndex] ?? "";
	const models = catalogModels(provider);
	if (models.length === 0) {
		say(io, `Nenhum modelo disponível para ${provider}.`);
		return;
	}
	const currentModel = provider === currentProvider ? (state.modelRef?.modelId ?? "") : "";
	const modelIndex = await io.select(`Modelo (${provider})`, models, Math.max(0, models.indexOf(currentModel)));
	if (modelIndex === null) return;
	await setModel(state, io, { provider, modelId: models[modelIndex] ?? "" });
}

async function effortCommand(state: ReplState, io: ReplIO, args: string): Promise<void> {
	const ref = state.modelRef;
	if (ref === undefined) {
		say(io, "Defina um modelo antes (/model ou /login).");
		return;
	}
	let level = args.toLowerCase();
	if (level === "") {
		const current = EFFORT_LEVELS.indexOf(ref.reasoningEffort ?? "medium");
		const index = await io.select("Nível de raciocínio", EFFORT_LEVELS, Math.max(0, current));
		if (index === null) return;
		level = EFFORT_LEVELS[index] ?? "";
	}
	if (!isEffort(level)) {
		say(io, `Nível inválido: ${level}. Use low | medium | high | xhigh.`);
		return;
	}
	state.modelRef = { ...ref, reasoningEffort: level };
	saveDvUserConfig({ model: formatModelRef(state.modelRef) }, state.homeDir);
	say(io, `Esforço de raciocínio: ${level}`);
}

async function policyCommand(state: ReplState, io: ReplIO, args: string): Promise<void> {
	let name = args;
	if (name === "") {
		const labels = POLICIES.map((p) => `${p} — ${POLICY_HINTS[p]}`);
		const index = await io.select("Política", labels, Math.max(0, POLICIES.indexOf(state.policy)));
		if (index === null) return;
		name = POLICIES[index] ?? "";
	}
	if (!isPolicy(name)) {
		say(io, `Política inválida. Use: ${POLICIES.join(" | ")}`);
		return;
	}
	state.policy = name;
	saveDvUserConfig({ policy: name }, state.homeDir);
	say(io, `Política: ${name}. Ela é registrada no ledger; o REPL não aplica roteamento automático.`);
}

function budgetCommand(state: ReplState, io: ReplIO, args: string): void {
	if (args === "") {
		say(io, `Orçamento: ${state.maxTokens} tokens · sessão usou ${state.session.tokens.total_tokens}`);
		return;
	}
	const match = /^(\d+)([km]?)$/.exec(args.replace(/_/g, "").toLowerCase());
	if (match === null) {
		say(io, "Uso: /budget <tokens>, ex.: /budget 150000 ou /budget 150k");
		return;
	}
	const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
	const value = Number(match[1]) * multiplier;
	if (value <= 0) {
		say(io, "O orçamento precisa ser maior que zero.");
		return;
	}
	state.maxTokens = value;
	saveDvUserConfig({ maxTokens: value }, state.homeDir);
	say(io, `Orçamento definido: ${value} tokens`);
}

function tokensCommand(state: ReplState, io: ReplIO): void {
	const t = state.session.tokens;
	const cost = formatCostMode(t.cost_usd, state.authMode === "subscription");
	const auto = state.autoCompactTokens === 0 ? "desativada" : `≥${state.autoCompactTokens} tokens de histórico`;
	say(
		io,
		[
			`Sessão ${state.session.id}: ${state.session.turns.length} turno(s)`,
			`  chamadas: ${t.calls}`,
			`  entrada: ${t.prompt_tokens} · saída: ${t.completion_tokens} · total: ${t.total_tokens}`,
			`  cache leitura: ${t.cache_read_tokens} · cache escrita: ${t.cache_write_tokens}`,
			`  custo: ${cost}`,
			`  orçamento: ${state.maxTokens} tokens`,
			`  histórico atual: ≈${historyTokens(state.session)} tokens · compactação automática: ${auto}`,
		].join("\n"),
	);
}

function statusCommand(state: ReplState, io: ReplIO): void {
	state.branch = readBranch(state.cwd);
	const ref = state.modelRef;
	const lastTurn = state.session.turns[state.session.turns.length - 1];
	const ledger =
		lastTurn === undefined || state.session.dir === null
			? "(nenhum turno ainda)"
			: join(state.session.dir, `turn-${lastTurn.index}.ledger.jsonl`);
	say(
		io,
		[
			`Workspace: ${state.cwd}`,
			`Branch: ${state.branch ?? "(sem git)"}`,
			`Modelo: ${ref === undefined ? "nenhum" : `${formatModelRef(ref)} · ${describeAuth(ref.provider, state.authMode)}`}`,
			`Política: ${state.policy} · orçamento: ${state.maxTokens} tokens`,
			`Sessão: ${state.session.id} (${state.session.turns.length} turno(s))`,
			`Stack: ${formatWorkspaceProfile(state.workspace)}`,
			`Ledger atual: ${ledger}`,
		].join("\n"),
	);
}

function filesCommand(state: ReplState, io: ReplIO): void {
	const result = git(state.cwd, ["status", "--porcelain"]);
	if (!result.ok) {
		say(io, "Workspace não é um repositório git; nada a listar.");
		return;
	}
	const lines = result.out.split("\n").filter((line) => line !== "");
	if (lines.length === 0) {
		say(io, "Nenhum arquivo modificado ou novo.");
		return;
	}
	const shown = lines.slice(0, MAX_LISTED_LINES);
	const more = lines.length > MAX_LISTED_LINES ? `\n… +${lines.length - MAX_LISTED_LINES} arquivo(s)` : "";
	say(io, `${shown.join("\n")}${more}`);
}

function diffCommand(state: ReplState, io: ReplIO): void {
	const result = git(state.cwd, ["diff", "--stat"]);
	if (!result.ok) {
		say(io, "Workspace não é um repositório git; sem diff.");
		return;
	}
	const text = result.out.trimEnd();
	say(io, text === "" ? "Sem alterações rastreadas (git diff --stat vazio)." : text);
}

function compactCommand(state: ReplState, io: ReplIO): void {
	const before = historyTokens(state.session);
	const compacted = compactSession(state.session);
	if (compacted === 0) {
		say(io, "Nada a compactar: a sessão tem no máximo um turno.");
		return;
	}
	safePersist(state, io);
	say(
		io,
		`Compactados ${compacted} turno(s) em resumo; o último turno foi mantido integralmente (histórico ≈${before} → ≈${historyTokens(state.session)} tokens).`,
	);
}

/** Copia a última resposta do agente por OSC 52. Sem terminal interativo, não há o que copiar: aviso simples. */
function copyCommand(state: ReplState, io: ReplIO): void {
	const last = state.session.turns[state.session.turns.length - 1];
	if (last === undefined || last.reply === "") {
		say(io, "Nada para copiar: a sessão ainda não tem resposta do agente.");
		return;
	}
	const result = io.copyToClipboard(last.reply);
	if (!result.written) {
		say(io, "Cópia indisponível sem terminal interativo; a resposta está em /history ou no ledger.");
		return;
	}
	const note = result.truncated
		? `(truncada em ${OSC52_MAX_CHARS} caracteres)`
		: "(OSC 52; depende do terminal — use a seleção nativa se não colar)";
	say(io, `Resposta #${last.index} enviada à área de transferência ${note}.`);
}

function clearCommand(state: ReplState, io: ReplIO): void {
	state.session.turns = [];
	state.session.summary = "";
	io.clearScreen();
	printHeader(state, io);
	if (state.session.dir !== null) safePersist(state, io);
	say(io, "Histórico limpo; a sessão foi mantida.");
}

function newCommand(state: ReplState, io: ReplIO): void {
	state.session = newSession();
	safePersist(state, io);
	say(io, `Nova sessão ${state.session.id} em ${state.session.dir ?? ""}`);
}

async function resumeCommand(state: ReplState, io: ReplIO, args: string): Promise<void> {
	const sessions = listSessions(state.cwd);
	if (sessions.length === 0) {
		say(io, "Nenhuma sessão salva em .dv/runs/.");
		return;
	}
	const labels = sessions.map((s) => {
		const first = s.turns[0]?.prompt ?? "(sem turnos)";
		return `${s.createdAt.slice(0, 19).replace("T", " ")} · ${s.turns.length} turno(s) · ${clipText(first, 60)}`;
	});
	let index: number | null;
	if (args !== "") {
		const parsed = Number(args);
		index = Number.isInteger(parsed) && parsed >= 1 && parsed <= sessions.length ? parsed - 1 : null;
		if (index === null) {
			say(io, `Número inválido. Use de 1 a ${sessions.length}.`);
			return;
		}
	} else {
		index = await io.select("Sessões salvas (mais recente primeiro)", labels, 0);
		if (index === null) return;
	}
	const picked = sessions[index];
	if (picked === undefined) return;
	state.session = readSessionFile(join(picked.dir, "session.json"));
	say(io, `Sessão ${state.session.id} retomada: ${state.session.turns.length} turno(s).`);
}

function historyCommand(state: ReplState, io: ReplIO): void {
	const turns = state.session.turns;
	const lines = turns.map((t: TurnRecord) => `#${t.index} [${t.status}] ${clipText(t.prompt, 100)}`);
	if (lines.length === 0) lines.push("Nenhum turno nesta sessão.");
	if (state.session.summary !== "") lines.push(`(resumo compactado: ${state.session.summary.length} caracteres)`);
	say(io, lines.join("\n"));
}

async function configCommand(state: ReplState, io: ReplIO, args: string): Promise<void> {
	if (args === "") {
		const current: DvUserConfig = loadDvUserConfig(state.homeDir);
		say(
			io,
			[
				`Arquivo: ${join(state.homeDir, ".dv", "config.json")}`,
				JSON.stringify(current, null, 2),
				"Editar: /config set <model|policy|maxTokens|effort> <valor>",
			].join("\n"),
		);
		return;
	}
	const match = /^set\s+(\S+)\s+(.+)$/.exec(args);
	if (match === null) {
		say(io, "Uso: /config  ou  /config set <model|policy|maxTokens|effort> <valor>");
		return;
	}
	const key = match[1] ?? "";
	const value = (match[2] ?? "").trim();
	switch (key) {
		case "model":
			await modelCommand(state, io, value);
			return;
		case "policy":
			await policyCommand(state, io, value);
			return;
		case "maxTokens":
			budgetCommand(state, io, value);
			return;
		case "effort":
			await effortCommand(state, io, value);
			return;
		default:
			say(io, `Chave desconhecida: ${key}. Use model, policy, maxTokens ou effort.`);
	}
}

function doctorCommand(state: ReplState, io: ReplIO): void {
	type Check = { level: "ok" | "aviso" | "falha"; label: string; detail: string };
	const checks: Check[] = [];
	const nodeOk = nodeAtLeast(process.version, [22, 19, 0]);
	checks.push({
		level: nodeOk ? "ok" : "falha",
		label: "Node",
		detail: `${process.version}${nodeOk ? "" : " (requer >= 22.19.0)"}`,
	});
	const gitOk = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
	checks.push({ level: gitOk ? "ok" : "falha", label: "Git", detail: gitOk ? "disponível" : "não encontrado" });
	const agyOk = commandExists("agy");
	checks.push({
		level: agyOk ? "ok" : "aviso",
		label: "agy",
		detail: agyOk ? "disponível" : "não encontrado (necessário só para o provedor agy)",
	});
	const authExists = existsSync(state.authPath);
	checks.push({
		level: authExists ? "ok" : "aviso",
		label: "auth.json",
		detail: authExists ? state.authPath : `ausente em ${state.authPath}`,
	});
	const configPath = join(state.homeDir, ".dv", "config.json");
	let configLevel: Check["level"] = "ok";
	if (existsSync(configPath)) {
		try {
			JSON.parse(readFileSync(configPath, "utf8"));
		} catch {
			configLevel = "falha";
		}
	} else {
		configLevel = "aviso";
	}
	checks.push({ level: configLevel, label: "config", detail: configPath });
	const ref = state.modelRef;
	const modelValid = ref !== undefined && isValidCatalogModel(ref.provider, ref.modelId);
	checks.push({
		level: modelValid ? "ok" : "aviso",
		label: "catálogo",
		detail: ref === undefined ? "nenhum modelo ativo (use /login)" : `${formatModelRef(ref)} ${modelValid ? "válido" : "INVÁLIDO"}`,
	});
	const inRepo = git(state.cwd, ["rev-parse", "--is-inside-work-tree"]).ok;
	checks.push({ level: inRepo ? "ok" : "aviso", label: "workspace", detail: inRepo ? "repositório git" : "sem git" });
	say(io, checks.map((c) => `[${c.level}] ${c.label}: ${c.detail}`).join("\n"));
}

function updateCommand(state: ReplState, io: ReplIO): void {
	say(io, "Atualizando @engfinecode/dv-agent@latest via npm…");
	const code = io.suspend(() => runSelfUpdate());
	say(io, code === 0 ? "Atualização concluída. Reinicie o dv para usar a nova versão." : `npm terminou com código ${code}.`);
	state.branch = readBranch(state.cwd);
}

function versionCommand(state: ReplState, io: ReplIO): void {
	say(
		io,
		`dv-agent ${state.version} · runtime pi-ai ${runtimeVersion()} · node ${process.version} · contratos ${CONTRACT_ID} e ${CONTRACT_V5_ID}`,
	);
}

/** Despacha um comando `/...`. Devolve false quando a sessão deve encerrar. */
async function runCommand(state: ReplState, io: ReplIO, input: string): Promise<boolean> {
	const body = input.slice(1).trim();
	const space = body.search(/\s/);
	const rawName = space < 0 ? body : body.slice(0, space);
	const args = space < 0 ? "" : body.slice(space).trim();
	const cmd = findSlashCommand(rawName);
	if (cmd === undefined) {
		say(io, `Comando desconhecido: /${rawName}. Use / para o menu ou /help.`);
		return true;
	}
	switch (cmd.name) {
		case "help":
			say(io, formatHelp());
			return true;
		case "login":
			await runLoginFlow(state, io);
			return true;
		case "logout":
			await logoutCommand(state, io, args);
			return true;
		case "auth":
			await authCommand(state, io);
			return true;
		case "model":
			await modelCommand(state, io, args);
			return true;
		case "effort":
			await effortCommand(state, io, args);
			return true;
		case "policy":
			await policyCommand(state, io, args);
			return true;
		case "budget":
			budgetCommand(state, io, args);
			return true;
		case "tokens":
			tokensCommand(state, io);
			return true;
		case "status":
			statusCommand(state, io);
			return true;
		case "files":
			filesCommand(state, io);
			return true;
		case "diff":
			diffCommand(state, io);
			return true;
		case "compact":
			compactCommand(state, io);
			return true;
		case "copy":
			copyCommand(state, io);
			return true;
		case "clear":
			clearCommand(state, io);
			return true;
		case "new":
			newCommand(state, io);
			return true;
		case "resume":
			await resumeCommand(state, io, args);
			return true;
		case "history":
			historyCommand(state, io);
			return true;
		case "config":
			await configCommand(state, io, args);
			return true;
		case "doctor":
			doctorCommand(state, io);
			return true;
		case "update":
			updateCommand(state, io);
			return true;
		case "version":
			versionCommand(state, io);
			return true;
		case "exit":
			return false;
		default:
			return true;
	}
}

/** Trata uma linha submetida: `!` shell, `/` comando ou tarefa para o agente. Devolve false para encerrar. */
async function handleLine(state: ReplState, io: ReplIO, raw: string): Promise<boolean> {
	const text = raw.trim();
	if (text === "") return true;
	if (text.startsWith("!")) {
		runShell(state, io, text.slice(1).trim());
		return true;
	}
	if (text.startsWith("/")) return runCommand(state, io, text);
	await runTurn(state, io, text);
	return true;
}

function createState(options: {
	cwd: string;
	version: string;
	env: NodeJS.ProcessEnv;
	homeDir: string;
	userConfig: DvUserConfig;
	detected: DetectedAuth | null;
}): ReplState {
	const detected = options.detected;
	const configuredEffort = (() => {
		if (options.userConfig.model === undefined || detected === null) return undefined;
		try {
			const parsed = parseModelRef(options.userConfig.model);
			const same = parsed.provider === detected.provider && parsed.modelId === detected.modelId;
			return same ? parsed.reasoningEffort : undefined;
		} catch {
			return undefined;
		}
	})();
	const modelRef: ModelRef | undefined =
		detected === null
			? undefined
			: {
					provider: detected.provider,
					modelId: detected.modelId,
					...(configuredEffort === undefined ? {} : { reasoningEffort: configuredEffort }),
				};
	return {
		cwd: options.cwd,
		version: options.version,
		env: options.env,
		homeDir: options.homeDir,
		authPath: detected?.authPath ?? resolveAuthPath(options.env),
		modelRef,
		authMode: detected?.authMode ?? "api-key",
		policy: options.userConfig.policy ?? "ladder",
		maxTokens: options.userConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
		session: newSession(),
		branch: readBranch(options.cwd),
		busy: false,
		cancelRequested: false,
		updateNotice: null,
		autoCompactTokens: readAutoCompactTokens(options.env),
		workspace: detectWorkspaceProfile(options.cwd),
	};
}

export async function runInteractiveMode(options: {
	initialPrompt?: string;
	forceLogin?: boolean;
	currentVersion: string;
}): Promise<number> {
	const env = process.env;
	const homeDir = homedir();
	const userConfig = loadDvUserConfig(homeDir);
	const detected = await detectDefaultAuth(env, userConfig.model);
	const state = createState({
		cwd: process.cwd(),
		version: options.currentVersion,
		env,
		homeDir,
		userConfig,
		detected,
	});
	const updatePromise =
		env.DV_NO_UPDATE_CHECK === "1" ? Promise.resolve(null) : checkNpmUpdateNonBlocking(options.currentVersion);

	if (options.initialPrompt !== undefined && options.initialPrompt.trim() !== "") {
		if (state.modelRef === undefined) {
			console.error(authMissingGuidance(state.authPath));
			return 1;
		}
		const single = createPlainIo(null, process.stdout);
		const code = await runTurn(state, single, options.initialPrompt);
		const latest = await updatePromise;
		if (latest !== null) {
			console.error(`[dv] nova versão disponível (${latest}); execute "dv update" para atualizar.`);
		}
		return code;
	}

	const useTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
	let io: ReplIO;
	if (useTty) {
		io = new TerminalUI(process.stdin, process.stdout);
	} else {
		const rl = createInterface({ input: process.stdin, terminal: false });
		io = createPlainIo(new LineQueue(rl), process.stdout, () => rl.close());
	}

	io.start();
	try {
		printHeader(state, io);
		if (state.modelRef === undefined) {
			say(io, io.tty ? "Nenhuma credencial encontrada. Escolha como autenticar:" : authMissingGuidance(state.authPath));
		}
		if (options.forceLogin === true || (state.modelRef === undefined && io.tty)) {
			await runLoginFlow(state, io);
		}

		void updatePromise.then((latest) => {
			if (latest === null) return;
			state.updateNotice = latest;
			say(io, `[dv] nova versão disponível (${latest}); execute "dv update" para atualizar.`);
		});

		for (;;) {
			const result = await io.readLine(statusText(state));
			if (result.kind === "eof" || result.kind === "interrupt") break;
			if (result.kind === "escape") continue;
			try {
				const keepGoing = await handleLine(state, io, result.text);
				if (!keepGoing) break;
			} catch (error) {
				say(io, errorMessage(error));
			}
		}
	} finally {
		io.stop();
	}
	return 0;
}
