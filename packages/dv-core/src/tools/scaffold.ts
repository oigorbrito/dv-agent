// Perfil de scaffold adaptativo por porte do modelo (--scaffold-mode uniform|adaptive).
// Fan et al. (2026), arXiv:2609.20804:
// - Modelos leves se beneficiam de kit tipado completo + disciplina curta de planejamento.
// - Modelos de fronteira operam eficientemente em modo enxuto (bash-only), cortando overhead de definições e turnos.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createWorkspaceTools, runBashTool, type WorkspaceToolsOptions } from "./workspace_tools.ts";

export type ScaffoldMode = "uniform" | "adaptive";
export type ModelTier = "light" | "frontier";

export const SCAFFOLD_MODES: readonly ScaffoldMode[] = ["uniform", "adaptive"] as const;

export const LIGHTWEIGHT_MODEL_PATTERNS: readonly RegExp[] = [
	/\bhaiku\b/i,
	/\bflash\b/i,
	/\bmini\b/i,
	/\bluna\b/i,
	/\bcheap\b/i,
];

export const FRONTIER_MODEL_PATTERNS: readonly RegExp[] = [
	/\bsonnet\b/i,
	/\bopus\b/i,
	/\bterra\b/i,
	/\bastra\b/i,
	/\bstrong\b/i,
];

/** Classifica o modelo em porte leve (light) ou fronteira (frontier). Padrão quando ambíguo: light. */
export function classifyModelTier(modelId: string): ModelTier {
	const lower = modelId.toLowerCase();
	for (const pattern of FRONTIER_MODEL_PATTERNS) {
		if (pattern.test(lower)) return "frontier";
	}
	for (const pattern of LIGHTWEIGHT_MODEL_PATTERNS) {
		if (pattern.test(lower)) return "light";
	}
	return "light";
}

/** Diretriz de planejamento para modelos leves antes da primeira edição (Fan et al., 2026). */
export const FAN_PLANNING_DIRECTIVE =
	"Antes da primeira edição de qualquer arquivo, planeje a abordagem em poucas linhas.";

export const DEFAULT_SYSTEM_PROMPT = "Você é um agente de código. Use as ferramentas do workspace.";
export const FRONTIER_BASH_SYSTEM_PROMPT =
	"Você é um agente de código. Use a ferramenta run_bash para inspecionar e editar o workspace.";

export interface ScaffoldProfile {
	mode: ScaffoldMode;
	tier: ModelTier;
	tools: AgentTool[];
	systemPrompt: string;
}

export interface AssembleScaffoldOptions extends WorkspaceToolsOptions {
	scaffoldMode?: ScaffoldMode;
	modelId: string;
	baseSystemPrompt?: string;
}

/**
 * Monta o scaffold de execução (ferramentas + prompt) conforme o modo e porte do modelo:
 * - uniform: kit padrão de 4 ferramentas tipadas e prompt base para todos os degraus.
 * - adaptive:
 *   - leves (haiku, flash, mini, luna, cheap): kit completo + diretriz de planejamento;
 *   - fronteira (sonnet, opus, terra, astra, strong): modo enxuto (run_bash exclusivo).
 */
export function assembleScaffold(options: AssembleScaffoldOptions): ScaffoldProfile {
	const mode = options.scaffoldMode ?? "uniform";
	const tier = classifyModelTier(options.modelId);
	const basePrompt = options.baseSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

	if (mode === "uniform") {
		return {
			mode,
			tier,
			tools: createWorkspaceTools(options),
			systemPrompt: basePrompt,
		};
	}

	if (tier === "frontier") {
		return {
			mode,
			tier,
			tools: [runBashTool(options.workspaceRoot, options.maxOutputBytes, options.bashTimeoutMs)],
			systemPrompt: FRONTIER_BASH_SYSTEM_PROMPT,
		};
	}

	return {
		mode,
		tier,
		tools: createWorkspaceTools(options),
		systemPrompt: `${basePrompt}\n\n${FAN_PLANNING_DIRECTIVE}`,
	};
}
