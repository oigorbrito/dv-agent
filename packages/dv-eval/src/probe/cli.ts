// CLI do probe de provedor: `npm run probe:providers` (offline, sem rede) ou `-- --live --provider P --model M`.
import { resolve } from "node:path";
import { loadApprovedProbes, runLiveProbe, runOfflineProbe, writeProbeResult } from "./provider_probe.ts";

const PROBES_DIR = resolve(import.meta.dirname, "../../probe-results");

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv.includes("--live")) {
	const provider = argValue("provider");
	const model = argValue("model");
	if (provider === undefined || model === undefined) throw new Error("--live exige --provider e --model");
	const result = await runLiveProbe(provider, model);
	const path = writeProbeResult(PROBES_DIR, provider, result);
	console.log(JSON.stringify({ provider, status: result.status, reasons: result.reasons, file: path }, null, 2));
	process.exitCode = result.status === "VERIFIED" ? 0 : 2;
} else {
	const result = await runOfflineProbe();
	const path = writeProbeResult(PROBES_DIR, "offline-shape", result);
	console.log(
		JSON.stringify(
			{
				status: result.status,
				violations: [
					...result.transport_table_violations,
					...result.usage_shape_violations,
					...result.cache_semantics.violations,
				],
				approved_providers: [...loadApprovedProbes(PROBES_DIR)],
				file: path,
			},
			null,
			2,
		),
	);
	process.exitCode = result.status === "OFFLINE_SHAPE_CHECKED" ? 0 : 1;
}
