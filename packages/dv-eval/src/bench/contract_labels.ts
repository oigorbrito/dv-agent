// Rotulagem de contrato dos runs e dos resumos do bench. Uma fonte só para: id de contrato de um bench, SHA-256 esperado,
// e validação de resumos combinados (dv-bench-metrics).
//
// Regra: um bench que referencia qualquer modelo `agy/…` roda inteiro sob o contrato v5 (ratificado em 2026-11-24).
// Caso contrário, roda sob v4. v5 só altera o tratamento de usage do agy: para os demais provedores a telemetria é
// idêntica (testada em contract_v5.test.ts), então misturar v4 e v5 entre resumos de arms distintos não é divergência.
import { CONTRACT_ID, CONTRACT_V5_ID } from "@dv-agent/core";
import type { BenchReport } from "./report.ts";

export const CONTRACT_V4_SHA256 = "11b4d5453e0964a7eb88decb5cbf7d1c5f5eebf4fbbdd458fb4e38686baef486";
/** SHA-256 do v5 ratificado (contracts/run-accounting-contract-v5.json, status RATIFIED, 2026-11-24). */
export const CONTRACT_V5_SHA256 = "5029e770865a8fdf6c70f1dad9283ff06d8bb6012018d613eb77a2363c3820ad";

export const CONTRACT_SHA_BY_ID: Readonly<Record<string, string>> = {
	[CONTRACT_ID]: CONTRACT_V4_SHA256,
	[CONTRACT_V5_ID]: CONTRACT_V5_SHA256,
};

/** Um modelo referencia o agy quando o namespace é `agy/`. */
export function isAgyModelRef(text: string | undefined): boolean {
	return text?.trim().startsWith("agy/") === true;
}

/** Contrato efetivo de um bench, a partir dos modelos referenciados pelas políticas. */
export function benchContractId(models: readonly (string | undefined)[]): string {
	return models.some((m) => isAgyModelRef(m)) ? CONTRACT_V5_ID : CONTRACT_ID;
}

export interface ContractCheck {
	ok: boolean;
	ids: string[];
	problems: string[];
	notes: string[];
}

/**
 * Valida os contratos de resumos combinados. Erro só para problema real: id desconhecido, SHA que não confere com o id,
 * ou execução cujo contrato difere do contrato do resumo. Contratos diferentes entre arms (v4 e v5) não são erro.
 */
export function checkReportContracts(reports: readonly BenchReport[]): ContractCheck {
	const problems: string[] = [];
	const notes: string[] = [];
	reports.forEach((report, i) => {
		const label = `resumo ${i + 1}`;
		const expectedSha = CONTRACT_SHA_BY_ID[report.contract_id];
		if (expectedSha === undefined) {
			problems.push(`${label}: contract_id ${report.contract_id} desconhecido`);
			return;
		}
		if (report.contract_sha256 !== expectedSha) {
			problems.push(`${label}: contract_sha256 não confere com ${report.contract_id}`);
		}
		for (const run of report.runs) {
			if (run.contract_id !== undefined && run.contract_id !== report.contract_id) {
				problems.push(
					`${label}: execução ${run.task_id}/${run.policy}/rep-${run.repeat} com ${run.contract_id} dentro de um resumo ${report.contract_id}`,
				);
			}
		}
	});
	const ids = [...new Set(reports.map((r) => r.contract_id))].sort();
	if (ids.length > 1)
		notes.push(`contratos mistos entre arms (${ids.join(", ")}): comparação permitida (v5 só altera o agy)`);
	return { ok: problems.length === 0, ids, problems, notes };
}
