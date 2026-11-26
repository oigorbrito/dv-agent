// Congelamento de system prompt e ferramentas entre os braços de uma ablação.
//
// Um braço só é comparável a outro se o que chega ao modelo for o mesmo. Em scaffold `uniform` isso é exigido: system
// prompt e ferramentas precisam ter uma única impressão digital no conjunto de resumos. Em `adaptive` o system prompt
// varia por porte de propósito (declarado pelo modo); as ferramentas continuam obrigatoriamente iguais.
// O architect não recebe ferramentas, então seus passos ficam de fora da checagem de ferramentas.
import type { BenchReport } from "./report.ts";

export interface FreezeCheck {
	problems: string[];
	notes: string[];
}

function record(index: Map<string, string[]>, digest: string, label: string): void {
	const labels = index.get(digest) ?? [];
	labels.push(label);
	index.set(digest, labels);
}

export function frozenScaffoldProblems(reports: readonly BenchReport[]): FreezeCheck {
	const problems: string[] = [];
	const notes: string[] = [];
	const systems = new Map<string, string[]>();
	const tools = new Map<string, string[]>();
	let unmeasured = 0;
	reports.forEach((report, i) => {
		const label = `resumo ${i + 1}`;
		for (const run of report.runs ?? []) {
			for (const step of run.steps ?? []) {
				if (step.role === "architect") continue;
				if (!step.system_prompt_sha256 || !step.tools_sha256) {
					unmeasured += 1;
					continue;
				}
				record(systems, step.system_prompt_sha256, label);
				record(tools, step.tools_sha256, label);
			}
		}
	});
	if (unmeasured > 0) {
		notes.push(
			`${unmeasured} passo(s) sem impressão digital de scaffold (resumo antigo): congelamento não verificado neles`,
		);
	}
	if (tools.size > 1) {
		problems.push(
			`ferramentas divergentes entre braços (${tools.size} impressões digitais): a ablação compara coisas diferentes`,
		);
	}
	if (systems.size > 1) {
		const usesUniform = reports.some((report) => (report.scaffold_mode ?? "uniform") === "uniform");
		if (usesUniform) {
			problems.push(`system prompt divergente em scaffold uniform (${systems.size} impressões digitais)`);
		} else {
			notes.push(
				`system prompt varia por porte em scaffold adaptive (${systems.size} impressões digitais), por declaração do modo`,
			);
		}
	}
	return { problems, notes };
}
