// Resumo do ledger.jsonl para o result.json do oráculo. Lê somente o arquivo escrito pelo harness.
import { readFileSync } from "node:fs";

export interface LedgerSummary {
	run_status: string | null;
	ceiling_status: string | null;
	model: { provider: string; model_id: string; api: string } | null;
	calls_started: number;
	calls_finished: number;
	tool_status_counts: Record<string, number>;
	doom_loop_blocks: number;
	budget_blocked_tools: number;
	spent_lower_bound_usd: number | null;
	unknown_cost_calls: number | null;
}

type Event = Record<string, unknown>;

/** Agrega eventos do ledger em um resumo. Ledger ausente ou inválido lança erro (não há resumo parcial silencioso). */
export function readLedgerSummary(path: string): LedgerSummary {
	const events = readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Event);
	const started = events.find((ev) => ev.event === "run_started");
	const finished = events.find((ev) => ev.event === "run_finished");
	const toolCounts: Record<string, number> = {};
	for (const ev of events) {
		if (ev.event !== "tool_finished") continue;
		const status = String(ev.status);
		toolCounts[status] = (toolCounts[status] ?? 0) + 1;
	}
	const guards = (finished?.guard_events ?? {}) as Record<string, number>;
	return {
		run_status: (finished?.status as string | undefined) ?? null,
		ceiling_status: (finished?.ceiling_status as string | undefined) ?? null,
		model: (started?.model as LedgerSummary["model"] | undefined) ?? null,
		calls_started: events.filter((ev) => ev.event === "call_started").length,
		calls_finished: events.filter((ev) => ev.event === "call_finished").length,
		tool_status_counts: toolCounts,
		doom_loop_blocks: guards.doom_loop_blocks ?? 0,
		budget_blocked_tools: guards.budget_blocked_tools ?? 0,
		spent_lower_bound_usd: (finished?.spent_lower_bound_usd as number | undefined) ?? null,
		unknown_cost_calls: (finished?.unknown_cost_calls as number | undefined) ?? null,
	};
}
