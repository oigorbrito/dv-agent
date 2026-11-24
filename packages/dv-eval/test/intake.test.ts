// Testes offline do módulo de intake e gate de integridade de tarefas externas.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	computeStableFileSha256,
	type ExternalTaskDefinition,
	validateTaskIntake,
	validateTasksBatch,
} from "../src/intake/index.ts";
import { applyUnifiedDiff } from "../src/intake/patch_applier.ts";

function createMockTask(
	baseDir: string,
	opts: {
		id: string;
		workspaceFiles: Record<string, string>;
		oracleCheckPy: string;
		oracleInsideWorkspace?: boolean;
		referencePatch?: string;
		goldPatchFileLocation?: "task-root" | "workspace";
		includeGitInWorkspace?: boolean;
	},
): string {
	const taskDir = join(baseDir, opts.id);
	const wsDir = join(taskDir, "workspace");
	const oracleDir = opts.oracleInsideWorkspace ? join(wsDir, "oracle") : join(taskDir, "oracle");

	mkdirSync(wsDir, { recursive: true });
	mkdirSync(oracleDir, { recursive: true });

	for (const [rel, content] of Object.entries(opts.workspaceFiles)) {
		const full = join(wsDir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
	}

	writeFileSync(join(oracleDir, "check.py"), opts.oracleCheckPy, "utf8");

	if (opts.includeGitInWorkspace) {
		mkdirSync(join(wsDir, ".git"));
		writeFileSync(join(wsDir, ".git", "config"), "[core]\n", "utf8");
	}

	if (opts.referencePatch) {
		const targetDir = opts.goldPatchFileLocation === "workspace" ? wsDir : taskDir;
		writeFileSync(join(targetDir, "solution.patch"), opts.referencePatch, "utf8");
	}

	const taskJson: ExternalTaskDefinition = {
		schema: "dv-eval-task-v1",
		id: opts.id,
		prompt: "Corrija a função add em calc.py",
		workspace_dir: "workspace",
		oracle: {
			dir: opts.oracleInsideWorkspace ? "workspace/oracle" : "oracle",
			command: ["python", "check.py"],
			timeout_ms: 5000,
		},
		...(opts.referencePatch && opts.goldPatchFileLocation !== "workspace" ? { reference_patch: "solution.patch" } : {}),
	};

	writeFileSync(join(taskDir, "task.json"), `${JSON.stringify(taskJson, null, 2)}\n`, "utf8");
	return taskDir;
}

const BROKEN_CALC = "def add(a, b):\n    return a - b\n";
const PASSING_CHECK_PY = `import sys
try:
    import calc
    if calc.add(2, 3) == 5:
        print("PASS")
        sys.exit(0)
    else:
        print("FAIL add")
        sys.exit(1)
except Exception as e:
    print("FAIL:", e)
    sys.exit(1)
`;

const VALID_PATCH = `--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b
+    return a + b
`;

const WRONG_PATCH = `--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b
+    return a + b + 99
`;

test("coleta e deduplicação determinística via --offline-fixture", () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-test-"));
	try {
		const fixturePath = join(tmp, "fixture.json");
		const findingsDocPath = join(tmp, "FINDINGS.md");
		const queueDir = join(tmp, "queue");
		mkdirSync(queueDir, { recursive: true });

		// Documento base com itens conhecidos
		writeFileSync(findingsDocPath, "# Achados\n\n| ID | Referência |\n|---|---|\n| F1 | arXiv:2609.20804 |\n", "utf8");

		const fixtureData = {
			items: [
				{
					id: "arXiv:2609.20804",
					canonical_url: "https://arxiv.org/abs/2609.20804",
					title: "Paper já registrado",
					authors: ["Author A"],
					published_at: "2026-09-17",
					summary: "Resumo",
					source: "arxiv",
					query: "coding agents",
				},
				{
					id: "arXiv:2611.99999",
					canonical_url: "https://arxiv.org/abs/2611.99999",
					title: "Paper novo e relevante",
					authors: ["Author B"],
					published_at: "2026-11-20",
					summary: "Resumo novo",
					source: "arxiv",
					query: "harness",
				},
				{
					// Duplicata do novo dentro do mesmo lote
					id: "arXiv:2611.99999",
					canonical_url: "https://arxiv.org/abs/2611.99999",
					title: "Paper novo repetido",
					authors: ["Author B"],
					published_at: "2026-11-20",
					summary: "Resumo novo",
					source: "arxiv",
					query: "harness",
				},
			],
		};
		writeFileSync(fixturePath, JSON.stringify(fixtureData), "utf8");

		// Executa scripts/dv-ingest-studies.ts em modo fixture
		const scriptPath = join(import.meta.dirname, "../../../scripts/dv-ingest-studies.ts");
		execFileSync(
			process.execPath,
			[
				scriptPath,
				"--offline-fixture",
				fixturePath,
				"--findings-doc",
				findingsDocPath,
				"--outdir",
				queueDir,
				"--run-gate",
				"false",
			],
			{ stdio: "pipe" },
		);

		const today = new Date().toISOString().slice(0, 10);
		const intakeReportPath = join(queueDir, `intake-${today}.json`);
		const report = JSON.parse(readFileSync(intakeReportPath, "utf8"));

		assert.equal(report.schema, "dv-external-intake-v1");
		assert.equal(report.mode, "offline-fixture");
		// items é o conjunto único do dia; a contagem bruta de cada execução fica em runs[].
		assert.equal(report.total_items, 2, "duplicata dentro do lote não entra duas vezes no dia");
		assert.equal(report.runs[0].items_fetched, 3);
		assert.equal(report.new_items_count, 1, "Apenas o paper novo não repetido deve ser contabilizado como novo");
		assert.equal(report.runs[0].run_new_items_count, 1);
		assert.equal(report.gate_report, undefined, "--run-gate false deve realmente desativar o gate");

		assert.equal(report.items[0].is_duplicate, true, "Item existente no FINDINGS.md deve ser deduplicado");
		assert.equal(report.items[1].is_duplicate, false, "Item inédito não é duplicado");

		const updatedDoc = readFileSync(findingsDocPath, "utf8");
		assert.ok(updatedDoc.includes("<!-- BEGIN:AUTO-INGEST -->"));
		assert.ok(updatedDoc.includes("<!-- END:AUTO-INGEST -->"));
		assert.ok(updatedDoc.includes("arXiv:2609.20804"), "Seções manuais anteriores preservadas");
		assert.ok(updatedDoc.includes("arXiv:2611.99999"), "Novo item refletido na tabela");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("rejeição automática (fail-closed) de tarefa externa com .git no workspace (GIT_LEAK_DETECTED)", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-git-"));
	try {
		const taskDir = createMockTask(tmp, {
			id: "task-git-leak",
			workspaceFiles: { "calc.py": BROKEN_CALC },
			oracleCheckPy: PASSING_CHECK_PY,
			includeGitInWorkspace: true,
		});

		const result = await validateTaskIntake(taskDir);
		assert.equal(result.ok, false);
		assert.ok(
			result.gate_errors.some((e) => e.startsWith("GIT_LEAK_DETECTED")),
			`Esperado GIT_LEAK_DETECTED, obtido: ${result.gate_errors.join("; ")}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("rejeição automática (fail-closed) de tarefa com gold.patch no workspace (SOLUTION_LEAK_DETECTED)", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-sol-"));
	try {
		const taskDir = createMockTask(tmp, {
			id: "task-sol-leak",
			workspaceFiles: {
				"calc.py": BROKEN_CALC,
				"gold.patch": VALID_PATCH,
			},
			oracleCheckPy: PASSING_CHECK_PY,
		});

		const result = await validateTaskIntake(taskDir);
		assert.equal(result.ok, false);
		assert.ok(
			result.gate_errors.some((e) => e.startsWith("SOLUTION_LEAK_DETECTED")),
			`Esperado SOLUTION_LEAK_DETECTED, obtido: ${result.gate_errors.join("; ")}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("rejeita todos os nomes de patch de referência dentro do workspace", async () => {
	for (const name of ["solution.patch", "reference.patch", "reference_patch"]) {
		const tmp = mkdtempSync(join(tmpdir(), "dv-intake-patch-leak-"));
		try {
			const taskDir = createMockTask(tmp, {
				id: `task-${name.replaceAll(".", "-")}`,
				workspaceFiles: { "calc.py": BROKEN_CALC, [name]: VALID_PATCH },
				oracleCheckPy: PASSING_CHECK_PY,
			});
			const result = await validateTaskIntake(taskDir);
			assert.equal(result.ok, false, `${name} deve ser rejeitado`);
			assert.ok(result.gate_errors.some((error) => error.startsWith("SOLUTION_LEAK_DETECTED")));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
});

test("aplicador de patch rejeita traversal e contexto que não corresponde", () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-patch-apply-"));
	try {
		writeFileSync(join(tmp, "calc.py"), BROKEN_CALC, "utf8");
		assert.throws(
			() => applyUnifiedDiff("--- a/../../outside.py\n+++ b/../../outside.py\n@@ -1 +1 @@\n-a\n+b\n", tmp),
			/path traversal/,
		);
		assert.throws(
			() =>
				applyUnifiedDiff(
					"--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return not-the-original\n+    return 0\n",
					tmp,
				),
			/contexto do hunk não confere/i,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("rejeição automática (fail-closed) de tarefa com oráculo vazado dentro do workspace (ORACLE_PATH_LEAK)", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-oracle-"));
	try {
		const taskDir = createMockTask(tmp, {
			id: "task-oracle-leak",
			workspaceFiles: { "calc.py": BROKEN_CALC },
			oracleCheckPy: PASSING_CHECK_PY,
			oracleInsideWorkspace: true,
		});

		const result = await validateTaskIntake(taskDir);
		assert.equal(result.ok, false);
		assert.ok(
			result.gate_errors.some((e) => e.startsWith("ORACLE_PATH_LEAK")),
			`Esperado ORACLE_PATH_LEAK, obtido: ${result.gate_errors.join("; ")}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("rejeição automática (fail-closed) quando o oráculo aprova estado inicial sem patch (PRE_PATCH_ORACLE_PASSED)", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-prepass-"));
	try {
		// Workspace já correto antes de qualquer patch
		const taskDir = createMockTask(tmp, {
			id: "task-pre-passed",
			workspaceFiles: { "calc.py": "def add(a, b):\n    return a + b\n" },
			oracleCheckPy: PASSING_CHECK_PY,
		});

		const result = await validateTaskIntake(taskDir);
		assert.equal(result.ok, false);
		assert.ok(
			result.gate_errors.some((e) => e.startsWith("PRE_PATCH_ORACLE_PASSED")),
			`Esperado PRE_PATCH_ORACLE_PASSED, obtido: ${result.gate_errors.join("; ")}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("rejeição automática (fail-closed) quando o patch de referência não passa no oráculo (GOLD_PATCH_FAILED)", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-goldfail-"));
	try {
		const taskDir = createMockTask(tmp, {
			id: "task-gold-fail",
			workspaceFiles: { "calc.py": BROKEN_CALC },
			oracleCheckPy: PASSING_CHECK_PY,
			referencePatch: WRONG_PATCH,
			goldPatchFileLocation: "task-root",
		});

		const result = await validateTaskIntake(taskDir);
		assert.equal(result.ok, false);
		assert.ok(
			result.gate_errors.some((e) => e.startsWith("GOLD_PATCH_FAILED")),
			`Esperado GOLD_PATCH_FAILED, obtido: ${result.gate_errors.join("; ")}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("aprovação e geração de dataset_sha256 estável (CRLF vs. LF) para tarefa externa limpa", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-clean-"));
	try {
		// Cria versão LF
		const taskDirLf = createMockTask(tmp, {
			id: "clean-task-lf",
			workspaceFiles: { "calc.py": "def add(a, b):\n    return a - b\n" },
			oracleCheckPy: PASSING_CHECK_PY.replace(/\r\n/g, "\n"),
			referencePatch: VALID_PATCH.replace(/\r\n/g, "\n"),
			goldPatchFileLocation: "task-root",
		});

		// Cria versão idêntica mas gravada com quebras de linha Windows CRLF
		const taskDirCrlf = createMockTask(tmp, {
			id: "clean-task-crlf",
			workspaceFiles: { "calc.py": "def add(a, b):\r\n    return a - b\r\n" },
			oracleCheckPy: PASSING_CHECK_PY.replace(/\n/g, "\r\n"),
			referencePatch: VALID_PATCH.replace(/\n/g, "\r\n"),
			goldPatchFileLocation: "task-root",
		});

		const resultLf = await validateTaskIntake(taskDirLf);
		assert.equal(resultLf.ok, true, `Falha em clean task LF: ${resultLf.gate_errors.join("; ")}`);
		assert.ok(resultLf.dry_run_conformance?.v4_ok, "Conformidade v4 deve ser PASS");
		assert.ok(resultLf.dry_run_conformance?.v5_ok, "Conformidade v5 deve ser PASS");
		assert.ok(resultLf.manifest_entry);

		const resultCrlf = await validateTaskIntake(taskDirCrlf);
		assert.equal(resultCrlf.ok, true, `Falha em clean task CRLF: ${resultCrlf.gate_errors.join("; ")}`);
		assert.ok(resultCrlf.manifest_entry);

		// Os arquivos de conteúdo normalizado devem produzir o mesmo sha256
		const shaCalcLf = computeStableFileSha256(join(taskDirLf, "workspace", "calc.py"));
		const shaCalcCrlf = computeStableFileSha256(join(taskDirCrlf, "workspace", "calc.py"));
		assert.equal(shaCalcLf, shaCalcCrlf, "Hash estável de calc.py deve ser idêntico sob LF e CRLF");

		// Validação do lote batch com ordenação por (task_id, manifest_sha256) e dataset_sha256
		const batchOut = join(tmp, "batch-out");
		const batchResult = await validateTasksBatch(tmp, batchOut);
		assert.equal(batchResult.ok, true);
		assert.equal(batchResult.tasks.length, 2);
		assert.match(batchResult.dataset_sha256, /^[0-9a-f]{64}$/);

		const writtenManifest = JSON.parse(readFileSync(batchResult.manifest_path!, "utf8"));
		assert.equal(writtenManifest.schema, "dv-intake-manifest-v1");
		assert.equal(writtenManifest.dataset_sha256, batchResult.dataset_sha256);
		assert.equal(writtenManifest.tasks[0].task_id, "clean-task-crlf");
		assert.equal(writtenManifest.tasks[1].task_id, "clean-task-lf");
		const repeatedBatch = await validateTasksBatch(tmp);
		assert.equal(repeatedBatch.dataset_sha256, batchResult.dataset_sha256, "dataset hash é reprodutível");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("parsers de feed: Atom do arXiv canoniza ID/URL (versão removida) e releases do GitHub geram ID repo#tag", async () => {
	const { parseArxivAtom, parseGitHubReleases } = await import("../../../scripts/dv-ingest-studies.ts");
	const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>feed</title>
  <entry>
    <id>http://arxiv.org/abs/2609.20804v1</id>
    <published>2026-09-17T00:00:00Z</published>
    <title>An Empirical   Study
      of Harness Design</title>
    <summary>Resumo do paper.</summary>
    <author><name>Run-Ze Fan</name></author>
  </entry>
</feed>`;
	const arxiv = parseArxivAtom(atom, "harness");
	assert.equal(arxiv.length, 1);
	assert.equal(arxiv[0]!.id, "arXiv:2609.20804");
	assert.equal(arxiv[0]!.canonical_url, "https://arxiv.org/abs/2609.20804");
	assert.equal(arxiv[0]!.title, "An Empirical Study of Harness Design");
	assert.deepEqual(arxiv[0]!.authors, ["Run-Ze Fan"]);
	assert.equal(arxiv[0]!.source, "arxiv");

	const releases = parseGitHubReleases(
		JSON.stringify([
			{ tag_name: "v1.2.0", name: "Release 1.2", html_url: "https://github.com/a/b/releases/tag/v1.2.0" },
		]),
		"a/b",
	);
	assert.equal(releases[0]!.id, "a/b#v1.2.0");
	assert.equal(releases[0]!.canonical_url, "https://github.com/a/b/releases/tag/v1.2.0");
	assert.deepEqual(parseGitHubReleases("não é json", "a/b"), []);
});

test("atualização delimitada: fixture Atom com versão diferente é deduplicada e marcadores quebrados bloqueiam a escrita", async () => {
	const { updateFindingsDocument } = await import("../../../scripts/dv-ingest-studies.ts");
	const tmp = mkdtempSync(join(tmpdir(), "dv-intake-atom-"));
	try {
		const fixturePath = join(tmp, "feed.xml");
		writeFileSync(
			fixturePath,
			`<feed><entry><id>http://arxiv.org/abs/2609.20804v2</id><title>Já registrado</title><summary>x</summary></entry>` +
				`<entry><id>http://arxiv.org/abs/2612.00001v1</id><title>Novo</title><summary>y</summary></entry></feed>`,
			"utf8",
		);
		const findingsDocPath = join(tmp, "FINDINGS.md");
		writeFileSync(findingsDocPath, "# Achados\n\nF1: arXiv:2609.20804\n", "utf8");
		const queueDir = join(tmp, "queue");
		const scriptPath = join(import.meta.dirname, "../../../scripts/dv-ingest-studies.ts");
		const runIngest = (): void => {
			execFileSync(
				process.execPath,
				[
					scriptPath,
					"--offline-fixture",
					fixturePath,
					"--findings-doc",
					findingsDocPath,
					"--outdir",
					queueDir,
					"--run-gate",
					"false",
				],
				{ stdio: "pipe" },
			);
		};
		runIngest();
		const today = new Date().toISOString().slice(0, 10);
		const report = JSON.parse(readFileSync(join(queueDir, `intake-${today}.json`), "utf8"));
		assert.equal(report.total_items, 2);
		assert.equal(report.new_items_count, 1, "versão v2 do paper já registrado não conta como novo");
		assert.equal(report.items[0].is_duplicate, true);
		assert.equal(report.items[1].is_duplicate, false);

		// Segunda execução: a seção delimitada é substituída, não duplicada.
		runIngest();
		const rerun = JSON.parse(readFileSync(join(queueDir, `intake-${today}.json`), "utf8"));
		assert.equal(rerun.runs.length, 2, "cada execução do dia fica registrada");
		assert.equal(rerun.runs[1].run_new_items_count, 0, "segunda execução idêntica não reporta novos itens");
		assert.equal(rerun.new_items_count, 1, "o lote do dia preserva o novo item da primeira execução");
		assert.equal(rerun.total_items, 2);
		const doc = readFileSync(findingsDocPath, "utf8");
		assert.equal(doc.split("<!-- BEGIN:AUTO-INGEST -->").length - 1, 1);
		assert.equal(doc.split("<!-- END:AUTO-INGEST -->").length - 1, 1);
		assert.ok(doc.includes("Novo (E0/UNTESTED)") || doc.includes("Novo"));

		// Marcadores quebrados: falha explícita e arquivo intocado.
		const broken = "# X\n<!-- BEGIN:AUTO-INGEST -->\nsem fim\n";
		const brokenPath = join(tmp, "BROKEN.md");
		writeFileSync(brokenPath, broken, "utf8");
		assert.throws(() => updateFindingsDocument(brokenPath, [], "0".repeat(64), today), /incompletos/);
		assert.equal(readFileSync(brokenPath, "utf8"), broken, "arquivo com marcadores quebrados não pode ser alterado");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
