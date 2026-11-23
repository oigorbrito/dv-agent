// Baldes de tokens somados a partir do ledger.jsonl (telemetria por chamada, contract v4 regra a).
// Campos nulos (declarados não expostos pelo transporte) não entram na soma; telemetry_complete=false se qualquer chamada for INCONCLUSIVE.
import { readFileSync } from "node:fs";

export interface LedgerMetrics {
	calls: number;
	telemetry_complete: boolean;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	uncached_input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** Soma do custo em USD; null se alguma chamada não tem custo em USD (desconhecido ou sessão de assinatura). */
	cost_usd: number | null;
}

type Json = Record<string, unknown>;

/** Soma os baldes de todas as chamadas do ledger. Ledger ilegível lança erro (sem métrica parcial silenciosa). */
export function readLedgerMetrics(path: string): LedgerMetrics {
	const metrics: LedgerMetrics = {
		calls: 0,
		telemetry_complete: true,
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		uncached_input_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		cost_usd: 0,
	};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.length === 0) continue;
		const event = JSON.parse(line) as Json;
		if (event.event !== "call_finished") continue;
		const telemetry = ((event.record as Json).telemetry ?? {}) as Json;
		metrics.calls += 1;
		if (telemetry.telemetry_complete !== true) metrics.telemetry_complete = false;
		metrics.prompt_tokens += num(telemetry.prompt_tokens);
		metrics.completion_tokens += num(telemetry.completion_tokens);
		metrics.total_tokens += num(telemetry.total_tokens);
		metrics.uncached_input_tokens += num(telemetry.uncached_input_tokens);
		metrics.cache_read_tokens += num(telemetry.cache_read_tokens);
		metrics.cache_write_tokens += num(telemetry.cache_write_tokens);
		if (typeof telemetry.cost_usd === "number" && metrics.cost_usd !== null) metrics.cost_usd += telemetry.cost_usd;
		else metrics.cost_usd = null;
	}
	return metrics;
}

function num(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
