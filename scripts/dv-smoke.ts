// Smoke end-to-end: node scripts/dv-smoke.ts --policy single|ladder|architect-editor [--auth-mode offline-faux|api-key]
//   [--model provider/modelId] [--escalation-model provider/modelId] [--outdir DIR] [--task DIR] [--max-cost USD]
// Padrões: auth-mode offline-faux (sem rede), task packages/dv-eval/tasks/calc-basic, outdir runs/smoke-<política>-<ts>.
import { resolve } from "node:path";
import { type AuthMode, type PolicyName, runSmoke } from "../packages/dv-eval/src/smoke/runner.ts";
import { parseArgs } from "./args.ts";

const POLICIES: readonly PolicyName[] = ["single", "ladder", "architect-editor"];
const AUTH_MODES: readonly AuthMode[] = ["offline-faux", "api-key"];

const args = parseArgs(process.argv.slice(2));
const policy = String(args.get("policy") ?? "");
const authMode = String(args.get("auth-mode") ?? "offline-faux");
if (!(POLICIES as readonly string[]).includes(policy)) {
	throw new Error(`--policy deve ser um de: ${POLICIES.join(", ")}`);
}
if (!(AUTH_MODES as readonly string[]).includes(authMode)) {
	throw new Error(`--auth-mode deve ser um de: ${AUTH_MODES.join(", ")}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const summary = await runSmoke({
	taskDir: resolve(String(args.get("task") ?? "packages/dv-eval/tasks/calc-basic")),
	policy: policy as PolicyName,
	authMode: authMode as AuthMode,
	model: typeof args.get("model") === "string" ? String(args.get("model")) : undefined,
	escalationModel: typeof args.get("escalation-model") === "string" ? String(args.get("escalation-model")) : undefined,
	outdir: resolve(String(args.get("outdir") ?? `runs/smoke-${policy}-${stamp}`)),
	maxCostUsd: Number(args.get("max-cost") ?? 0.05),
	probesDir: resolve("packages/dv-eval/probe-results"),
});
console.log(
	JSON.stringify(
		{
			final_outcome: summary.final_outcome,
			steps: summary.steps.map((s) => ({
				step: s.step,
				role: s.role,
				model: s.model,
				verdict: s.oracle?.verdict ?? null,
			})),
			blocked_reason: summary.blocked_reason,
		},
		null,
		2,
	),
);
process.exitCode = summary.final_outcome === "solved" ? 0 : 1;
