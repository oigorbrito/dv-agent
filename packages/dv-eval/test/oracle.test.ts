// Oráculo externo: veredito fora do loop do agente, isolamento da cópia, timeout como NO_VERDICT, e result.json.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { copyCandidate, type OracleResult, runOracle } from "../src/oracle/verifier.ts";

const TASK = resolve(import.meta.dirname, "../tasks/calc-basic");

function candidate(calcBody: string): string {
	const dir = mkdtempSync(join(tmpdir(), "dv-cand-"));
	writeFileSync(join(dir, "calc.py"), calcBody);
	writeFileSync(join(dir, "SPEC.md"), "# SPEC\n");
	return dir;
}

const CORRECT =
	"def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n\ndef safe_div(a, b):\n    return None if b == 0 else a / b\n";
const WRONG = CORRECT.replace("return a + b", "return a + b + 1");

test("PASS: candidato correto gera result.json com SOLVED e verificação pass", async () => {
	const out = mkdtempSync(join(tmpdir(), "dv-out-"));
	const result = await runOracle({ taskDir: TASK, candidateDir: candidate(CORRECT), outdir: out });
	assert.equal(result.verdict, "PASS");
	assert.equal(result.outcome, "SOLVED");
	assert.deepEqual(result.verification, { oracle_pass: true, status: "pass" });
	const written = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as OracleResult;
	assert.equal(written.schema, "dv-oracle-result-v1");
	assert.equal(written.outcome, "SOLVED");
	assert.ok(written.candidate.files.some((f) => f.path === "calc.py"));
	assert.match(written.oracle.sha256, /^[0-9a-f]{64}$/);
});

test("FAIL: candidato errado gera FAILURE e verificação fail, com saída do verificador", async () => {
	const out = mkdtempSync(join(tmpdir(), "dv-out-"));
	const result = await runOracle({ taskDir: TASK, candidateDir: candidate(WRONG), outdir: out });
	assert.equal(result.verdict, "FAIL");
	assert.equal(result.outcome, "FAILURE");
	assert.deepEqual(result.verification, { oracle_pass: false, status: "fail" });
	assert.match(result.stdout_tail, /FAIL add/);
});

test("o verificador vem da tarefa: um check.py plantado no workspace não altera o veredito", async () => {
	const cand = candidate(WRONG);
	writeFileSync(join(cand, "check.py"), "import sys\nprint('PASS forjado')\nsys.exit(0)\n");
	const result = await runOracle({ taskDir: TASK, candidateDir: cand, outdir: mkdtempSync(join(tmpdir(), "dv-out-")) });
	assert.equal(result.verdict, "FAIL");
});

test("cópia do oráculo não leva symlink nem bytecode do workspace do agente", (t) => {
	const cand = candidate(CORRECT);
	const outside = mkdtempSync(join(tmpdir(), "dv-outside-"));
	writeFileSync(join(outside, "secret.txt"), "x");
	try {
		symlinkSync(outside, join(cand, "link"), "junction");
	} catch {
		t.skip("junction indisponível");
	}
	mkdirSync(join(cand, "__pycache__"));
	writeFileSync(join(cand, "__pycache__", "calc.cpython-312.pyc"), "bytes");
	writeFileSync(join(cand, "mod.pyc"), "bytes");
	const dst = join(mkdtempSync(join(tmpdir(), "dv-copy-")), "work");
	copyCandidate(cand, dst);
	assert.equal(existsSync(join(dst, "link")), false);
	assert.equal(existsSync(join(dst, "__pycache__")), false);
	assert.equal(existsSync(join(dst, "mod.pyc")), false);
	assert.equal(existsSync(join(dst, "calc.py")), true);
});

test("timeout do verificador é NO_VERDICT / INCONCLUSIVE, não FAIL", async () => {
	const task = mkdtempSync(join(tmpdir(), "dv-slow-task-"));
	mkdirSync(join(task, "oracle"));
	writeFileSync(join(task, "oracle", "check.py"), "import time\ntime.sleep(30)\n");
	writeFileSync(
		join(task, "task.json"),
		JSON.stringify({
			schema: "dv-eval-task-v1",
			id: "slow",
			prompt: "x",
			workspace_dir: "workspace",
			oracle: { dir: "oracle", command: ["python", "check.py"], timeout_ms: 800 },
		}),
	);
	cpSync(join(TASK, "workspace"), join(task, "workspace"), { recursive: true });
	const started = Date.now();
	const result = await runOracle({
		taskDir: task,
		candidateDir: candidate(CORRECT),
		outdir: mkdtempSync(join(tmpdir(), "dv-out-")),
	});
	assert.equal(result.verdict, "NO_VERDICT");
	assert.equal(result.outcome, "INCONCLUSIVE");
	assert.equal(result.timed_out, true);
	assert.deepEqual(result.verification, { oracle_pass: null, status: "timeout" });
	assert.ok(Date.now() - started < 20_000);
});
