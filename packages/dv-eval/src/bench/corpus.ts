// Corpus calibrado: descoberta das tarefas (uma pasta por tarefa, com task.json) e filtro por tier e id.
// Tiers positivos (easy, medium, hard) formam o conjunto padrão. Tier "negative" (controle irresolvível,
// expected_outcome "unsolved") só entra com --tier negative ou --task <id>; nunca no "all" padrão.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadTask } from "../oracle/verifier.ts";

/** Tiers positivos: easy, medium, hard e frontier (tarefas de alta densidade para discriminar modelos menores). */
export const TIERS = ["easy", "medium", "hard", "frontier"] as const;
export type Tier = (typeof TIERS)[number];
export const NEGATIVE_TIER = "negative" as const;
/** Todos os tiers válidos no corpus, incluindo o controle negativo. */
export const CORPUS_TIERS = [...TIERS, NEGATIVE_TIER] as const;
export type CorpusTier = (typeof CORPUS_TIERS)[number];

export interface CorpusTask {
	id: string;
	tier: CorpusTier;
	title: string;
	dir: string;
	/** Resultado esperado por construção: "unsolved" para o controle negativo. */
	expectedOutcome: "solved" | "unsolved";
}

export function isCorpusTier(value: unknown): value is CorpusTier {
	return typeof value === "string" && (CORPUS_TIERS as readonly string[]).includes(value);
}

/** Lê todas as tarefas do corpus. Pasta sem task.json é ignorada; id diferente do nome da pasta é erro. */
export function discoverCorpus(corpusDir: string): CorpusTask[] {
	const root = resolve(corpusDir);
	if (!existsSync(root)) throw new Error(`corpus ausente: ${root}`);
	const tasks: CorpusTask[] = [];
	for (const name of readdirSync(root).sort()) {
		const dir = join(root, name);
		if (!statSync(dir).isDirectory() || !existsSync(join(dir, "task.json"))) continue;
		const raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as {
			tier?: unknown;
			title?: unknown;
			expected_outcome?: unknown;
		};
		const task = loadTask(dir);
		if (task.id !== name) throw new Error(`tarefa em ${dir}: id ${task.id} difere do nome da pasta`);
		if (!isCorpusTier(raw.tier)) throw new Error(`tarefa ${task.id}: tier inválido: ${String(raw.tier)}`);
		const negative = raw.tier === NEGATIVE_TIER;
		if (negative && raw.expected_outcome !== "unsolved") {
			throw new Error(`tarefa ${task.id}: tier negative exige expected_outcome "unsolved"`);
		}
		tasks.push({
			id: task.id,
			tier: raw.tier,
			title: typeof raw.title === "string" ? raw.title : "",
			dir,
			expectedOutcome: negative ? "unsolved" : "solved",
		});
	}
	const tierRank = (tier: CorpusTier): number => CORPUS_TIERS.indexOf(tier);
	const duplicates = tasks.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i);
	if (duplicates.length > 0) throw new Error(`ids duplicados no corpus: ${duplicates.join(", ")}`);
	return tasks.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface TaskFilter {
	tier: CorpusTier | "all";
	task?: string;
	/** Lista explícita de IDs (ordem do corpus). Exclui `task`. Não respeita a exclusão do tier negativo. */
	tasks?: readonly string[];
}

/**
 * Aplica --tier e --task. "all" exclui o controle negativo (só entra explicitamente).
 * Erro explícito quando nada casa (nunca executa um conjunto vazio em silêncio).
 */
/** Seleção por lista de IDs: valida formato, repetição, existência e tier. Mantém a ordem do corpus. */
function selectExplicit(tasks: readonly CorpusTask[], ids: readonly string[], tier: CorpusTier | "all"): CorpusTask[] {
	if (ids.length === 0) throw new Error("--tasks sem IDs");
	const seen = new Set<string>();
	for (const id of ids) {
		if (id === "") throw new Error("ID vazio em --tasks");
		if (seen.has(id)) throw new Error(`ID repetido em --tasks: ${id}`);
		seen.add(id);
	}
	const known = new Set(tasks.map((t) => t.id));
	const missing = ids.filter((id) => !known.has(id));
	if (missing.length > 0) throw new Error(`tarefas inexistentes no corpus: ${missing.join(", ")}`);
	const selected = tasks.filter((t) => seen.has(t.id));
	if (tier !== "all") {
		const wrong = selected.find((t) => t.tier !== tier);
		if (wrong !== undefined) throw new Error(`tarefa ${wrong.id} é do tier ${wrong.tier}, não ${tier}`);
	}
	return selected;
}

export function selectTasks(tasks: readonly CorpusTask[], filter: TaskFilter): CorpusTask[] {
	if (filter.tasks !== undefined) {
		if (filter.task !== undefined) throw new Error("use --task ou --tasks, não os dois");
		return selectExplicit(tasks, filter.tasks, filter.tier);
	}
	if (filter.task !== undefined) {
		const found = tasks.find((t) => t.id === filter.task);
		if (found === undefined) throw new Error(`tarefa inexistente no corpus: ${filter.task}`);
		if (filter.tier !== "all" && found.tier !== filter.tier) {
			throw new Error(`tarefa ${found.id} é do tier ${found.tier}, não ${filter.tier}`);
		}
		return [found];
	}
	const selected = tasks.filter((t) => {
		if (filter.tier === "all") return t.tier !== NEGATIVE_TIER;
		return t.tier === filter.tier;
	});
	if (selected.length === 0) throw new Error(`nenhuma tarefa para tier=${filter.tier}`);
	return selected;
}
