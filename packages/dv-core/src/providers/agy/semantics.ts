// Semântica de inputTokens e cache no usage do agy. Função pura, sem I/O.
//
// Duas leituras possíveis para o mesmo usage:
//   cache_inside_input:  totalTokens = inputTokens + outputTokens            (cache contido em inputTokens)
//   cache_outside_input: totalTokens = inputTokens + outputTokens + cache    (cache somado à parte)
// Um turno SEM cache não separa as duas (T = I + O nas duas). Só turno com cachedRead/cachedWrite > 0 decide.
// thoughtTokens é subconjunto de outputTokens (verificado no probe de 2026-11-24).
import type { AgyTurnUsage } from "./usage.ts";

export type AgyUsageSemantics = "cache_inside_input" | "cache_outside_input";

export interface AgyUsageVerdict {
	status: "DETERMINED" | "INDETERMINATE" | "INCONSISTENT";
	semantics: AgyUsageSemantics | null;
	/** Turnos com cache (leitura ou escrita > 0): só eles decidem. */
	warm_turns: number;
	evidence: string[];
	/** Regra de entrada não cacheada que a semântica implicaria. Proposta: não é regra do contrato v4. */
	proposed_uncached_rule: "input_minus_cache" | "input" | null;
}

function field(turn: AgyTurnUsage, name: keyof AgyTurnUsage): number | undefined {
	const value = turn[name];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function classifyAgyUsage(turns: readonly AgyTurnUsage[]): AgyUsageVerdict {
	const evidence: string[] = [];
	const candidates: AgyUsageSemantics[] = [];
	let warm = 0;
	for (let i = 0; i < turns.length; i += 1) {
		const turn = turns[i] as AgyTurnUsage;
		const label = `turno ${i + 1}`;
		const I = field(turn, "inputTokens");
		const O = field(turn, "outputTokens");
		const R = field(turn, "cachedReadTokens");
		const W = field(turn, "cachedWriteTokens");
		const K = field(turn, "thoughtTokens");
		const T = field(turn, "totalTokens");
		if ([I, O, R, W, K, T].some((v) => v === undefined)) {
			return inconsistent(evidence, `${label}: campo de usage ausente ou inválido`, warm);
		}
		const [input, output, cacheRead, cacheWrite, thought, total] = [I, O, R, W, K, T] as number[];
		if ((thought as number) > output) {
			return inconsistent(evidence, `${label}: thoughtTokens (${thought}) maior que outputTokens (${output})`, warm);
		}
		const insideHolds = total === input + output;
		const outsideHolds = total === input + output + cacheRead + cacheWrite;
		if (!insideHolds && !outsideHolds) {
			return inconsistent(
				evidence,
				`${label}: totalTokens ${total} não bate com input+output (${input + output}) nem com input+output+cache (${input + output + cacheRead + cacheWrite})`,
				warm,
			);
		}
		if (cacheRead + cacheWrite === 0) {
			evidence.push(`${label}: sem cache, não decide (T = I + O nas duas leituras)`);
			continue;
		}
		warm += 1;
		// Com cache > 0, as duas fórmulas não podem valer ao mesmo tempo: exatamente uma vale.
		if (insideHolds && outsideHolds) {
			return inconsistent(evidence, `${label}: duas fórmulas valem com cache > 0 (impossível)`, warm);
		}
		if (insideHolds) {
			if (cacheRead + cacheWrite > input) {
				return inconsistent(
					evidence,
					`${label}: cache (${cacheRead + cacheWrite}) maior que inputTokens (${input})`,
					warm,
				);
			}
			candidates.push("cache_inside_input");
			evidence.push(`${label}: T = I + O com cache ${cacheRead + cacheWrite} (cache dentro de input)`);
		} else {
			candidates.push("cache_outside_input");
			evidence.push(`${label}: T = I + O + cache com cache ${cacheRead + cacheWrite} (cache fora de input)`);
		}
	}

	if (warm === 0) {
		return {
			status: "INDETERMINATE",
			semantics: null,
			warm_turns: 0,
			evidence: [...evidence, "nenhum turno com cache: a semântica não foi determinada"],
			proposed_uncached_rule: null,
		};
	}
	const distinct = [...new Set(candidates)];
	if (distinct.length > 1) {
		return inconsistent(evidence, "turnos com cache discordam sobre a semântica", warm);
	}
	const semantics = distinct[0] as AgyUsageSemantics;
	return {
		status: "DETERMINED",
		semantics,
		warm_turns: warm,
		evidence,
		proposed_uncached_rule: semantics === "cache_inside_input" ? "input_minus_cache" : "input",
	};
}

function inconsistent(evidence: string[], reason: string, warm: number): AgyUsageVerdict {
	return {
		status: "INCONSISTENT",
		semantics: null,
		warm_turns: warm,
		evidence: [...evidence, reason],
		proposed_uncached_rule: null,
	};
}
