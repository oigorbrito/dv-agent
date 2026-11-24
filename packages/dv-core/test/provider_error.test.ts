// Registra corpos de erro do provedor sem segredos e mantém a falha classificada como provider_error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { executeRung } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, usage } from "./support.ts";

test("erro HTTP 503 é sanitizado no ledger e termina como provider_error", async () => {
	const runtime = fauxRuntime("anthropic", ["provider-error"]);
	const secret = "AIzaSyD123456789012345678901234567890";
	runtime.script([
		{
			message: fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: JSON.stringify({
					error: { code: 503, message: `model overloaded; api_key=${secret}` },
				}),
			}),
			usage: usage(20, 0),
		},
	]);
	const ledgerPath = join(tempDir("provider-error"), "ledger.jsonl");
	const result = await executeRung({
		ledgerPath,
		runId: "provider-error-503",
		harnessVariant: "provider-error-test",
		referenceProvenance: { test: "provider-error" },
		datasetSha256: "a".repeat(64),
		taskDefinitionSha256: "b".repeat(64),
		model: runtime.modelOf("provider-error"),
		tools: [],
		prompt: "offline fixture",
		streamFn: runtime.streamFn,
		priceBook: priceBookFor(["anthropic/provider-error"]),
		maxCostUsd: 1,
		doomLoopMaxIdenticalConsecutive: 3,
	});
	const records = readFileSync(ledgerPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const finishedCall = records.find((record) => record.event === "call_finished") as
		| { record: { error_message?: string } }
		| undefined;

	assert.equal(result.status, "provider_error");
	assert.match(finishedCall?.record.error_message ?? "", /model overloaded/);
	assert.ok(!finishedCall?.record.error_message?.includes(secret));
});
