// Aprovação do agy sob o contrato v5 (regra condicional). Recalcula a partir do conteúdo gravado no artefato,
// e não do campo `status`, que segue a semântica v4 (INCONCLUSIVE sem cache).
// Aprova só com: protocolVersion numérico, sem erro, troca de modelo não desconfirmada, usage completo e cache zero
// em todos os turnos, com totalTokens = inputTokens + outputTokens.

export interface AgyApproval {
	approved: boolean;
	reasons: string[];
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function agyApprovalV5(artifact: unknown): AgyApproval {
	const a = (artifact ?? {}) as Record<string, unknown>;
	if (a.mode !== "live" || a.provider !== "agy") {
		return { approved: false, reasons: ["artefato não é probe live do agy"] };
	}
	const reasons: string[] = [];
	const handshake = a.handshake as { protocol_version?: unknown } | null | undefined;
	if (num(handshake?.protocol_version) === undefined) reasons.push("protocolVersion ausente ou não numérico");
	const sw = a.model_switch as { status?: unknown } | null | undefined;
	if (sw?.status === "unconfirmed") reasons.push("troca de modelo não confirmada");
	const turns = Array.isArray(a.turns) ? (a.turns as Record<string, unknown>[]) : [];
	if (turns.length === 0) reasons.push("sem turnos");
	turns.forEach((turn, i) => {
		const label = `turno ${i + 1}`;
		if (typeof turn.error === "string") reasons.push(`${label}: erro registrado`);
		const usage = turn.usage as Record<string, unknown> | null | undefined;
		if (usage === null || usage === undefined) {
			reasons.push(`${label}: sem usage`);
			return;
		}
		const missing = Array.isArray(turn.usage_missing) ? turn.usage_missing : [];
		if (missing.length > 0) reasons.push(`${label}: usage incompleto (${missing.join(", ")})`);
		const input = num(usage.inputTokens);
		const output = num(usage.outputTokens);
		const cacheRead = num(usage.cachedReadTokens);
		const cacheWrite = num(usage.cachedWriteTokens);
		const total = num(usage.totalTokens);
		if (
			input === undefined ||
			output === undefined ||
			cacheRead === undefined ||
			cacheWrite === undefined ||
			total === undefined
		) {
			reasons.push(`${label}: campos de usage ausentes ou não numéricos`);
			return;
		}
		if (cacheRead !== 0 || cacheWrite !== 0) {
			reasons.push(`${label}: cache ativo (leitura ${cacheRead}, escrita ${cacheWrite}): regra v5 não aprova`);
		}
		if (total !== input + output)
			reasons.push(`${label}: totalTokens ${total} ≠ inputTokens + outputTokens (${input + output})`);
	});
	return { approved: reasons.length === 0, reasons };
}
