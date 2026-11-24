import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	assembleScaffold,
	checkLedgerConformance,
	classifyModelTier,
	FAN_PLANNING_DIRECTIVE,
	FRONTIER_BASH_SYSTEM_PROMPT,
} from "@dv-agent/core";
import { findPackageRoot } from "../src/package_paths.ts";
import { parseLadderModel, parseModelRef, runSmoke } from "../src/smoke/runner.ts";

const REPO_ROOT = findPackageRoot(import.meta.dirname);
const CONTRACT_V4_PATH = join(REPO_ROOT, "contracts/run-accounting-contract-v4.json");
const CONTRACT_V5_PATH = join(REPO_ROOT, "contracts/run-accounting-contract-v5.json");

const EXPECTED_V4_SHA256 = "11b4d5453e0964a7eb88decb5cbf7d1c5f5eebf4fbbdd458fb4e38686baef486";
const EXPECTED_V5_SHA256 = "5029e770865a8fdf6c70f1dad9283ff06d8bb6012018d613eb77a2363c3820ad";

function sha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

test("integridade contratual: contracts v4 e v5 permanecem 100% intocados", () => {
	assert.equal(sha256(CONTRACT_V4_PATH), EXPECTED_V4_SHA256, "contract v4 preservado");
	assert.equal(sha256(CONTRACT_V5_PATH), EXPECTED_V5_SHA256, "contract v5 preservado");
});

test("parser: suporta opcionalmente :low, :medium, :high, :xhigh e preserva padrão", () => {
	// Padrão sem esforço
	const standard = parseModelRef("anthropic/claude-haiku-5-5");
	assert.equal(standard.provider, "anthropic");
	assert.equal(standard.modelId, "claude-haiku-5-5");
	assert.equal(standard.reasoningEffort, undefined);

	// Com níveis suportados
	const low = parseModelRef("anthropic/claude-haiku-5-5:low");
	assert.equal(low.provider, "anthropic");
	assert.equal(low.modelId, "claude-haiku-5-5");
	assert.equal(low.reasoningEffort, "low");

	const medium = parseModelRef("anthropic/claude-sonnet-4-6:medium");
	assert.equal(medium.provider, "anthropic");
	assert.equal(medium.modelId, "claude-sonnet-4-6");
	assert.equal(medium.reasoningEffort, "medium");

	const high = parseModelRef("anthropic/claude-sonnet-4-6:high");
	assert.equal(high.provider, "anthropic");
	assert.equal(high.modelId, "claude-sonnet-4-6");
	assert.equal(high.reasoningEffort, "high");

	const xhigh = parseModelRef("openai/o3-mini:xhigh");
	assert.equal(xhigh.provider, "openai");
	assert.equal(xhigh.modelId, "o3-mini");
	assert.equal(xhigh.reasoningEffort, "xhigh");

	// Aliases com esforço
	const aliasLow = parseLadderModel("haiku 5.5:low");
	assert.equal(aliasLow.provider, "anthropic");
	assert.equal(aliasLow.modelId, "claude-haiku-5-5");
	assert.equal(aliasLow.reasoningEffort, "low");

	const aliasHigh = parseLadderModel("sonnet 5.5:high");
	assert.equal(aliasHigh.provider, "anthropic");
	assert.equal(aliasHigh.modelId, "claude-sonnet-5-5");
	assert.equal(aliasHigh.reasoningEffort, "high");

	// Erro em esforço inválido
	assert.throws(() => parseModelRef("anthropic/claude-haiku-5-5:turbo"), /effort inválido/);
	assert.throws(() => parseLadderModel("haiku 5.5:extreme"), /effort inválido/);
});

test("classificação de porte: identifica degraus leves e fronteira conforme padrões", () => {
	// Leves
	assert.equal(classifyModelTier("claude-haiku-5-5"), "light");
	assert.equal(classifyModelTier("gemini-2.5-flash"), "light");
	assert.equal(classifyModelTier("gpt-4o-mini"), "light");
	assert.equal(classifyModelTier("luna-base"), "light");
	assert.equal(classifyModelTier("faux-cheap"), "light");

	// Fronteira
	assert.equal(classifyModelTier("claude-sonnet-4-6"), "frontier");
	assert.equal(classifyModelTier("claude-opus-5-5"), "frontier");
	assert.equal(classifyModelTier("gemini-3.8-terra"), "frontier");
	assert.equal(classifyModelTier("astra-coder-1"), "frontier");
	assert.equal(classifyModelTier("faux-strong"), "frontier");
});

test("scaffold: uniform fornece 4 ferramentas e prompt padrão para todos os portes", () => {
	const ws = mkdtempSync(join(tmpdir(), "dv-scaffold-uniform-"));
	try {
		const light = assembleScaffold({ workspaceRoot: ws, modelId: "claude-haiku-5-5", scaffoldMode: "uniform" });
		assert.equal(light.tools.length, 4);
		assert.deepEqual(light.tools.map((t) => t.name).sort(), ["edit_file", "read_file", "run_bash", "write_file"]);
		assert.doesNotMatch(light.systemPrompt, new RegExp(FAN_PLANNING_DIRECTIVE));

		const frontier = assembleScaffold({ workspaceRoot: ws, modelId: "claude-sonnet-4-6", scaffoldMode: "uniform" });
		assert.equal(frontier.tools.length, 4);
		assert.deepEqual(frontier.tools.map((t) => t.name).sort(), ["edit_file", "read_file", "run_bash", "write_file"]);
		assert.doesNotMatch(frontier.systemPrompt, new RegExp(FAN_PLANNING_DIRECTIVE));
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("scaffold: adaptive alterna entre kit completo com diretriz (leves) e bash-only (fronteira)", () => {
	const ws = mkdtempSync(join(tmpdir(), "dv-scaffold-adaptive-"));
	try {
		const light = assembleScaffold({ workspaceRoot: ws, modelId: "claude-haiku-5-5", scaffoldMode: "adaptive" });
		assert.equal(light.tools.length, 4);
		assert.deepEqual(light.tools.map((t) => t.name).sort(), ["edit_file", "read_file", "run_bash", "write_file"]);
		assert.match(light.systemPrompt, new RegExp(FAN_PLANNING_DIRECTIVE));

		const frontier = assembleScaffold({
			workspaceRoot: ws,
			modelId: "claude-sonnet-4-6",
			scaffoldMode: "adaptive",
		});
		assert.equal(frontier.tools.length, 1);
		assert.equal(frontier.tools[0]?.name, "run_bash");
		assert.equal(frontier.systemPrompt, FRONTIER_BASH_SYSTEM_PROMPT);
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("integração offline: escada faux com esforço laddering registra reasoning_effort no summary e ledgers conformes", async () => {
	const outdir = mkdtempSync(join(tmpdir(), "dv-test-effort-ladder-"));
	try {
		const summary = await runSmoke({
			taskDir: resolve(REPO_ROOT, "packages/dv-eval/tasks/calc-basic"),
			policy: "ladder",
			authMode: "offline-faux",
			ladderModels: ["anthropic/claude-haiku-5-5:low", "anthropic/claude-sonnet-4-6:high"],
			scaffoldMode: "uniform",
			outdir,
			maxCostUsd: 0.1,
			probesDir: resolve(REPO_ROOT, "packages/dv-eval/probe-results"),
		});

		assert.equal(summary.final_outcome, "solved");
		assert.equal(summary.scaffold_mode, "uniform");
		assert.equal(summary.steps.length, 2);

		// Degrau 0: Haiku com :low
		assert.equal(summary.steps[0]?.rung, 0);
		assert.equal(summary.steps[0]?.reasoning_effort, "low");

		// Degrau 1: Sonnet com :high
		assert.equal(summary.steps[1]?.rung, 1);
		assert.equal(summary.steps[1]?.reasoning_effort, "high");

		// Checa conformidade dos ledgers gravados
		for (const step of summary.steps) {
			const report = checkLedgerConformance(step.ledger_path);
			assert.equal(report.status, "PASS", `ledger ${step.ledger_path} conforme`);
		}

		// Checa conteúdo do summary.json gravado no disco
		const diskSummary = JSON.parse(readFileSync(join(outdir, "summary.json"), "utf8")) as typeof summary;
		assert.equal(diskSummary.steps[0]?.reasoning_effort, "low");
		assert.equal(diskSummary.steps[1]?.reasoning_effort, "high");
		assert.equal(diskSummary.scaffold_mode, "uniform");
	} finally {
		rmSync(outdir, { recursive: true, force: true });
	}
});

test("integração offline: scaffold-mode adaptive executa com sucesso e grava scaffold_mode no summary", async () => {
	const outdir = mkdtempSync(join(tmpdir(), "dv-test-adaptive-scaffold-"));
	try {
		const summary = await runSmoke({
			taskDir: resolve(REPO_ROOT, "packages/dv-eval/tasks/calc-basic"),
			policy: "ladder",
			authMode: "offline-faux",
			ladderModels: ["anthropic/claude-haiku-5-5:medium", "anthropic/claude-sonnet-4-6:high"],
			scaffoldMode: "adaptive",
			outdir,
			maxCostUsd: 0.1,
			probesDir: resolve(REPO_ROOT, "packages/dv-eval/probe-results"),
		});

		assert.equal(summary.final_outcome, "solved");
		assert.equal(summary.scaffold_mode, "adaptive");
		assert.equal(summary.steps.length, 2);
		assert.equal(summary.steps[0]?.reasoning_effort, "medium");
		assert.equal(summary.steps[1]?.reasoning_effort, "high");

		for (const step of summary.steps) {
			const report = checkLedgerConformance(step.ledger_path);
			assert.equal(report.status, "PASS");
		}
	} finally {
		rmSync(outdir, { recursive: true, force: true });
	}
});
