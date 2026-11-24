// Métricas de roteamento (PGR, APGR, Pareto e AIQ) a partir de resumos já gerados pelo dv-bench. Não executa nada.
// Exemplo:
//   node scripts/dv-bench-metrics.ts --weak anthropic/claude-haiku-5-5 --strong anthropic/claude-sonnet-4-6 \
//     runs/<single-haiku>/summary.json runs/<single-sonnet>/summary.json runs/<router>/summary.json
// Bootstrap pareado: --paired-policy-a single --paired-policy-b ladder --seed 20261123 --resamples 10000 summary.json
// Os resumos precisam cobrir o MESMO conjunto de execuções (mesmas tarefas e réplicas).
// Códigos de saída: 0 ok; 1 erro de uso ou de dados.
import { readFileSync } from "node:fs";
import { checkReportContracts } from "../packages/dv-eval/src/bench/contract_labels.ts";
import { computePairedBootstrap, renderPairedBootstrap } from "../packages/dv-eval/src/bench/paired_bootstrap.ts";
import type { BenchReport } from "../packages/dv-eval/src/bench/report.ts";
import { computeRoutingMetrics, renderRoutingSection } from "../packages/dv-eval/src/bench/routing_report.ts";

const FLAGS = new Set(["weak", "strong", "paired-policy-a", "paired-policy-b", "seed", "resamples"]);
const args = new Map<string, string>();
const files: string[] = [];
for (let i = 2; i < process.argv.length; i += 1) {
	const arg = process.argv[i] ?? "";
	if (!arg.startsWith("--")) {
		files.push(arg);
		continue;
	}
	const key = arg.slice(2);
	if (!FLAGS.has(key)) throw new Error(`flag desconhecida: ${arg}`);
	if (args.has(key)) throw new Error(`flag repetida: ${arg}`);
	const value = process.argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${arg} exige um valor`);
	args.set(key, value);
	i += 1;
}

const weakModel = args.get("weak");
const strongModel = args.get("strong");
const policyA = args.get("paired-policy-a");
const policyB = args.get("paired-policy-b");
const seedText = args.get("seed");
const resamplesText = args.get("resamples");
const routingRequested = weakModel !== undefined || strongModel !== undefined;
const pairedRequested = policyA !== undefined || policyB !== undefined;

if (
	files.length === 0 ||
	(routingRequested && (weakModel === undefined || strongModel === undefined)) ||
	(pairedRequested && (policyA === undefined || policyB === undefined)) ||
	(!routingRequested && !pairedRequested) ||
	(!pairedRequested && (seedText !== undefined || resamplesText !== undefined))
) {
	console.error(
		"uso: dv-bench-metrics.ts (--weak model --strong model | --paired-policy-a policy --paired-policy-b policy) [--seed N --resamples N] summary.json [... ]",
	);
	process.exit(1);
}

try {
	const reports = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as BenchReport);
	// Contratos: erro só para problema real (id desconhecido, SHA que não confere, execução fora do contrato do resumo).
	// v4 e v5 entre arms são compatíveis e viram nota, não alerta.
	const contracts = checkReportContracts(reports);
	for (const note of contracts.notes) console.error(`nota: ${note}`);
	if (!contracts.ok) throw new Error(`contrato divergente: ${contracts.problems.join("; ")}`);
	if (routingRequested) {
		const metrics = computeRoutingMetrics(reports, {
			weakModel: weakModel as string,
			strongModel: strongModel as string,
		});
		process.stdout.write(renderRoutingSection(metrics));
	}
	if (pairedRequested) {
		const seed = seedText === undefined ? undefined : Number(seedText);
		const resamples = resamplesText === undefined ? undefined : Number(resamplesText);
		const result = computePairedBootstrap(reports, {
			policyA: policyA as string,
			policyB: policyB as string,
			...(seed === undefined ? {} : { seed }),
			...(resamples === undefined ? {} : { resamples }),
		});
		process.stdout.write(renderPairedBootstrap(result));
	}
} catch (error) {
	console.error(`erro: ${(error as Error).message}`);
	process.exit(1);
}
