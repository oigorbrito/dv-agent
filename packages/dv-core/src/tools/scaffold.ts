// Perfil de scaffold adaptativo por porte do modelo (--scaffold-mode uniform|adaptive).
// Fan et al. (2026), arXiv:2609.20804:
// - Modelos leves se beneficiam de kit tipado completo + disciplina curta de planejamento.
// - Modelos de fronteira mantêm o kit de arquivo tipado (read/write/edit/bash), mas com prompt de sistema enxuto.
//   Forçar bash-only em fronteira causou estouro de tokens (escaping de shell) no piloto live.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { canonicalJson, sha256Hex } from "../util/canonical.ts";
import { createWorkspaceTools, type WorkspaceToolsOptions } from "./workspace_tools.ts";

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
/** Prompt enxuto para fronteira em adaptive: sem diretriz de planejamento e sem boilerplate. */
export const FRONTIER_SYSTEM_PROMPT = "Você é um agente de código. Use as ferramentas do workspace.";

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
 * Impressão digital do que é enviado ao modelo: system prompt e ferramentas (nome, descrição e schema). Execuções de
 * um mesmo braço precisam ter a mesma impressão digital, ou a ablação compara coisas diferentes. Sem o `execute`.
 */
export function scaffoldFingerprint(
	systemPrompt: string,
	tools: readonly { name: string; description?: string; parameters?: unknown }[],
): { system_prompt_sha256: string; tools_sha256: string } {
	const toolsView = tools.map((tool) => ({
		name: tool.name,
		description: tool.description ?? null,
		parameters: tool.parameters ?? null,
	}));
	return {
		system_prompt_sha256: sha256Hex(systemPrompt),
		tools_sha256: sha256Hex(canonicalJson(toolsView)),
	};
}

/**
 * Monta o scaffold de execução (ferramentas + prompt) conforme o modo e porte do modelo:
 * - uniform: kit padrão de 4 ferramentas tipadas e prompt base para todos os degraus.
 * - adaptive:
 *   - leves (haiku, flash, mini, luna, cheap): kit completo + diretriz de planejamento;
 *   - fronteira (sonnet, opus, terra, astra, strong): kit completo + prompt enxuto (sem diretriz de planejamento).
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
			tools: createWorkspaceTools(options),
			systemPrompt: FRONTIER_SYSTEM_PROMPT,
		};
	}

	return {
		mode,
		tier,
		tools: createWorkspaceTools(options),
		systemPrompt: `${basePrompt}\n\n${FAN_PLANNING_DIRECTIVE}`,
	};
}
