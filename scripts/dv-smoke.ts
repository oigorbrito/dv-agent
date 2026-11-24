// Smoke end-to-end. Exemplos:
//   node scripts/dv-smoke.ts --policy single                                   (offline, sem rede)
//   node scripts/dv-smoke.ts --policy ladder --auth-mode subscription --ladder-models anthropic/<id>,anthropic/<id2>
//   node scripts/dv-smoke.ts --policy single --auth-mode api-key --model openai/<id>
//   node scripts/dv-smoke.ts --policy predictive-harness-router --routing-history runs/train/summary.json --routing-history-partition calibration
// Opções: --policy single|ladder|architect-editor  --auth-mode offline-faux|api-key|subscription
//   --model provider/modelId  --escalation-model provider/modelId  --ladder-models modelo,...  --auth-file CAMINHO  --outdir DIR
//   --task DIR  --max-cost USD
import { resolve } from "node:path";
import { formatTokenCount } from "../packages/dv-eval/src/bench/report.ts";
import { parseArgs } from "../packages/dv-eval/src/cli/args.ts";
import { type AuthMode, type PolicyName, runSmoke } from "../packages/dv-eval/src/smoke/runner.ts";

const POLICIES: readonly PolicyName[] = ["single", "ladder", "architect-editor", "predictive-harness-router"];
const AUTH_MODES: readonly string[] = ["offline-faux", "faux", "api-key", "subscription"];

const args = parseArgs(process.argv.slice(2), undefined, ["routing-history"]);
const text = (name: string): string | undefined => {
	const value = args.get(name);
	if (value === true) throw new Error(`--${name} exige um valor`);
	return typeof value === "string" ? value : undefined;
};
const policy = text("policy") ?? "";
const requestedAuthMode = text("auth-mode") ?? "offline-faux";
const authMode = requestedAuthMode === "faux" ? "offline-faux" : requestedAuthMode;
if (!(POLICIES as readonly string[]).includes(policy)) {
	throw new Error(`--policy deve ser um de: ${POLICIES.join(", ")}`);
}
if (!(AUTH_MODES as readonly string[]).includes(authMode)) {
	throw new Error(`--auth-mode deve ser um de: ${AUTH_MODES.join(", ")}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const summary = await runSmoke({
	taskDir: resolve(text("task") ?? resolve(import.meta.dirname, "../packages/dv-eval/tasks/calc-basic")),
	policy: policy as PolicyName,
	authMode: authMode as AuthMode,
	model: text("model"),
	escalationModel: text("escalation-model"),
	ladderModels: text("ladder-models")
		?.split(",")
		.map((model) => model.trim())
		.filter(Boolean),
	routingHistory: text("routing-history")
		?.split("\u0000")
		.map((path) => resolve(path)),
	routingHistoryPartition: text("routing-history-partition") as "calibration" | "train" | undefined,
	authPath: text("auth-file") === undefined ? undefined : resolve(text("auth-file") ?? ""),
	outdir: resolve(text("outdir") ?? `runs/smoke-${policy}-${stamp}`),
	maxCostUsd: Number(text("max-cost") ?? 0.05),
	probesDir: resolve(import.meta.dirname, "../packages/dv-eval/probe-results"),
});
console.log(
	JSON.stringify(
		{
			final_outcome: summary.final_outcome,
			blocked_reason: summary.blocked_reason,
			steps: summary.steps.map((s) => ({
				step: s.step,
				role: s.role,
				model: s.model,
				verdict: s.oracle?.verdict ?? null,
				tokens: formatTokenCount(s.total_tokens, s.telemetry_complete ? "MEASURED" : "UNVERIFIABLE"),
				spent_lower_bound_usd: s.spent_lower_bound_usd,
				run_status: s.run_status,
			})),
		},
		null,
		2,
	),
);
process.exitCode = summary.final_outcome === "solved" ? 0 : 1;
