// Smoke runner end-to-end: uma tarefa calibrada, uma política (single | ladder | architect-editor), oráculo externo
// a cada degrau (workspace limpo por degrau) e artefatos em outdir.
// - offline-faux: provider faux com roteiros determinísticos (ver offline_scripts.ts). Não avalia modelo real.
// - api-key: provedor real via catálogo do pi-ai. Só executa se a regra de capacidade (contract v4, regra b) permitir.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	ArchitectEditorPolicy,
	type Attempt,
	assembleScaffold,
	type CeilingStatus,
	CONTRACT_V5_ID,
	classifyModelTier,
	type EmpiricalFailureIndex,
	ExecutionGuidedLadderPolicy,
	executeRung,
	extractPythonSignals,
	extractTaskFeatures,
	fauxRuntime,
	type ModelRef,
	PredictiveHarnessRouterPolicy,
	type PriceBook,
	REASONING_EFFORTS,
	type ReasoningEffort,
	type RouterDecision,
	type RouterPolicy,
	type ScaffoldMode,
	SingleModelPolicy,
	type SourceFile,
	scaffoldFingerprint,
} from "@dv-agent/core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { openLiveSession } from "../auth/live_session.ts";
import { resolveAuthPath } from "../auth/subscription.ts";
import { assertNoRoutingHistoryLeakage, loadRoutingHistory } from "../bench/routing_history.ts";
import { hashTree, loadTask, type OracleResult, runOracle } from "../oracle/verifier.ts";
import { findPackageRoot } from "../package_paths.ts";
import { loadApprovedProbes } from "../probe/provider_probe.ts";
import { readLedgerMetrics } from "./ledger_metrics.ts";
import { fixtureTurns } from "./offline_fixtures.ts";
import { offlineTurns } from "./offline_scripts.ts";

export type PolicyName = "single" | "ladder" | "architect-editor" | "predictive-harness-router";

/** Limites do papel editor (architect-editor): evita loops longos de ferramentas (auditoria: 12-13 turnos por run). */
export interface RoleLimits {
	maxTurns: number;
	maxOutputTokens: number;
}
/** Tetos do editor: 32 turnos (16 cortava a verificação final) e 32000 tokens de saída. */
export const EDITOR_LIMITS: RoleLimits = { maxTurns: 32, maxOutputTokens: 32000 };
/** Instrução de término do editor: evita chamadas extras de ferramenta depois dos testes passarem. */
export const EDITOR_FINISH_HINT =
	"Assim que os testes locais passarem, responda imediatamente sem chamar novas ferramentas.";

/** Repassa a temperatura ao stream. O adaptador só a envia quando o modelo suporta (compat.supportsTemperature). */
export function withTemperature(streamFn: StreamFn, temperature: number | undefined): StreamFn {
	if (temperature === undefined) return streamFn;
	return (model, context, options) => streamFn(model, context, { ...options, temperature });
}
export type AuthMode = "offline-faux" | "api-key" | "subscription";

export interface SmokeOptions {
	taskDir: string;
	policy: PolicyName;
	authMode: AuthMode;
	/** Modelo principal em api-key, formato provider/modelId. */
	model?: string;
	/** Caminho do auth.json para subscription. Padrão: resolveAuthPath() (DV_AUTH_FILE ou ~/.pi/agent/auth.json). */
	authPath?: string;
	/** Modelo do degrau 1 (ladder) ou do editor (architect-editor) em api-key. Opcional: sem ele, reusa --model. */
	escalationModel?: string;
	/** Lista ordenada de provider/modelId para todos os degraus da política ladder. */
	ladderModels?: readonly string[];
	/** Um ou mais summaries históricos dv-bench; exige --routing-history-partition calibration|train. */
	routingHistory?: readonly string[];
	routingHistoryPartition?: "calibration" | "train";
	outdir: string;
	maxCostUsd: number;
	/** Teto de tokens (prompt + completion) somado a todos os degraus. Opcional. */
	maxTokens?: number;
	/** Temperatura de amostragem (repassada ao provedor quando suportada). */
	temperature?: number;
	/** Limites do papel editor. Padrão: EDITOR_LIMITS. */
	editorLimits?: RoleLimits;
	probesDir: string;
	/** Modo de scaffold: uniform (padrão) ou adaptive. */
	scaffoldMode?: ScaffoldMode;
	/** Compactação intra-degrau por porte de modelo (opt-in; padrão off). Ver guards/compaction.ts. */
	compaction?: "off" | "by_model";
	/** Contrato do run. Padrão: v5 para provedor agy, v4 para os demais (executeRung). */
	contractId?: string;
}

export interface StepRecord {
	step: number;
	rung: number;
	role: string;
	/** Impressão digital do system prompt enviado neste degrau. */
	system_prompt_sha256: string;
	/** Impressão digital das ferramentas enviadas neste degrau (vazio no architect). */
	tools_sha256: string;
	model: string;
	reasoning_effort: string | null;
	/** Modelo real do degrau (provider/modelId pedido). Em offline, `model` é o roteiro faux. */
	requested_model: string;
	cap_usd: number;
	run_status: string;
	ceiling_status: CeilingStatus;
	spent_lower_bound_usd: number;
	ledger_path: string;
	ledger_sha256: string;
	telemetry_complete: boolean;
	total_tokens: number;
	oracle: { verdict: string; outcome: string; result_path: string } | null;
	verification: Attempt["verification"];
	plan_from_architect: boolean;
}

export interface SmokeSummary {
	schema: "dv-smoke-summary-v1";
	task_id: string;
	policy: PolicyName;
	scaffold_mode: ScaffoldMode;
	auth_mode: AuthMode;
	final_outcome: "solved" | "unsolved" | "inconclusive" | "budget_exhausted" | "blocked";
	blocked_reason?: string;
	steps: StepRecord[];
	reference_provenance: Record<string, string>;
	dataset_sha256: string;
	task_definition_sha256: string;
}

const OFFLINE_PROVIDER = "anthropic";
const OFFLINE_PRICE = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

const VALID_EFFORTS = new Set<string>(REASONING_EFFORTS);

/** Converte provider/modelId[:effort] da CLI em ModelRef. Formato inválido é erro de configuração. */
export function parseModelRef(text: string): ModelRef {
	const trimmed = text.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) throw new Error(`modelo deve ser provider/modelId: ${text}`);

	const colon = trimmed.lastIndexOf(":");
	if (colon > slash) {
		const candidate = trimmed.slice(colon + 1).toLowerCase();
		if (!VALID_EFFORTS.has(candidate)) {
			throw new Error(
				`effort inválido: "${trimmed.slice(colon + 1)}" em ${text} (deve ser low, medium, high ou xhigh)`,
			);
		}
		const modelPart = trimmed.slice(0, colon);
		const modelId = modelPart.slice(slash + 1);
		if (modelId.length === 0) throw new Error(`modelo deve ser provider/modelId: ${text}`);
		return {
			provider: modelPart.slice(0, slash),
			modelId,
			reasoningEffort: candidate as ReasoningEffort,
		};
	}

	const modelId = trimmed.slice(slash + 1);
	if (modelId.length === 0) throw new Error(`modelo deve ser provider/modelId: ${text}`);
	return { provider: trimmed.slice(0, slash), modelId };
}

const ANTHROPIC_LADDER_MODELS: Readonly<Record<string, string>> = {
	"haiku 5.5": "anthropic/claude-haiku-5-5",
	"fable 5.2": "anthropic/claude-fable-5-2",
	"sonnet 5.5": "anthropic/claude-sonnet-5-5",
	"opus 5.5": "anthropic/claude-opus-5-5",
};

export function parseLadderModel(text: string): ModelRef {
	const trimmed = text.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const prefix = trimmed.slice(0, colon).trim().toLowerCase();
		const effortCandidate = trimmed.slice(colon + 1).toLowerCase();
		if (ANTHROPIC_LADDER_MODELS[prefix] !== undefined) {
			if (!VALID_EFFORTS.has(effortCandidate)) {
				throw new Error(
					`effort inválido: "${trimmed.slice(colon + 1)}" em ${text} (deve ser low, medium, high ou xhigh)`,
				);
			}
			return parseModelRef(`${ANTHROPIC_LADDER_MODELS[prefix]}:${effortCandidate}`);
		}
	}
	const alias = ANTHROPIC_LADDER_MODELS[trimmed.toLowerCase()];
	return parseModelRef(alias ?? trimmed);
}

/** Política e modelos por papel. Em offline, o id do modelo escolhe o roteiro faux. */
export function buildPolicy(options: SmokeOptions, history?: EmpiricalFailureIndex): RouterPolicy {
	if (
		(options.policy === "ladder" || options.policy === "predictive-harness-router") &&
		options.ladderModels !== undefined
	) {
		const ladderModels = options.ladderModels;
		if (ladderModels.length === 0) throw new Error("--ladder-models requer ao menos um modelo");
		const parsed = ladderModels.map(parseLadderModel);
		const models =
			options.authMode === "offline-faux"
				? parsed.map((p, index) => ({
						provider: OFFLINE_PROVIDER,
						modelId: index === parsed.length - 1 ? "faux-strong" : "faux-cheap",
						tierModelId: p.modelId,
						...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
					}))
				: parsed;
		const rungs = models.map((model, index) => ({ model, costShareCap: (index + 1) / models.length }));
		if (options.policy === "predictive-harness-router") {
			return makePredictivePolicy(options, rungs, history);
		}
		return new ExecutionGuidedLadderPolicy({
			rungs,
			globalMaxCostUsd: options.maxCostUsd,
		});
	}
	const primary = resolveRef(options, "primary");
	const secondary = resolveRef(options, "secondary");
	if (options.policy === "single") return new SingleModelPolicy(primary, options.maxCostUsd);
	if (options.policy === "predictive-harness-router") {
		return makePredictivePolicy(
			options,
			[
				{ model: primary, costShareCap: 0.5 },
				{ model: secondary, costShareCap: 1 },
			],
			history,
		);
	}
	if (options.policy === "ladder") {
		return new ExecutionGuidedLadderPolicy({
			rungs: [
				{ model: primary, costShareCap: 0.5 },
				{ model: secondary, costShareCap: 1 },
			],
			globalMaxCostUsd: options.maxCostUsd,
		});
	}
	return new ArchitectEditorPolicy({
		architect: primary,
		editor: secondary,
		globalMaxCostUsd: options.maxCostUsd,
		maxEditorAttempts: 2,
	});
}

function collectInitialFiles(rootDir: string, relBase = ""): SourceFile[] {
	if (!existsSync(rootDir)) return [];
	const out: SourceFile[] = [];
	for (const name of readdirSync(rootDir).sort()) {
		const full = join(rootDir, name);
		const rel = relBase === "" ? name : `${relBase}/${name}`;
		const st = statSync(full);
		if (st.isDirectory()) out.push(...collectInitialFiles(full, rel));
		else if (st.isFile()) out.push({ path: rel, content: readFileSync(full, "utf8") });
	}
	return out;
}

function makePredictivePolicy(
	options: SmokeOptions,
	rungs: ConstructorParameters<typeof PredictiveHarnessRouterPolicy>[0]["rungs"],
	history?: EmpiricalFailureIndex,
): PredictiveHarnessRouterPolicy {
	const task = loadTask(options.taskDir);
	const definition = JSON.parse(readFileSync(join(options.taskDir, "task.json"), "utf8")) as { tier?: unknown };
	if (typeof definition.tier !== "string") throw new Error(`task ${task.id} sem categoria tier`);
	const wsFiles = collectInitialFiles(join(resolve(options.taskDir), task.workspace_dir));
	const signals = extractPythonSignals(wsFiles);
	const specText = [task.prompt, ...wsFiles.filter((f) => f.path.endsWith(".md")).map((f) => f.content)].join("\n");
	const taskFeatures = extractTaskFeatures(specText, wsFiles, signals);
	return new PredictiveHarnessRouterPolicy({
		rungs,
		globalMaxCostUsd: options.maxCostUsd,
		history,
		taskId: task.id,
		category: definition.tier,
		taskFeatures,
	});
}

/** Modelos faux por papel (roteiros em offline_scripts.ts). */
const OFFLINE_MODELS: Record<PolicyName, { primary: string; secondary: string }> = {
	single: { primary: "faux-cheap", secondary: "faux-cheap" },
	ladder: { primary: "faux-cheap", secondary: "faux-strong" },
	"architect-editor": { primary: "faux-architect", secondary: "faux-editor" },
	"predictive-harness-router": { primary: "faux-cheap", secondary: "faux-strong" },
};

function resolveRef(options: SmokeOptions, slot: "primary" | "secondary"): ModelRef {
	const text = slot === "primary" ? options.model : (options.escalationModel ?? options.model);
	if (options.authMode === "offline-faux") {
		if (text === undefined) return { provider: OFFLINE_PROVIDER, modelId: OFFLINE_MODELS[options.policy][slot] };
		// Offline com modelo explícito: o roteiro segue o porte real (single) e o scaffold usa o modelo pedido.
		const requested = parseModelRef(text);
		const script =
			options.policy === "single"
				? classifyModelTier(requested.modelId) === "frontier"
					? "faux-strong"
					: "faux-cheap"
				: OFFLINE_MODELS[options.policy][slot];
		return {
			provider: OFFLINE_PROVIDER,
			modelId: script,
			tierModelId: requested.modelId,
			...(requested.reasoningEffort !== undefined ? { reasoningEffort: requested.reasoningEffort } : {}),
		};
	}
	if (text === undefined) throw new Error("--model é obrigatório em api-key (provider/modelId)");
	return parseModelRef(text);
}

function gitCommit(root: string): string {
	try {
		return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

/** Contrato do degrau: o do resumo quando informado; senão v5 para agy e v4 (padrão) para os demais. */
function contractForRun(options: SmokeOptions, provider: string): string | undefined {
	return options.contractId ?? (provider === "agy" ? CONTRACT_V5_ID : undefined);
}

/** Executa a política até parar. Cada degrau: workspace limpo, run com ledger próprio e oráculo externo. */
export async function runSmoke(options: SmokeOptions): Promise<SmokeSummary> {
	const root = findPackageRoot(import.meta.dirname);
	const taskDir = resolve(options.taskDir);
	const task = loadTask(taskDir);
	let historyIndex: EmpiricalFailureIndex | undefined;
	if (options.routingHistory !== undefined) {
		if (options.policy !== "predictive-harness-router") {
			throw new Error("--routing-history só se aplica a --policy predictive-harness-router");
		}
		if (options.routingHistoryPartition === undefined) {
			throw new Error("--routing-history exige --routing-history-partition calibration|train");
		}
		historyIndex = loadRoutingHistory(options.routingHistory, {
			corpusDir: resolve(root, "packages/dv-eval/corpus"),
			partition: options.routingHistoryPartition,
		});
		assertNoRoutingHistoryLeakage(historyIndex, options.outdir);
	} else if (options.routingHistoryPartition !== undefined) {
		throw new Error("--routing-history-partition exige --routing-history");
	}
	const workspaceSrc = join(taskDir, task.workspace_dir);
	const expectedOracleHashes = hashTree(join(taskDir, task.oracle.dir));
	const policy = buildPolicy(options, historyIndex);
	const approved = loadApprovedProbes(options.probesDir);
	const pin = JSON.parse(readFileSync(join(root, "UPSTREAM_PIN.json"), "utf8")) as { upstream: { commit: string } };
	const provenance = { dv_agent_commit: gitCommit(root), pi_mono_commit: pin.upstream.commit };
	const datasetSha = createHash("sha256")
		.update(JSON.stringify(hashTree(workspaceSrc)))
		.digest("hex");
	const taskSha = createHash("sha256")
		.update(readFileSync(join(taskDir, "task.json")))
		.digest("hex");
	mkdirSync(options.outdir, { recursive: true });

	const attempts: Attempt[] = [];
	const steps: StepRecord[] = [];
	let tokensSpent = 0;
	let plan: string | undefined;
	let decision: RouterDecision = policy.decide(attempts);
	const context = { task, workspaceSrc, taskDir, provenance, datasetSha, taskSha, approved };
	while (decision.kind === "run") {
		if (options.maxTokens !== undefined && tokensSpent >= options.maxTokens) {
			return finish(options, context, steps, "budget_exhausted", "teto de tokens esgotado");
		}
		const step = attempts.length;
		const stepDir = join(options.outdir, `step-${step}-${decision.role}`);
		const workspace = mkdtempSync(join(tmpdir(), "dv-smoke-ws-"));
		let scaffoldFp: { system_prompt_sha256: string; tools_sha256: string } | undefined;
		// Workspace temporário é removido ao fim do degrau, inclusive em erro (sem órfãos em %TEMP%).
		try {
			cpSync(workspaceSrc, workspace, { recursive: true });
			const isArchitect = decision.role === "architect";
			const basePrompt = isArchitect
				? "Planeje a correção de calc.py conforme SPEC.md em até 5 linhas. Não edite arquivos."
				: plan === undefined
					? task.prompt
					: `${task.prompt}\n\nPlano do arquiteto:\n${plan}`;
			const prompt = decision.role === "editor" ? `${basePrompt}\n\n${EDITOR_FINISH_HINT}` : basePrompt;

			let run: Awaited<ReturnType<typeof executeRung>>;
			try {
				const engine = await prepareEngine(options, decision, workspace);
				const scaffold = assembleScaffold({
					workspaceRoot: workspace,
					modelId: decision.model.tierModelId ?? decision.model.modelId,
					scaffoldMode: options.scaffoldMode,
				});
				// Impressão digital do que é enviado de fato: o architect recebe tools vazias.
				scaffoldFp = scaffoldFingerprint(scaffold.systemPrompt, isArchitect ? [] : scaffold.tools);
				run = await executeRung({
					ledgerPath: join(stepDir, "ledger.jsonl"),
					runId: `smoke-${task.id}-${step}`,
					harnessVariant: `dv-smoke:${options.policy}:${options.authMode}`,
					compaction: options.compaction,
					referenceProvenance: { ...provenance, ...scaffoldFp },
					datasetSha256: datasetSha,
					taskDefinitionSha256: taskSha,
					model: engine.model,
					systemPrompt: scaffold.systemPrompt,
					tools: isArchitect ? [] : scaffold.tools,
					prompt,
					streamFn: withTemperature(engine.streamFn, options.temperature),
					priceBook: engine.priceBook,
					maxCostUsd: decision.cap_usd,
					reasoningEffort: decision.model.reasoningEffort,
					...(options.maxTokens === undefined ? {} : { maxTotalTokens: options.maxTokens - tokensSpent }),
					...(decision.role === "editor" ? (options.editorLimits ?? EDITOR_LIMITS) : {}),
					doomLoopMaxIdenticalConsecutive: 3,
					approvedProbes: approved,
					contractId: contractForRun(options, decision.model.provider),
					...(policy.name === "predictive_harness_router"
						? {
								routeDecision: {
									policy: policy.name,
									rung: decision.rung,
									role: decision.role,
									reason: decision.route_reason ?? "promoção por oráculo do degrau anterior",
									signals: null,
									empirical_evidence:
										policy instanceof PredictiveHarnessRouterPolicy ? policy.routeEvidence : undefined,
									...(policy instanceof PredictiveHarnessRouterPolicy && policy.knnEvidence !== undefined
										? {
												knn_evidence: {
													start_rung: policy.knnEvidence.startRung,
													reason_code: policy.knnEvidence.reasonCode,
													neighbors: policy.knnEvidence.neighbors.map((n) => ({
														task_id: n.taskId,
														similarity: n.similarity,
														failed_rung0: n.failedRung0,
													})),
													weighted_failure_rate: policy.knnEvidence.weightedFailureRate,
													weight_sum: policy.knnEvidence.weightSum,
													k: policy.knnEvidence.k,
													theta: policy.knnEvidence.theta,
												},
											}
										: {}),
								},
							}
						: {}),
				});
			} catch (error) {
				// Gate de capacidade (PROVISIONAL sem probe) ou erro de configuração: parada registrada, não falha silenciosa.
				return finish(options, context, steps, "blocked", (error as Error).message);
			}

			const metrics = readLedgerMetrics(run.ledgerPath);
			tokensSpent += metrics.total_tokens;
			if (isArchitect) plan = lastAssistantText(run.messages);
			const oracle: OracleResult | null = isArchitect
				? null
				: await runOracle({
						taskDir,
						candidateDir: workspace,
						outdir: stepDir,
						ledgerPath: run.ledgerPath,
						expectedOracleHashes,
					});
			const verification: Attempt["verification"] = oracle?.verification ?? null;
			attempts.push({
				rung: decision.rung,
				role: decision.role,
				model: decision.model,
				verification,
				spent_lower_bound_usd: run.spentLowerBoundUsd,
			});
			steps.push({
				step,
				rung: decision.rung,
				role: decision.role,
				system_prompt_sha256: scaffoldFp?.system_prompt_sha256 ?? "",
				tools_sha256: scaffoldFp?.tools_sha256 ?? "",
				model: `${decision.model.provider}/${decision.model.modelId}`,
				reasoning_effort: decision.model.reasoningEffort ?? null,
				requested_model: decision.model.tierModelId
					? `${decision.model.provider}/${decision.model.tierModelId}`
					: `${decision.model.provider}/${decision.model.modelId}`,
				cap_usd: decision.cap_usd,
				run_status: run.status,
				ceiling_status: run.ceilingStatus,
				spent_lower_bound_usd: run.spentLowerBoundUsd,
				ledger_path: run.ledgerPath,
				ledger_sha256: run.ledgerSha256,
				telemetry_complete: metrics.telemetry_complete,
				total_tokens: metrics.total_tokens,
				oracle:
					oracle === null
						? null
						: { verdict: oracle.verdict, outcome: oracle.outcome, result_path: join(stepDir, "result.json") },
				verification,
				plan_from_architect: !isArchitect && plan !== undefined,
			});
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
		decision = policy.decide(attempts);
	}
	return finish(options, context, steps, decision.outcome, decision.reason);
}

interface Engine {
	model: Model<string>;
	streamFn: StreamFn;
	priceBook: PriceBook;
}

/** Modelo, stream e tabela de preço do degrau. Offline: roteiro faux. Live: openLiveSession (api-key ou assinatura). */
async function prepareEngine(
	options: SmokeOptions,
	decision: RouterDecision & { kind: "run" },
	workspaceRoot?: string,
): Promise<Engine> {
	const ref = decision.model;
	const key = `${ref.provider}/${ref.modelId}`;
	if (options.authMode === "offline-faux") {
		const id = ref.modelId;
		const runtime = fauxRuntime(OFFLINE_PROVIDER, [id]);
		runtime.script(fixtureTurns(options.taskDir, id) ?? offlineTurns(id));
		return {
			model: runtime.modelOf(id),
			streamFn: runtime.streamFn,
			priceBook: {
				kind: "metered",
				id: "dv-smoke-offline",
				source: "preço fixo do roteiro faux",
				entries: { [key]: OFFLINE_PRICE },
			},
		};
	}
	return openLiveSession({
		authMode: options.authMode,
		provider: ref.provider,
		modelId: ref.modelId,
		authPath: options.authPath ?? resolveAuthPath(),
		...(workspaceRoot === undefined ? {} : { workspaceRoot }),
	});
}

function finish(
	options: SmokeOptions,
	context: { task: { id: string }; provenance: Record<string, string>; datasetSha: string; taskSha: string },
	steps: StepRecord[],
	outcome: SmokeSummary["final_outcome"],
	reason: string,
): SmokeSummary {
	const summary: SmokeSummary = {
		schema: "dv-smoke-summary-v1",
		task_id: context.task.id,
		policy: options.policy,
		scaffold_mode: options.scaffoldMode ?? "uniform",
		auth_mode: options.authMode,
		final_outcome: outcome,
		...(outcome === "blocked" ? { blocked_reason: reason } : {}),
		steps,
		reference_provenance: context.provenance,
		dataset_sha256: context.datasetSha,
		task_definition_sha256: context.taskSha,
	};
	mkdirSync(options.outdir, { recursive: true });
	writeFileSync(join(options.outdir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	return summary;
}

function lastAssistantText(messages: readonly unknown[]): string {
	const last = [...messages]
		.reverse()
		.find((m): m is AssistantMessage => (m as { role?: string }).role === "assistant");
	if (last === undefined) return "";
	return last.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}
