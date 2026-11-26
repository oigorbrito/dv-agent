// Fonte única dos rótulos de telemetria de custo/tokens, do ledger ao resumo.
//
// - MEASURED: todos os baldes foram medidos (telemetry_complete = true).
// - UNVERIFIABLE: falta medir um balde por causa conhecida e declarada do provedor. Hoje só o agy com cache não verificado
//   (contrato v5). Não é zero: o número não existe. Sob v4 é erro de rotulagem (ver contract_labels.ts).
// - INCONCLUSIVE: falta medir por motivo não classificado, ou não há passos. Também não é zero.
//
// Agregação: a pior etiqueta vence (INCONCLUSIVE > UNVERIFIABLE > MEASURED). Grupo sem passos é INCONCLUSIVE.

export type TelemetryStatus = "MEASURED" | "UNVERIFIABLE" | "INCONCLUSIVE";

const SEVERITY: Readonly<Record<TelemetryStatus, number>> = { MEASURED: 0, UNVERIFIABLE: 1, INCONCLUSIVE: 2 };

export function isTelemetryStatus(value: unknown): value is TelemetryStatus {
	return value === "MEASURED" || value === "UNVERIFIABLE" || value === "INCONCLUSIVE";
}

/** Pior etiqueta de uma lista. Lista vazia é INCONCLUSIVE (nada foi medido). */
export function worstTelemetryStatus(statuses: readonly TelemetryStatus[]): TelemetryStatus {
	if (statuses.length === 0) return "INCONCLUSIVE";
	let worst: TelemetryStatus = "MEASURED";
	for (const status of statuses) {
		if (SEVERITY[status] > SEVERITY[worst]) worst = status;
	}
	return worst;
}

/**
 * Etiqueta de uma chamada do ledger. Usa cost_accounting_status quando presente e válido; ledgers antigos sem o campo
 * caem para telemetry_complete (true = MEASURED, qualquer outro valor = INCONCLUSIVE, nunca UNVERIFIABLE sem prova).
 */
export function callTelemetryStatus(telemetry: {
	cost_accounting_status?: unknown;
	telemetry_complete?: unknown;
}): TelemetryStatus {
	if (isTelemetryStatus(telemetry.cost_accounting_status)) return telemetry.cost_accounting_status;
	return telemetry.telemetry_complete === true ? "MEASURED" : "INCONCLUSIVE";
}

/** Etiqueta de um balde de métricas de passo; resumos antigos sem telemetry_status usam telemetry_complete. */
export function metricsTelemetryStatus(metrics: {
	telemetry_status?: unknown;
	telemetry_complete: boolean;
}): TelemetryStatus {
	if (isTelemetryStatus(metrics.telemetry_status)) return metrics.telemetry_status;
	return metrics.telemetry_complete ? "MEASURED" : "INCONCLUSIVE";
}
