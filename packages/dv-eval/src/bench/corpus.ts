// Corpus calibrado: descoberta das tarefas (uma pasta por tarefa, com task.json) e filtro por tier e id.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadTask } from "../oracle/verifier.ts";

export const TIERS = ["easy", "medium", "hard"] as const;
export type Tier = (typeof TIERS)[number];

export interface CorpusTask {
	id: string;
	tier: Tier;
	title: string;
	dir: string;
}

export function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** Lê todas as tarefas do corpus. Pasta sem task.json é ignorada; id diferente do nome da pasta é erro. */
export function discoverCorpus(corpusDir: string): CorpusTask[] {
	const root = resolve(corpusDir);
	if (!existsSync(root)) throw new Error(`corpus ausente: ${root}`);
	const tasks: CorpusTask[] = [];
	for (const name of readdirSync(root).sort()) {
		const dir = join(root, name);
		if (!statSync(dir).isDirectory() || !existsSync(join(dir, "task.json"))) continue;
		const raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as { tier?: unknown; title?: unknown };
		const task = loadTask(dir);
		if (task.id !== name) throw new Error(`tarefa em ${dir}: id ${task.id} difere do nome da pasta`);
		if (!isTier(raw.tier)) throw new Error(`tarefa ${task.id}: tier inválido: ${String(raw.tier)}`);
		tasks.push({ id: task.id, tier: raw.tier, title: typeof raw.title === "string" ? raw.title : "", dir });
	}
	const tierRank = (tier: Tier): number => TIERS.indexOf(tier);
	const duplicates = tasks.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i);
	if (duplicates.length > 0) throw new Error(`ids duplicados no corpus: ${duplicates.join(", ")}`);
	return tasks.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface TaskFilter {
	tier: Tier | "all";
	task?: string;
}

/** Aplica --tier e --task. Erro explícito quando nada casa (nunca executa um conjunto vazio em silêncio). */
export function selectTasks(tasks: readonly CorpusTask[], filter: TaskFilter): CorpusTask[] {
	if (filter.task !== undefined) {
		const found = tasks.find((t) => t.id === filter.task);
		if (found === undefined) throw new Error(`tarefa inexistente no corpus: ${filter.task}`);
		if (filter.tier !== "all" && found.tier !== filter.tier) {
			throw new Error(`tarefa ${found.id} é do tier ${found.tier}, não ${filter.tier}`);
		}
		return [found];
	}
	const selected = tasks.filter((t) => filter.tier === "all" || t.tier === filter.tier);
	if (selected.length === 0) throw new Error(`nenhuma tarefa para tier=${filter.tier}`);
	return selected;
}
