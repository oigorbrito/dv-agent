// Políticas de roteamento: decidem o próximo passo a partir do histórico de tentativas. Decisões puras, sem I/O.
// Tetos por degrau seguem contract v4, regra c: cap_i = min(global_max * cost_share_cap_i, global_max - spent_before_i).

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelRef {
	provider: string;
	modelId: string;
	reasoningEffort?: ReasoningEffort;
}

/** Status de verificação externa. `fail` é veredito; os demais são ausência de veredito. */
export type VerificationStatus =
	| "pass"
	| "fail"
	| "doom_loop"
	| "budget_exceeded"
	| "timeout"
	| "provider_error"
	| "budget_unverifiable";

/** Status que promovem ao próximo degrau por padrão. provider_error fica fora: erro de infraestrutura não é evidência sobre o modelo. */
export const DEFAULT_ESCALATE_ON_STATUSES: readonly VerificationStatus[] = ["fail", "doom_loop", "budget_exceeded"];

export interface Verification {
	oracle_pass: boolean | null;
	status: VerificationStatus;
}

/** Uma tentativa concluída. `verification` é null em passos sem oráculo próprio (ex.: planejamento). */
export interface Attempt {
	rung: number;
	role: string;
	model: ModelRef;
	verification: Verification | null;
	spent_lower_bound_usd: number;
}

export type StopOutcome = "solved" | "unsolved" | "inconclusive" | "budget_exhausted";

export type RouterDecision =
	| { kind: "run"; rung: number; role: string; model: ModelRef; cap_usd: number; route_reason?: string }
	| { kind: "stop"; outcome: StopOutcome; reason: string };

export interface RouterPolicy {
	readonly name: string;
	decide(history: readonly Attempt[]): RouterDecision;
}

export interface RungSpec {
	model: ModelRef;
	/** Fração do teto global que este degrau pode usar (cost_share_cap_i). */
	costShareCap: number;
}

export interface LadderOptions {
	rungs: readonly RungSpec[];
	globalMaxCostUsd: number;
	/**
	 * Status que promovem ao próximo degrau. O contrato v4 cita `escalate_on_statuses` sem fixar o valor;
	 * o padrão é DEFAULT_ESCALATE_ON_STATUSES (decisão deste código, aprovada pelo usuário).
	 */
	escalateOnStatuses?: readonly VerificationStatus[];
	/** Degrau da primeira tentativa (padrão 0). Degraus abaixo dele nunca são executados nesta política. */
	startRung?: number;
}

/** Soma do limite inferior de todos os degraus executados, incluindo os reprovados (regra c). */
export function totalSpent(history: readonly Attempt[]): number {
	return history.reduce((sum, attempt) => sum + attempt.spent_lower_bound_usd, 0);
}

/** Política de referência: um único modelo, sem escalonamento. */
export class SingleModelPolicy implements RouterPolicy {
	readonly name = "single_model";
	private readonly model: ModelRef;
	private readonly globalMaxCostUsd: number;

	constructor(model: ModelRef, globalMaxCostUsd: number) {
		this.model = model;
		this.globalMaxCostUsd = globalMaxCostUsd;
	}

	decide(history: readonly Attempt[]): RouterDecision {
		const last = history.at(-1);
		if (last === undefined) {
			return { kind: "run", rung: 0, role: "executor", model: this.model, cap_usd: this.globalMaxCostUsd };
		}
		return stopAfterVerdict(last, this.globalMaxCostUsd - totalSpent(history));
	}
}

/**
 * Execução guiada por oráculo: começa no degrau 0 e promove ao próximo somente quando o status da verificação
 * externa está em `escalateOnStatuses`. Cada degrau parte de workspace limpo (fora desta política).
 */
export class ExecutionGuidedLadderPolicy implements RouterPolicy {
	readonly name = "execution_guided_ladder";
	private readonly options: LadderOptions;

	constructor(options: LadderOptions) {
		if (options.rungs.length === 0) throw new Error("ladder sem degraus");
		const start = options.startRung ?? 0;
		if (!Number.isInteger(start) || start < 0 || start >= options.rungs.length) {
			throw new Error(`startRung ${start} fora dos degraus 0..${options.rungs.length - 1}`);
		}
		this.options = options;
	}

	decide(history: readonly Attempt[]): RouterDecision {
		const { rungs, globalMaxCostUsd } = this.options;
		const escalateOnStatuses = this.options.escalateOnStatuses ?? DEFAULT_ESCALATE_ON_STATUSES;
		const spent = totalSpent(history);
		const last = history.at(-1);

		if (last === undefined) return this.runRung(this.options.startRung ?? 0, spent);
		const verification = last.verification;
		if (verification === null) return { kind: "stop", outcome: "inconclusive", reason: "tentativa sem oráculo" };
		if (verification.oracle_pass === true) return { kind: "stop", outcome: "solved", reason: "oráculo aprovou" };

		const nextRung = last.rung + 1;
		const canEscalate = escalateOnStatuses.includes(verification.status) && nextRung < rungs.length;
		if (!canEscalate) {
			return stopAfterVerdict(last, globalMaxCostUsd - spent);
		}
		return this.runRung(nextRung, spent);
	}

	private runRung(index: number, spent: number): RouterDecision {
		const { rungs, globalMaxCostUsd } = this.options;
		const rung = rungs[index];
		if (rung === undefined) throw new Error(`degrau ${index} inexistente`);
		const remaining = globalMaxCostUsd - spent;
		if (remaining <= 0) return { kind: "stop", outcome: "budget_exhausted", reason: "saldo global esgotado" };
		const cap = Math.min(globalMaxCostUsd * rung.costShareCap, remaining);
		return { kind: "run", rung: index, role: `rung_${index}`, model: rung.model, cap_usd: cap };
	}
}

/**
 * Architect/editor: um passo de planejamento sem oráculo seguido de edição com oráculo. Em reprovação, reedita
 * até `maxEditorAttempts`. Não há evidência congelada de vantagem para esta política (MECHANISM_AVAILABLE != NECESSARY).
 */
export class ArchitectEditorPolicy implements RouterPolicy {
	readonly name = "architect_editor";
	private readonly architect: ModelRef;
	private readonly editor: ModelRef;
	private readonly globalMaxCostUsd: number;
	private readonly maxEditorAttempts: number;

	constructor(options: { architect: ModelRef; editor: ModelRef; globalMaxCostUsd: number; maxEditorAttempts: number }) {
		this.architect = options.architect;
		this.editor = options.editor;
		this.globalMaxCostUsd = options.globalMaxCostUsd;
		this.maxEditorAttempts = options.maxEditorAttempts;
	}

	decide(history: readonly Attempt[]): RouterDecision {
		const spent = totalSpent(history);
		const remaining = this.globalMaxCostUsd - spent;
		const last = history.at(-1);
		if (last === undefined) {
			return { kind: "run", rung: 0, role: "architect", model: this.architect, cap_usd: this.globalMaxCostUsd };
		}
		if (last.role === "architect") {
			if (remaining <= 0) return { kind: "stop", outcome: "budget_exhausted", reason: "saldo global esgotado" };
			return { kind: "run", rung: 1, role: "editor", model: this.editor, cap_usd: remaining };
		}
		const verification = last.verification;
		if (verification === null) return { kind: "stop", outcome: "inconclusive", reason: "editor sem oráculo" };
		if (verification.oracle_pass === true) return { kind: "stop", outcome: "solved", reason: "oráculo aprovou" };
		const editorAttempts = history.filter((attempt) => attempt.role === "editor").length;
		if (verification.status === "fail" && editorAttempts < this.maxEditorAttempts && remaining > 0) {
			return { kind: "run", rung: 1, role: "editor", model: this.editor, cap_usd: remaining };
		}
		return stopAfterVerdict(last, remaining);
	}
}

/** Parada após uma tentativa: aprovação vence qualquer orçamento; `fail` é não resolvido; sem veredito é inconclusivo. */
function stopAfterVerdict(last: Attempt, remaining: number): RouterDecision {
	if (last.verification?.oracle_pass === true) return { kind: "stop", outcome: "solved", reason: "oráculo aprovou" };
	if (remaining <= 0) return { kind: "stop", outcome: "budget_exhausted", reason: "saldo global esgotado" };
	if (last.verification === null) return { kind: "stop", outcome: "inconclusive", reason: "tentativa sem oráculo" };
	if (last.verification.status === "fail") return { kind: "stop", outcome: "unsolved", reason: "oráculo reprovou" };
	return {
		kind: "stop",
		outcome: "inconclusive",
		reason: `sem veredito do oráculo (${last.verification.status})`,
	};
}
