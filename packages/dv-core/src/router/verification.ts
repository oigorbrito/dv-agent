// Classificação do status de verificação. O veredito do oráculo é soberano: sinais de runtime só refinam o status
// quando o oráculo reprovou ou não deu veredito; nunca mudam oracle_pass (contract v4, regra a).
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
	if (signals.oracle === "FAIL") {
		if (signals.doomLoopBlocks > 0) return { oracle_pass: false, status: "doom_loop" };
		if (signals.budgetTripped) return { oracle_pass: false, status: "budget_exceeded" };
		return { oracle_pass: false, status: "fail" };
	}
	if (signals.providerError) return { oracle_pass: null, status: "provider_error" };
	if (signals.budgetUnverifiable) return { oracle_pass: null, status: "budget_unverifiable" };
	return { oracle_pass: null, status: "timeout" };
}
