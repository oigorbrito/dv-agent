// Benchmark de ablação (single x ladder x architect-editor) sobre o corpus calibrado. Exemplos:
//   node scripts/dv-bench.ts --policies single,ladder --auth-mode faux
//   node scripts/dv-bench.ts --tier hard --task hard-02-wal-ledger-replay --policies single,ladder --auth-mode faux
//   node scripts/dv-bench.ts --policies single,ladder --auth-mode api-key --model openai/<id> --escalation-model openai/<id2>
// Opções: --corpus DIR (padrão packages/dv-eval/corpus)  --tier all|easy|medium|hard|negative  --task ID
//   --tasks ID1,ID2,... (lista explícita; exclusiva com --task; IDs inexistentes ou de tier errado são erro)
//   Flag desconhecida, repetida ou sem valor é erro (nenhuma flag é ignorada em silêncio).
//   --policies single,ladder,architect-editor,predictive-harness-router  --auth-mode faux|subscription|api-key
//   --model provider/modelId (degrau 0 / editor)  --escalation-model provider/modelId (degrau 1 / architect)
//   --ladder-models ref1,ref2,... (escada mista com qualquer quantidade de degraus)
//   --routing-history summary.json (repetível, só com --policies predictive-harness-router)
//   --routing-history-partition calibration|train (obrigatória quando há routing history)
//   --max-tokens N (teto de tokens por execução, somado entre degraus; obrigatório em subscription)  --max-cost USD (padrão 0.05)
//   --editor-max-turns N  --editor-max-output-tokens N (tetos do papel editor; padrão EDITOR_LIMITS)
//   --repeats N (réplicas independentes por célula, em rep-0..rep-N-1; padrão 1)  --temperature T (>= 0; só vai a modelos que suportam)
//   --outdir DIR (padrão runs/bench-<timestamp>)
// Códigos de saída: 0 ok (inclusive INCONCLUSIVE por teto não verificável); 1 erro de uso ou execução;
// 2 violação estrutural de conformidade v4 (relatório gravado mesmo assim).
import { resolve } from "node:path";
import {
	type BenchOptions,
	CONTRACT_PATH,
	ConformanceFailure,
	runBench,
} from "../packages/dv-eval/src/bench/ablation.ts";
import { CORPUS_TIERS, type CorpusTier } from "../packages/dv-eval/src/bench/corpus.ts";
import { formatTokenCount } from "../packages/dv-eval/src/bench/report.ts";
import { parseArgs } from "../packages/dv-eval/src/cli/args.ts";
import { type AuthMode, EDITOR_LIMITS, type PolicyName } from "../packages/dv-eval/src/smoke/runner.ts";

const POLICIES: readonly PolicyName[] = ["single", "ladder", "architect-editor", "predictive-harness-router"];
const AUTH_FLAG_TO_MODE: Record<string, AuthMode> = {
	faux: "offline-faux",
	subscription: "subscription",
	"api-key": "api-key",
};

// Flags aceitas. Qualquer outra (inclusive typo) é erro: nenhuma flag é ignorada em silêncio.
const ALLOWED_FLAGS = [
	"tier",
	"task",
	"tasks",
	"policies",
	"auth-mode",
	"model",
	"escalation-model",
	"ladder-models",
	"routing-history",
	"routing-history-partition",
	"max-tokens",
	"max-cost",
	"editor-max-turns",
	"editor-max-output-tokens",
	"repeats",
	"temperature",
	"outdir",
	"corpus",
];
function fail(message: string): never {
	console.error(`erro: ${message}`);
	process.exit(1);
}
let args: Map<string, string | true>;
try {
	args = parseArgs(process.argv.slice(2), ALLOWED_FLAGS, ["routing-history"]);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
const text = (name: string): string | undefined => {
	const value = args.get(name);
	if (value === true) fail(`--${name} exige um valor`);
	return value;
};
const positive = (name: string, fallback: number | undefined): number | undefined => {
	const raw = text(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} deve ser um número positivo: ${raw}`);
	return value;
};

// --tasks: lista separada por vírgula. Valida formato aqui; existência e tier são validados em selectTasks.
const tasksText = text("tasks");
const tasks = tasksText === undefined ? undefined : tasksText.split(",").map((id) => id.trim());
if (tasks !== undefined && text("task") !== undefined) fail("use --task ou --tasks, não os dois");

const tier = text("tier") ?? "all";
if (tier !== "all" && !(CORPUS_TIERS as readonly string[]).includes(tier)) {
	throw new Error("--tier deve ser all, easy, medium, hard ou negative");
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
const editorTurns = positive("editor-max-turns", undefined);
const editorOutput = positive("editor-max-output-tokens", undefined);
const repeats = positive("repeats", undefined);
const temperatureText = text("temperature");
const temperature = temperatureText === undefined ? undefined : Number(temperatureText);
if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0)) {
	throw new Error(`--temperature deve ser um número >= 0: ${temperatureText}`);
}

const options: BenchOptions = {
	corpusDir: resolve(text("corpus") ?? resolve(import.meta.dirname, "../packages/dv-eval/corpus")),
	tier: tier as CorpusTier | "all",
	...(text("task") === undefined ? {} : { task: text("task") }),
	...(tasks === undefined ? {} : { tasks }),
	policies: policyList as PolicyName[],
	authMode,
	...(text("model") === undefined ? {} : { model: text("model") }),
	...(text("escalation-model") === undefined ? {} : { escalationModel: text("escalation-model") }),
	...(text("ladder-models") === undefined
		? {}
		: {
				ladderModels: text("ladder-models")!
					.split(",")
					.map((model) => model.trim())
					.filter(Boolean),
			}),
	...(text("routing-history") === undefined
		? {}
		: {
				routingHistory: text("routing-history")!
					.split("\u0000")
					.map((path) => resolve(path)),
			}),
	...(text("routing-history-partition") === undefined
		? {}
		: { routingHistoryPartition: text("routing-history-partition") as "calibration" | "train" }),
	...(maxTokens === undefined ? {} : { maxTokens }),
	...(repeats === undefined ? {} : { repeats }),
	...(temperature === undefined ? {} : { temperature }),
	...(editorTurns === undefined && editorOutput === undefined
		? {}
		: {
				editorLimits: {
					maxTurns: editorTurns ?? EDITOR_LIMITS.maxTurns,
					maxOutputTokens: editorOutput ?? EDITOR_LIMITS.maxOutputTokens,
				},
			}),
	maxCostUsd: positive("max-cost", 0.05) ?? 0.05,
	outdir: resolve(text("outdir") ?? `runs/bench-${stamp}`),
	probesDir: resolve(import.meta.dirname, "../packages/dv-eval/probe-results"),
	contractPath: resolve(import.meta.dirname, `../${CONTRACT_PATH}`),
};

try {
	const report = await runBench(options);
	console.log(`ok: ${report.runs.length} run(s). Relatório: ${options.outdir}/summary.md`);
	for (const row of report.rows) {
		console.log(
			`${row.policy.padEnd(16)} ${String(row.tier).padEnd(7)} solved ${row.solved}/${row.runs}  tokens ${formatTokenCount(row.tokens_total, row.telemetry_status)}  teto ${row.ceiling_status}  telemetria ${row.telemetry_status}  v4 ${row.conformance_v4}`,
		);
	}
} catch (error) {
	if (error instanceof ConformanceFailure) {
		console.error(`FALHA: ${error.message}. Detalhes em ${options.outdir}/summary.md`);
		for (const v of error.violations) console.error(`- ${v.run}: ${v.violations.join("; ")}`);
		process.exitCode = 2;
	} else {
		// Erro de uso ou governança (ex.: subscription sem --max-tokens, outdir não vazio): mensagem limpa, sem stack.
		console.error(`erro: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
