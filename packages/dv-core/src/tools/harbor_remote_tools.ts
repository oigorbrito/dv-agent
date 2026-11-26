import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

type ToolName = "run_bash" | "read_file" | "write_file" | "edit_file";
type Pending = {
	resolve: (value: AgentToolResult<Record<string, unknown>>) => void;
	reject: (error: Error) => void;
};

const pending = new Map<string, Pending>();
let inputStarted = false;
let closed = false;

/** Create tools whose executions are dispatched to the Harbor task environment over JSONL stdio. */
export function createHarborRemoteWorkspaceTools(): AgentTool[] {
	startProtocolReader();
	return [
		tool(
			"run_bash",
			"Run a non-interactive command in the Harbor task workspace.",
			{
				command: { type: "string" },
				timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
			},
			["command"],
		),
		tool(
			"read_file",
			"Read a UTF-8 file from the Harbor task workspace.",
			{
				path: { type: "string" },
				offset: { type: "integer", minimum: 1 },
				limit: { type: "integer", minimum: 1 },
			},
			["path"],
		),
		tool(
			"write_file",
			"Write a UTF-8 file in the Harbor task workspace.",
			{
				path: { type: "string" },
				content: { type: "string" },
			},
			["path", "content"],
		),
		tool(
			"edit_file",
			"Replace one unique exact text occurrence in a workspace file.",
			{
				path: { type: "string" },
				old_text: { type: "string", minLength: 1 },
				new_text: { type: "string" },
			},
			["path", "old_text", "new_text"],
		),
	];
}

function tool(
	name: ToolName,
	description: string,
	properties: Record<string, Record<string, unknown>>,
	required: string[],
): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: { type: "object", properties, required },
		execute: async (_toolCallId, params) => request(name, params as Record<string, unknown>),
	};
}

function startProtocolReader(): void {
	if (inputStarted) return;
	inputStarted = true;
	const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
	reader.on("line", (line) => {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			failAll(new Error("invalid JSONL response from Harbor adapter"));
			return;
		}
		if (frame.type !== "tool_result" || typeof frame.id !== "string") {
			failAll(new Error("unexpected frame from Harbor adapter"));
			return;
		}
		const waiter = pending.get(frame.id);
		if (!waiter) {
			failAll(new Error("unknown or duplicate tool response id"));
			return;
		}
		pending.delete(frame.id);
		if (frame.ok !== true) {
			waiter.resolve(result(String(frame.error ?? "remote tool failed"), true));
			return;
		}
		if (
			typeof frame.stdout !== "string" ||
			typeof frame.stderr !== "string" ||
			!Number.isInteger(frame.exit_code)
		) {
			waiter.reject(new Error("malformed tool_result: stdout, stderr and integer exit_code are required"));
			return;
		}
		const stdout = frame.stdout;
		const stderr = frame.stderr;
		const exitCode = frame.exit_code as number;
		waiter.resolve(
			result(
				[stdout, stderr ? "stderr:\n" + stderr : "", exitCode !== 0 ? "exit_code: " + exitCode : ""]
					.filter(Boolean)
					.join("\n") || "(no output)",
				exitCode !== 0,
				{ exit_code: exitCode },
			),
		);
	});
	reader.on("close", () => {
		closed = true;
		failAll(new Error("Harbor adapter closed its JSONL input"));
	});
}

function request(
	name: ToolName,
	arguments_: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
	if (closed) return Promise.reject(new Error("Harbor bridge is closed"));
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		try {
			process.stdout.write(
				JSON.stringify({
					type: "tool_call",
					id,
					tool: name,
					arguments: arguments_,
				}) + "\n",
				(error) => {
					if (!error) return;
					pending.delete(id);
					reject(error);
				},
			);
		} catch (error) {
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function result(
	text: string,
	isError: boolean,
	details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details, isError };
}

function failAll(error: Error): void {
	for (const waiter of pending.values()) waiter.reject(error);
	pending.clear();
}

/** Emit one telemetry frame after executeRung() has closed its ledger. */
export function emitHarborTelemetry(data: {
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
}): void {
	process.stdout.write(
		JSON.stringify({
			type: "telemetry",
			run_id: data.runId,
			ledger_path: data.ledgerPath,
			ledger_sha256: data.ledgerSha256,
			provider: data.provider,
			model: data.model,
			input_tokens: data.inputTokens ?? null,
			output_tokens: data.outputTokens ?? null,
			cache_tokens: data.cacheTokens ?? null,
			cost_usd: data.costUsd ?? null,
			complete: data.complete,
			run_status: data.runStatus,
		}) + "\n",
	);
}
