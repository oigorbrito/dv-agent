// Benchmark de ablação (single x ladder x architect-editor) sobre o corpus calibrado. Exemplos:
//   node scripts/dv-bench.ts --policies single,ladder --auth-mode faux
//   node scripts/dv-bench.ts --tier hard --task hard-02-wal-ledger-replay --policies single,ladder --auth-mode faux
//   node scripts/dv-bench.ts --policies single,ladder --auth-mode api-key --model openai/<id> --escalation-model openai/<id2>
// Opções: --corpus DIR (padrão packages/dv-eval/corpus)  --tier all|easy|medium|hard  --task ID
//   --policies single,ladder,architect-editor  --auth-mode faux|subscription|api-key
//   --model provider/modelId (degrau 0 / editor)  --escalation-model provider/modelId (degrau 1 / architect)
//   --max-tokens N (teto de tokens por execução, somado entre degraus)  --max-cost USD (padrão 0.05)
//   --outdir DIR (padrão runs/bench-<timestamp>)
// Códigos de saída: 0 ok; 1 erro de uso ou execução; 2 violação de conformidade v4 (relatório gravado mesmo assim).
import { resolve } from "node:path";
import {
	type BenchOptions,
	CONTRACT_PATH,
	ConformanceFailure,
	runBench,
} from "../packages/dv-eval/src/bench/ablation.ts";
import { TIERS, type Tier } from "../packages/dv-eval/src/bench/corpus.ts";
import { parseArgs } from "../packages/dv-eval/src/cli/args.ts";
import type { AuthMode, PolicyName } from "../packages/dv-eval/src/smoke/runner.ts";

const POLICIES: readonly PolicyName[] = ["single", "ladder", "architect-editor"];
const AUTH_FLAG_TO_MODE: Record<string, AuthMode> = {
	faux: "offline-faux",
	subscription: "subscription",
	"api-key": "api-key",
};

const args = parseArgs(process.argv.slice(2));
const text = (name: string): string | undefined => {
	const value = args.get(name);
	return typeof value === "string" ? value : undefined;
};
const positive = (name: string, fallback: number | undefined): number | undefined => {
	const raw = text(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} deve ser um número positivo: ${raw}`);
	return value;
};

const tier = text("tier") ?? "all";
if (tier !== "all" && !(TIERS as readonly string[]).includes(tier)) {
	throw new Error(`--tier deve ser all ou um de: ${TIERS.join(", ")}`);
}
const policyList = (text("policies") ?? "single,ladder,architect-editor").split(",").map((p) => p.trim());
for (const policy of policyList) {
	if (!(POLICIES as readonly string[]).includes(policy)) {
		throw new Error(`política desconhecida em --policies: ${policy} (use ${POLICIES.join(", ")})`);
	}
}
const authFlag = text("auth-mode") ?? "faux";
const authMode = AUTH_FLAG_TO_MODE[authFlag];
if (authMode === undefined) throw new Error("--auth-mode deve ser faux, subscription ou api-key");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const maxTokens = positive("max-tokens", undefined);

const options: BenchOptions = {
	corpusDir: resolve(text("corpus") ?? "packages/dv-eval/corpus"),
	tier: tier as Tier | "all",
	...(text("task") === undefined ? {} : { task: text("task") }),
	policies: policyList as PolicyName[],
	authMode,
	...(text("model") === undefined ? {} : { model: text("model") }),
	...(text("escalation-model") === undefined ? {} : { escalationModel: text("escalation-model") }),
	...(maxTokens === undefined ? {} : { maxTokens }),
	maxCostUsd: positive("max-cost", 0.05) ?? 0.05,
	outdir: resolve(text("outdir") ?? `runs/bench-${stamp}`),
	probesDir: resolve("packages/dv-eval/probe-results"),
	contractPath: resolve(CONTRACT_PATH),
};

try {
	const report = await runBench(options);
	console.log(`ok: ${report.runs.length} run(s). Relatório: ${options.outdir}/summary.md`);
	for (const row of report.rows) {
		console.log(
			`${row.policy.padEnd(16)} ${String(row.tier).padEnd(7)} solved ${row.solved}/${row.runs}  tokens ${row.tokens_total}  telemetria ${row.telemetry_status}  v4 ${row.conformance_v4}`,
		);
	}
} catch (error) {
	if (error instanceof ConformanceFailure) {
		console.error(`FALHA: ${error.message}. Detalhes em ${options.outdir}/summary.md`);
		for (const v of error.violations) console.error(`- ${v.run}: ${v.violations.join("; ")}`);
		process.exitCode = 2;
	} else {
		throw error;
	}
}
