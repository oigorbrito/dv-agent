// Classificação do status de verificação. O resultado do oráculo permanece em oracle_pass; erro do provedor sempre
// bloqueia promoção, pois uma falha ao produzir a tentativa não é evidência de qualidade do modelo.
import type { Verification } from "./policy.ts";

/** Veredito do oráculo externo (dv-eval). NO_VERDICT: timeout ou erro do verificador. */
export type OracleVerdict = "PASS" | "FAIL" | "NO_VERDICT";

export interface RunSignals {
	oracle: OracleVerdict;
	/** Quantas chamadas foram bloqueadas pelo DoomLoopDetector. */
	doomLoopBlocks: number;
	/** O BudgetGuard cortou a run (limite inferior passou do teto). */
	budgetTripped: boolean;
	/** Teto não verificável (há chamada de custo desconhecido). */
	budgetUnverifiable: boolean;
	/** A run terminou com erro do provedor. */
	providerError: boolean;
}

/** Deriva o Verification do degrau a partir do veredito do oráculo e dos sinais de runtime. */
export function classifyVerification(signals: RunSignals): Verification {
	if (signals.oracle === "PASS") return { oracle_pass: true, status: "pass" };
	if (signals.providerError) {
		return { oracle_pass: signals.oracle === "FAIL" ? false : null, status: "provider_error" };
	}
	if (signals.oracle === "FAIL") {
		if (signals.doomLoopBlocks > 0) return { oracle_pass: false, status: "doom_loop" };
		if (signals.budgetTripped) return { oracle_pass: false, status: "budget_exceeded" };
		return { oracle_pass: false, status: "fail" };
	}
	if (signals.budgetUnverifiable) return { oracle_pass: null, status: "budget_unverifiable" };
	return { oracle_pass: null, status: "timeout" };
}
