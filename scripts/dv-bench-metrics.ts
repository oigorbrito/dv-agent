// Métricas de roteamento (PGR, APGR, Pareto e AIQ) a partir de resumos já gerados pelo dv-bench. Não executa nada.
// Exemplo:
//   node scripts/dv-bench-metrics.ts --weak anthropic/claude-haiku-5-5 --strong anthropic/claude-sonnet-4-6 \
//     runs/<single-haiku>/summary.json runs/<single-sonnet>/summary.json runs/<router>/summary.json
// Os resumos precisam cobrir o MESMO conjunto de execuções (mesmas tarefas e réplicas).
// Códigos de saída: 0 ok; 1 erro de uso ou de dados.
import { readFileSync } from "node:fs";
import type { BenchReport } from "../packages/dv-eval/src/bench/report.ts";
import { computeRoutingMetrics, renderRoutingSection } from "../packages/dv-eval/src/bench/routing_report.ts";

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const weakModel = flag("weak");
const strongModel = flag("strong");
const files = process.argv
	.slice(2)
	.filter((arg, i, all) => !arg.startsWith("--") && !(i > 0 && all[i - 1]?.startsWith("--")));

if (weakModel === undefined || strongModel === undefined || files.length === 0) {
	console.error("uso: dv-bench-metrics.ts --weak provider/modelId --strong provider/modelId summary.json [...]");
	process.exit(1);
}

try {
	const reports = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as BenchReport);
	const metrics = computeRoutingMetrics(reports, { weakModel, strongModel });
	process.stdout.write(renderRoutingSection(metrics));
} catch (error) {
	console.error(`erro: ${(error as Error).message}`);
	process.exit(1);
}
