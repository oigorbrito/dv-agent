// Probe de capacidade de provedor (GAP-6, contrato v4 regra b). Dois modos:
// - offline (padrão, sem rede): valida a forma do usage produzido pelo caminho real do pi-ai (provider faux, com
//   contabilidade de cache por sessionId) e a consistência da tabela de transporte. Resultado: OFFLINE_SHAPE_CHECKED.
//   Não promove nenhum provedor: forma de usage do faux não é comportamento de provedor real.
// - live (--live): chamadas reais controladas. Só VERIFIED aprova um provedor para execução (assertProviderCanRun).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGY_API, fauxRuntime, PI_TRANSPORT_CAPABILITIES, redactText, transportFor } from "@dv-agent/core";
import { type AssistantMessage, type Context, normalizeContext } from "@earendil-works/pi-ai";
import { type LiveAuthMode, openLiveSession } from "../auth/live_session.ts";

export const PROBE_SCHEMA = "dv-provider-probe-v1";

/** APIs conhecidas do pi-ai no commit fixado, mais o transporte de teste. Tabela de transporte deve usar só estes. */
// APIs do pi-ai mais a API do adaptador agy (dv-core/providers/agy, ACP sobre stdio, não é do pi-ai).
const KNOWN_APIS = new Set([
	AGY_API,
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"pi-messages",
	"faux",
]);

/** Violações de forma do usage de uma mensagem. Lista vazia = forma válida. */
export function checkUsageShape(message: AssistantMessage): string[] {
	const u = message.usage;
	const violations: string[] = [];
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		const value = u[field];
		if (!Number.isFinite(value) || value < 0) violations.push(`${field} inválido: ${value}`);
	}
	if (u.totalTokens !== u.input + u.output + u.cacheRead + u.cacheWrite) {
		violations.push("totalTokens diferente da soma dos componentes");
	}
	if (u.reasoning !== undefined && (!Number.isFinite(u.reasoning) || u.reasoning < 0 || u.reasoning > u.output)) {
		violations.push("reasoning fora de [0, output]: pi-ai define reasoning como subconjunto de output");
	}
	if (!Number.isFinite(u.cost.total) || u.cost.total < 0) violations.push("cost.total inválido");
	return violations;
}

/** Violações da tabela de transporte: api desconhecida, duplicada ou sem campos declarados. */
export function checkTransportTable(): string[] {
	const violations: string[] = [];
	const seen = new Set<string>();
	for (const row of PI_TRANSPORT_CAPABILITIES) {
		if (!KNOWN_APIS.has(row.api)) violations.push(`api desconhecida na tabela: ${row.api}`);
		if (seen.has(row.api)) violations.push(`api duplicada na tabela: ${row.api}`);
		seen.add(row.api);
		if (row.source.trim() === "") violations.push(`sem fonte declarada: ${row.api}`);
	}
	return violations;
}

export interface OfflineProbeResult {
	schema: typeof PROBE_SCHEMA;
	mode: "offline";
	status: "OFFLINE_SHAPE_CHECKED" | "OFFLINE_SHAPE_FAILED";
	scope: string;
	transport_table_violations: string[];
	usage_shape_violations: string[];
	cache_semantics: { first: AssistantMessage["usage"]; second: AssistantMessage["usage"]; violations: string[] };
	provider_statuses: "unchanged: PROVISIONAL até probe live VERIFIED";
}

/** Probe offline: pi-ai real com provider faux (sem shim de usage), duas chamadas com o mesmo sessionId. */
export async function runOfflineProbe(): Promise<OfflineProbeResult> {
	const runtime = fauxRuntime("probe-offline", ["probe-model"]);
	const model = runtime.modelOf("probe-model");
	const context: Context = {
		systemPrompt: "Contexto fixo de teste de cache. ".repeat(120),
		messages: [{ role: "user", content: "responda OK", timestamp: 0 }],
	};
	// O StreamFn recebe o TranscriptContext que o Agent produz com normalizeContext.
	const transcript = normalizeContext(context);
	const first = await (await runtime.streamFn(model, transcript, { sessionId: "dv-probe-offline" })).result();
	const second = await (await runtime.streamFn(model, transcript, { sessionId: "dv-probe-offline" })).result();
	const cacheViolations: string[] = [];
	const promptFirst = first.usage.input + first.usage.cacheRead + first.usage.cacheWrite;
	const promptSecond = second.usage.input + second.usage.cacheRead + second.usage.cacheWrite;
	if (second.usage.cacheRead <= 0) cacheViolations.push("segunda chamada sem cacheRead: cache não contabilizado");
	if (promptSecond < second.usage.cacheRead)
		cacheViolations.push("prompt_tokens menor que cacheRead (regra b, probe i)");
	if (Math.abs(promptSecond - promptFirst) > promptFirst * 0.05) {
		cacheViolations.push("prompt_tokens não estável entre chamadas com o mesmo prompt (regra b, probe ii)");
	}
	const usageViolations = [...checkUsageShape(first), ...checkUsageShape(second)];
	const transportViolations = checkTransportTable();
	const failed = transportViolations.length + usageViolations.length + cacheViolations.length > 0;
	return {
		schema: PROBE_SCHEMA,
		mode: "offline",
		status: failed ? "OFFLINE_SHAPE_FAILED" : "OFFLINE_SHAPE_CHECKED",
		scope: "transporte faux do pi-ai (sem rede); não é evidência de provedor real",
		transport_table_violations: transportViolations,
		usage_shape_violations: usageViolations,
		cache_semantics: { first: first.usage, second: second.usage, violations: cacheViolations },
		provider_statuses: "unchanged: PROVISIONAL até probe live VERIFIED",
	};
}

export interface LiveProbeResult {
	schema: typeof PROBE_SCHEMA;
	mode: "live";
	provider: string;
	model_id: string;
	api: string;
	/** Modo de autenticação usado. Nunca contém credencial. */
	auth_mode: LiveAuthMode;
	status: "VERIFIED" | "INCONCLUSIVE";
	reasons: string[];
	calls: { usage: AssistantMessage["usage"]; stop_reason: string; error?: string }[];
}

/**
 * Probe live: duas chamadas com o mesmo prefixo longo e sessionId. VERIFIED só se a segunda chamada reporta cache,
 * prompt_tokens é estável entre chamadas e cacheRead não passa do prompt. Requer credencial do provedor no ambiente.
 */
export async function runLiveProbe(options: {
	provider: string;
	modelId: string;
	authMode: LiveAuthMode;
	authPath: string;
}): Promise<LiveProbeResult> {
	const { provider, modelId } = options;
	const session = await openLiveSession(options);
	const model = session.model;
	const transport = transportFor(model.api);
	const systemPrompt = "Contexto fixo de verificação de cache DV. ".repeat(160);
	const context: Context = { systemPrompt, messages: [{ role: "user", content: "responda apenas OK", timestamp: 0 }] };
	const sessionId = `dv-probe-live-${Date.now()}`;
	const calls: LiveProbeResult["calls"] = [];
	const reasons: string[] = [];
	const messages: AssistantMessage[] = [];
	for (let i = 0; i < 2; i += 1) {
		const message = await (
			await session.streamFn(model, normalizeContext(context), { sessionId, maxTokens: 16 })
		).result();
		messages.push(message);
		const error = message.stopReason === "error" ? redactText(message.errorMessage ?? "erro sem mensagem") : undefined;
		calls.push({ usage: message.usage, stop_reason: message.stopReason, ...(error === undefined ? {} : { error }) });
		if (error !== undefined) reasons.push(`chamada ${i + 1} com erro do provedor`);
		for (const violation of checkUsageShape(message)) reasons.push(`chamada ${i + 1}: ${violation}`);
	}
	const [first, second] = messages;
	if (first !== undefined && second !== undefined) {
		const p1 = first.usage.input + first.usage.cacheRead + first.usage.cacheWrite;
		const p2 = second.usage.input + second.usage.cacheRead + second.usage.cacheWrite;
		if (transport?.cache_read_tokens === "exposed" && second.usage.cacheRead <= 0) {
			reasons.push("segunda chamada sem cacheRead: cache não ativado ou não exposto");
		}
		if (p2 < second.usage.cacheRead) reasons.push("prompt_tokens menor que cacheRead");
		if (Math.abs(p2 - p1) > p1 * 0.05) reasons.push("prompt_tokens não estável entre chamadas");
	}
	return {
		schema: PROBE_SCHEMA,
		mode: "live",
		provider,
		model_id: modelId,
		api: model.api,
		auth_mode: options.authMode,
		status: reasons.length === 0 ? "VERIFIED" : "INCONCLUSIVE",
		reasons,
		calls,
	};
}

/** Grava o resultado do probe. Um arquivo por provedor; sobrescreve o anterior. */
export function writeProbeResult(dir: string, name: string, result: OfflineProbeResult | LiveProbeResult): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.json`);
	writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	return path;
}

/** Provedores com probe live VERIFIED em dir. Entrada da regra de execução (assertProviderCanRun). */
export function loadApprovedProbes(dir: string): Set<string> {
	const approved = new Set<string>();
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return approved;
	}
	for (const file of files) {
		const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Partial<LiveProbeResult>;
		if (parsed.mode === "live" && parsed.status === "VERIFIED" && typeof parsed.provider === "string") {
			approved.add(parsed.provider);
		}
	}
	return approved;
}
