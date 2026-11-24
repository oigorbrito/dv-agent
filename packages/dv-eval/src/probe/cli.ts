// CLI do probe de provedor: `npm run probe:providers` (offline, sem rede), ou com --live para chamadas reais:
//   npm run probe:providers -- --live --provider anthropic --model <id> --auth-mode subscription
//   npm run probe:providers -- --live --provider P --model M --auth-mode api-key   (usa variável de ambiente)
import { resolve } from "node:path";
import { resolveAuthPath } from "../auth/subscription.ts";
import { parseArgs } from "../cli/args.ts";
import {
	AGY_PROBE_DEFAULT_MAX_TOKENS,
	AGY_PROBE_DEFAULT_MODEL,
	AGY_PROBE_MAX_TURNS,
	runAgyProbe,
} from "./agy_probe.ts";
import { loadApprovedProbes, runLiveProbe, runOfflineProbe, writeProbeResult } from "./provider_probe.ts";

const PROBES_DIR = resolve(import.meta.dirname, "../../probe-results");
const args = parseArgs(process.argv.slice(2));

if (args.get("provider") === "agy") {
	if (!args.has("live")) throw new Error("agy só roda com --live (chamada real ao agy)");
	if ((args.get("auth-mode") ?? "subscription") !== "subscription")
		throw new Error("agy usa o login local: --auth-mode subscription");
	const modelArg = args.get("model");
	const turnsArg = args.get("turns") ?? "1";
	const turns = Number(turnsArg);
	if (!Number.isInteger(turns) || turns < 1 || turns > AGY_PROBE_MAX_TURNS) {
		throw new Error(`--turns deve ser inteiro entre 1 e ${AGY_PROBE_MAX_TURNS}`);
	}
	const result = await runAgyProbe({
		modelId: typeof modelArg === "string" ? modelArg : AGY_PROBE_DEFAULT_MODEL,
		turns,
		maxTokens: Number(args.get("max-tokens") ?? AGY_PROBE_DEFAULT_MAX_TOKENS),
		cwd: process.cwd(),
		timeoutMs: 300_000,
	});
	const path = writeProbeResult(PROBES_DIR, "agy", result);
	console.log(
		JSON.stringify(
			{
				provider: "agy",
				status: result.status,
				reasons: result.reasons,
				semantics: result.semantics?.status ?? null,
				file: path,
			},
			null,
			2,
		),
	);
	process.exitCode = result.status === "VERIFIED" ? 0 : 2;
} else if (args.has("live")) {
	const provider = args.get("provider");
	const model = args.get("model");
	const authMode = args.get("auth-mode") ?? "api-key";
	if (typeof provider !== "string" || typeof model !== "string") throw new Error("--live exige --provider e --model");
	if (authMode !== "api-key" && authMode !== "subscription")
		throw new Error("--auth-mode deve ser api-key ou subscription");
	const authPath = typeof args.get("auth-file") === "string" ? String(args.get("auth-file")) : resolveAuthPath();
	const result = await runLiveProbe({ provider, modelId: model, authMode, authPath });
	const path = writeProbeResult(PROBES_DIR, provider, result);
	console.log(
		JSON.stringify(
			{ provider, auth_mode: authMode, status: result.status, reasons: result.reasons, file: path },
			null,
			2,
		),
	);
	process.exitCode = result.status === "VERIFIED" ? 0 : 2;
} else {
	if (args.has("auth-mode")) throw new Error("--auth-mode só se aplica com --live");
	const result = await runOfflineProbe();
	const path = writeProbeResult(PROBES_DIR, "offline-shape", result);
	const violations = [
		...result.transport_table_violations,
		...result.usage_shape_violations,
		...result.cache_semantics.violations,
	];
	console.log(
		JSON.stringify(
			{ status: result.status, violations, approved_providers: [...loadApprovedProbes(PROBES_DIR)], file: path },
			null,
			2,
		),
	);
	process.exitCode = result.status === "OFFLINE_SHAPE_CHECKED" ? 0 : 1;
}
