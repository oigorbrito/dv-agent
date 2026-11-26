/**
 * Concrete Harbor bootstrap for DV. Configuration is explicit in controller environment variables;
 * credentials are read by openLiveSession and never copied into the manifest or telemetry.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_SYSTEM_PROMPT, executeRung } from "@dv-agent/core";
import { type LiveAuthMode, openLiveSession } from "../auth/live_session.ts";
import { resolveAuthPath } from "../auth/subscription.ts";
import { loadApprovedProbes } from "../probe/provider_probe.ts";

type RemoteTools = Parameters<typeof executeRung>[0]["tools"];
type EmitTelemetry = (data: {
	runId: string;
	ledgerPath: string;
	ledgerSha256: string;
	provider: string;
	model: string;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheTokens?: number | null;
	costUsd?: number | null;
	complete: boolean;
	runStatus: string;
}) => void;

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`missing required environment variable ${name}`);
	return value;
}

function positiveNumber(name: string, fallback?: number): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return value;
}

function parseObject(name: string, raw: string): Record<string, string> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${name} must be valid JSON`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be a JSON object`);
	}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string" || !item.trim()) throw new Error(`${name} values must be non-empty strings (${key})`);
	}
	return value as Record<string, string>;
}

function sha256(name: string): string {
	const value = required(name);
	if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must be a 64-character SHA-256 hex digest`);
	return value.toLowerCase();
}

/** Called by harbor_bridge_main.ts. One invocation corresponds to one Harbor task trial. */
export async function runDVTask(input: {
	instruction: string;
	tools: RemoteTools;
	emitTelemetry: EmitTelemetry;
}): Promise<void> {
	const modelRef = required("DV_HARBOR_MODEL");
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) {
		throw new Error("DV_HARBOR_MODEL must use provider/modelId format");
	}
	const provider = modelRef.slice(0, slash);
	const modelId = modelRef.slice(slash + 1);
	const authMode = (process.env.DV_HARBOR_AUTH_MODE ?? "api-key") as LiveAuthMode;
	if (authMode !== "api-key" && authMode !== "subscription") {
		throw new Error("DV_HARBOR_AUTH_MODE must be api-key or subscription");
	}

	const probesDir = required("DV_HARBOR_PROBES_DIR");
	const approvedProbes = loadApprovedProbes(probesDir);
	const session = await openLiveSession({
		authMode,
		provider,
		modelId,
		authPath: process.env.DV_AUTH_FILE ?? resolveAuthPath(),
	});

	const runId = required("DV_HARBOR_RUN_ID");
	const ledgerPath = required("DV_HARBOR_LEDGER_PATH");
	const maxCostUsd = positiveNumber("DV_HARBOR_MAX_COST_USD");
	if (maxCostUsd === undefined) throw new Error("DV_HARBOR_MAX_COST_USD is required");
	const referenceProvenance = parseObject("DV_HARBOR_REFERENCE_PROVENANCE", required("DV_HARBOR_REFERENCE_PROVENANCE"));
	const datasetSha256 = sha256("DV_HARBOR_DATASET_SHA256");
	const taskDefinitionSha256 = sha256("DV_HARBOR_TASK_SHA256");
	const maxTotalTokens = positiveNumber("DV_HARBOR_MAX_TOKENS");
	const maxTurns = positiveNumber("DV_HARBOR_MAX_TURNS");
	const maxOutputTokens = positiveNumber("DV_HARBOR_MAX_OUTPUT_TOKENS");
	const doomLoopMaxIdenticalConsecutive = positiveNumber("DV_HARBOR_DOOM_LOOP_LIMIT", 3) ?? 3;
	const reasoningEffort = process.env.DV_HARBOR_REASONING_EFFORT;
	if (reasoningEffort && !["low", "medium", "high", "xhigh"].includes(reasoningEffort)) {
		throw new Error("DV_HARBOR_REASONING_EFFORT must be low, medium, high or xhigh");
	}

	const result = await executeRung({
		ledgerPath,
		runId,
		harnessVariant: process.env.DV_HARBOR_HARNESS_VARIANT ?? "terminal-bench:dv",
		referenceProvenance,
		datasetSha256,
		taskDefinitionSha256,
		model: session.model,
		systemPrompt: DEFAULT_SYSTEM_PROMPT,
		tools: input.tools,
		prompt: input.instruction,
		streamFn: session.streamFn,
		priceBook: session.priceBook,
		maxCostUsd,
		doomLoopMaxIdenticalConsecutive,
		approvedProbes,
		...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
		...(maxTurns === undefined ? {} : { maxTurns }),
		...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
		...(reasoningEffort === undefined
			? {}
			: { reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh" }),
	});

	// The ledger is the source of truth. Do not turn usage omitted by a provider into measured zero.
	const events = readFileSync(result.ledgerPath, "utf8")
		.split("\\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const callTelemetry = events
		.filter((event) => event.event === "call_finished")
		.map((event) => ((event.record as Record<string, unknown>).telemetry ?? {}) as Record<string, unknown>);
	const usageReported = callTelemetry.every((item) => {
		const missing = Array.isArray(item.missing_buckets) ? item.missing_buckets : [];
		return !missing.includes("usage_not_reported") && !missing.includes("usage_incomplete");
	});
	const inputTokens = usageReported
		? callTelemetry.reduce((sum, item) => sum + Number(item.prompt_tokens ?? 0), 0)
		: undefined;
	const outputTokens = usageReported
		? callTelemetry.reduce((sum, item) => sum + Number(item.completion_tokens ?? 0), 0)
		: undefined;
	// Harbor's n_cache_tokens follows its native Pi/Codex accounting: cached reads only.
	// Null means at least one call's transport did not expose cache-read usage.
	const cacheReported = callTelemetry.every((item) => typeof item.cache_read_tokens === "number");
	const cacheTokens = cacheReported
		? callTelemetry.reduce((sum, item) => sum + Number(item.cache_read_tokens), 0)
		: undefined;
	const telemetryComplete = callTelemetry.every((item) => item.telemetry_complete === true);
	input.emitTelemetry({
		runId,
		ledgerPath: result.ledgerPath,
		ledgerSha256: result.ledgerSha256,
		provider,
		model: modelId,
		inputTokens,
		outputTokens,
		cacheTokens,
		costUsd: result.ceilingStatus === "within_verified" ? result.spentLowerBoundUsd : null,
		complete: telemetryComplete,
		runStatus: result.status,
	});
}
