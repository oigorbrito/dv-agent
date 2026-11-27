// Compactação intra-degrau por porte de modelo: regra pura, calibração monotônica e efeito no contexto real (faux).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { COMPACTION_RULES, compactToolResults, modelClassOf, truncateText } from "../src/guards/compaction.ts";
import { checkLedgerConformance, executeRung } from "../src/index.ts";
import { fauxRuntime, priceBookFor, tempDir, textTurn, toolTurn, usage } from "./support.ts";

const toolResult = (text: string, id = "t") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

test("porte: modelos econômicos, padrão e fronteira pelo identificador", () => {
	assert.equal(modelClassOf("claude-haiku-5-5"), "economy");
	assert.equal(modelClassOf("gemini-3.8-flash-low"), "economy");
	assert.equal(modelClassOf("claude-sonnet-4-6"), "standard");
	assert.equal(modelClassOf("gemini-3.8-flash-medium"), "standard");
	assert.equal(modelClassOf("claude-opus-4-6-thinking"), "frontier");
	assert.equal(modelClassOf("gemini-3.8-flash-high"), "frontier");
	assert.equal(modelClassOf("dv-cheap"), "standard", "desconhecido cai no padrão, não no extremo");
});

test("truncateText: mantém início e fim, marca o número de caracteres omitidos, respeita o limite", () => {
	const text = `${"A".repeat(1000)}${"B".repeat(1000)}`;
	const out = truncateText(text, 100);
	assert.ok(out.startsWith("A".repeat(70)), "início preservado (70%)");
	assert.ok(out.endsWith("B".repeat(30)), "fim preservado (30%)");
	assert.match(out, /\[\.\.\. 1900 caracteres omitidos pela compactação \.\.\.\]/);
	assert.equal(truncateText("curto", 100), "curto");
});

test("compactToolResults: só as saídas antigas acima do limite mudam; as recentes ficam intactas", () => {
	const messages = [
		{ role: "user", content: "x", timestamp: 0 },
		toolResult("A".repeat(10000), "old1"),
		{ role: "assistant", content: [], timestamp: 0 },
		toolResult("B".repeat(10000), "old2"),
		toolResult("C".repeat(10000), "recent"),
	];
	const before = JSON.stringify(messages);
	const { messages: out, stats } = compactToolResults(messages, {
		keepRecentToolResults: 1,
		maxCharsPerOlderResult: 1000,
	});
	assert.equal(JSON.stringify(messages), before, "entrada não é mutada");
	assert.equal(stats.truncated, 2);
	assert.ok((out[1] as { content: { text: string }[] }).content[0]?.text.length < 1100);
	assert.ok((out[3] as { content: { text: string }[] }).content[0]?.text.length < 1100);
	assert.equal(out[4], messages[4], "saída recente é a mesma referência");
	assert.equal(out[0], messages[0]);
	assert.ok(stats.charsAfter < stats.charsBefore);
});

test("compactToolResults: sem nada acima do limite, devolve as mesmas mensagens", () => {
	const messages = [toolResult("pequeno", "a"), toolResult("também", "b")];
	const { messages: out, stats } = compactToolResults(messages, {
		keepRecentToolResults: 0,
		maxCharsPerOlderResult: 100,
	});
	assert.equal(stats.truncated, 0);
	assert.equal(out[0], messages[0]);
	assert.equal(out[1], messages[1]);
});

test("compactToolResults: partes que não são texto (imagem) não são tocadas", () => {
	const image = { type: "image", data: "Z".repeat(5000), mimeType: "image/png" };
	const message = {
		role: "toolResult",
		toolCallId: "i",
		toolName: "shot",
		content: [image],
		isError: false,
		timestamp: 0,
	};
	const { messages: out, stats } = compactToolResults([message, toolResult("x", "y")], {
		keepRecentToolResults: 1,
		maxCharsPerOlderResult: 10,
	});
	assert.equal(stats.truncated, 0);
	assert.deepEqual((out[0] as { content: unknown[] }).content, [image]);
});

test("calibração monotônica: econômico preserva mais que padrão, que preserva mais que fronteira", () => {
	const messages = Array.from({ length: 10 }, (_, i) => toolResult("S".repeat(6000 + i), `t${i}`));
	const kept = (cls: "economy" | "standard" | "frontier") =>
		compactToolResults(messages, COMPACTION_RULES[cls]).stats.charsAfter;
	const economy = kept("economy");
	const standard = kept("standard");
	const frontier = kept("frontier");
	assert.ok(
		economy >= standard && standard >= frontier,
		`economy=${economy} standard=${standard} frontier=${frontier}`,
	);
	assert.ok(economy > frontier, "a diferença de porte é efetiva neste caso");
});

test("efeito no contexto real: fronteira com compaction by_model envia contexto menor ao modelo; off preserva o contexto", async () => {
	const bigOutput = "linha de log com muito texto repetido ".repeat(600); // ~22 mil caracteres por saída

	async function run(compaction: "off" | "by_model") {
		const runtime = fauxRuntime("anthropic", ["dv-opus"]);
		const contexts: { role: string; content: unknown }[][] = [];
		const spy = (model: unknown, context: { messages: { role: string; content: unknown }[] }, opts: unknown) => {
			contexts.push(context.messages.map((m) => ({ role: m.role, content: m.content })));
			return (runtime.streamFn as unknown as (...a: unknown[]) => unknown)(model, context, opts);
		};
		const tool: AgentTool = {
			name: "read",
			label: "read",
			description: "Lê um arquivo do workspace.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			execute: async () => ({ content: [{ type: "text", text: bigOutput }], details: {} }),
		};
		runtime.script([
			...Array.from({ length: 5 }, (_, i) =>
				toolTurn("read", { path: `f${i}.txt` }, usage(100, 10, { reasoning: 0 }), `c${i}`),
			),
			textTurn("pronto", usage(100, 10, { reasoning: 0 })),
		]);
		const ledgerPath = join(tempDir(`compact-${compaction}`), "ledger.jsonl");
		const result = await executeRung({
			ledgerPath,
			runId: `compact-${compaction}`,
			harnessVariant: "b0_compaction",
			referenceProvenance: { harness: "dv-core" },
			datasetSha256: "c".repeat(64),
			taskDefinitionSha256: "d".repeat(64),
			model: runtime.modelOf("dv-opus"),
			tools: [tool],
			prompt: "leia os arquivos",
			streamFn: spy as never,
			priceBook: priceBookFor(["anthropic/dv-opus"]),
			maxCostUsd: 10,
			doomLoopMaxIdenticalConsecutive: 10,
			compaction,
		});
		const last = contexts.at(-1) ?? [];
		const toolTexts = last
			.filter((m) => m.role === "toolResult")
			.map((m) => (m.content as { text: string }[]).map((c) => c.text).join(""));
		const ledger = readFileSync(ledgerPath, "utf8");
		return { status: result.status, toolTexts, ledger, report: checkLedgerConformance(ledgerPath) };
	}

	const off = await run("off");
	const on = await run("by_model");
	assert.equal(off.status, "completed");
	assert.equal(on.status, "completed");
	assert.equal(off.toolTexts.length, 5);
	assert.ok(
		off.toolTexts.every((t) => t.length === bigOutput.length),
		"off: contexto intacto",
	);
	assert.equal(on.toolTexts.length, 5);
	// Fronteira: mantém 3 recentes intactas; as 2 antigas caem para o limite de 1500 caracteres.
	assert.equal(
		on.toolTexts.slice(-3).every((t) => t.length === bigOutput.length),
		true,
	);
	assert.equal(
		on.toolTexts.slice(0, 2).every((t) => t.length < 1600),
		true,
	);
	assert.match(on.ledger, /"harness_variant":"b0_compaction\+compaction:frontier"/);
	assert.equal(off.report.status === "FAIL", false, off.report.violations.join("; "));
	assert.equal(on.report.status === "FAIL", false, on.report.violations.join("; "));
});
