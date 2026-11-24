// Smoke end-to-end. Exemplos:
//   node scripts/dv-smoke.ts --policy single                                   (offline, sem rede)
//   node scripts/dv-smoke.ts --policy ladder --auth-mode subscription --ladder-models anthropic/<id>,anthropic/<id2>
//   node scripts/dv-smoke.ts --policy single --auth-mode api-key --model openai/<id>
// Opções: --policy single|ladder|architect-editor  --auth-mode offline-faux|api-key|subscription
//   --model provider/modelId  --escalation-model provider/modelId  --ladder-models modelo,...  --auth-file CAMINHO  --outdir DIR
//   --task DIR  --max-cost USD
import { resolve } from "node:path";
import { parseArgs } from "../packages/dv-eval/src/cli/args.ts";
import { type AuthMode, type PolicyName, runSmoke } from "../packages/dv-eval/src/smoke/runner.ts";

const POLICIES: readonly PolicyName[] = ["single", "ladder", "architect-editor", "predictive-harness-router"];
const AUTH_MODES: readonly AuthMode[] = ["offline-faux", "api-key", "subscription"];

const args = parseArgs(process.argv.slice(2));
const text = (name: string): string | undefined => {
	const value = args.get(name);
	return typeof value === "string" ? value : undefined;
};
const policy = text("policy") ?? "";
const authMode = text("auth-mode") ?? "offline-faux";
if (!(POLICIES as readonly string[]).includes(policy)) {
	throw new Error(`--policy deve ser um de: ${POLICIES.join(", ")}`);
}
if (!(AUTH_MODES as readonly string[]).includes(authMode)) {
	throw new Error(`--auth-mode deve ser um de: ${AUTH_MODES.join(", ")}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const summary = await runSmoke({
	taskDir: resolve(text("task") ?? "packages/dv-eval/tasks/calc-basic"),
	policy: policy as PolicyName,
	authMode: authMode as AuthMode,
	model: text("model"),
	escalationModel: text("escalation-model"),
	ladderModels: text("ladder-models")
		?.split(",")
		.map((model) => model.trim())
		.filter(Boolean),
	authPath: text("auth-file") === undefined ? undefined : resolve(text("auth-file") ?? ""),
	outdir: resolve(text("outdir") ?? `runs/smoke-${policy}-${stamp}`),
	maxCostUsd: Number(text("max-cost") ?? 0.05),
	probesDir: resolve("packages/dv-eval/probe-results"),
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
				spent_lower_bound_usd: s.spent_lower_bound_usd,
				run_status: s.run_status,
			})),
		},
		null,
		2,
	),
);
process.exitCode = summary.final_outcome === "solved" ? 0 : 1;
