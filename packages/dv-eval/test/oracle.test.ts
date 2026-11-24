// Oráculo externo: veredito fora do loop do agente, isolamento da cópia, timeout como NO_VERDICT, e result.json.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
	copyCandidate,
	execVerifier,
	type OracleResult,
	runOracle,
	type SpawnFn,
	verifyOracleIntegrity,
} from "../src/oracle/verifier.ts";

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

/** Processo falso: emite 'error' (ENOENT) para os executáveis listados em `missing`, senão fecha com exit 0. */
function fakeSpawn(missing: string[], calls: string[]): SpawnFn {
	return (command) => {
		calls.push(command);
		const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
		const out = new PassThrough();
		const err = new PassThrough();
		child.stdout = out as unknown as ChildProcess["stdout"];
		child.stderr = err as unknown as ChildProcess["stderr"];
		child.kill = () => true;
		setImmediate(() => {
			if (missing.includes(command)) {
				const failure = Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
				child.emit("error", failure);
				return;
			}
			out.end();
			err.end();
			child.emit("close", 0);
		});
		return child as ChildProcess;
	};
}

test("python ausente (ENOENT) é resolvido para python3", async () => {
	const calls: string[] = [];
	const run = await execVerifier(["python", "check.py"], tmpdir(), tmpdir(), 5_000, fakeSpawn(["python"], calls));
	assert.deepEqual(calls, ["python", "python3"]);
	assert.equal(run.exitCode, 0);
	assert.equal(run.timedOut, false);
});

test("python presente não dispara fallback", async () => {
	const calls: string[] = [];
	const run = await execVerifier(["python", "check.py"], tmpdir(), tmpdir(), 5_000, fakeSpawn([], calls));
	assert.deepEqual(calls, ["python"]);
	assert.equal(run.exitCode, 0);
});

test("ENOENT de outro executável não é remapeado e propaga o erro", async () => {
	const calls: string[] = [];
	await assert.rejects(
		execVerifier(["ruby", "check.rb"], tmpdir(), tmpdir(), 5_000, fakeSpawn(["ruby"], calls)),
		/ENOENT/,
	);
	assert.deepEqual(calls, ["ruby"]);
});

test("python e python3 ausentes propagam ENOENT sem loop", async () => {
	const calls: string[] = [];
	await assert.rejects(
		execVerifier(["python", "check.py"], tmpdir(), tmpdir(), 5_000, fakeSpawn(["python", "python3"], calls)),
		/ENOENT/,
	);
	assert.deepEqual(calls, ["python", "python3"]);
});

test("verifyOracleIntegrity detecta adulteração, remoção e inserção de arquivos de teste", () => {
	const base = [
		{ path: "tests/test_a.py", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
		{ path: "tests/test_b.py", sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
	];

	// Intacto
	const ok = verifyOracleIntegrity(base, [...base]);
	assert.equal(ok.intact, true);
	assert.equal(ok.tamper_detected, false);
	assert.equal(ok.violations.length, 0);

	// Adulterado
	const tampered = verifyOracleIntegrity(base, [
		{ path: "tests/test_a.py", sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
		base[1],
	]);
	assert.equal(tampered.intact, false);
	assert.equal(tampered.tamper_detected, true);
	assert.match(tampered.violations[0], /adulterado/);

	// Removido
	const removed = verifyOracleIntegrity(base, [base[0]]);
	assert.equal(removed.intact, false);
	assert.equal(removed.tamper_detected, true);
	assert.match(removed.violations[0], /removido/);

	// Inserido
	const inserted = verifyOracleIntegrity(base, [
		...base,
		{ path: "tests/malicious.py", sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
	]);
	assert.equal(inserted.intact, false);
	assert.equal(inserted.tamper_detected, true);
	assert.match(inserted.violations[0], /não autorizado/);
});

test("runOracle fail-closed com NO_VERDICT e tamper_detected se expectedOracleHashes divergir", async () => {
	const out = mkdtempSync(join(tmpdir(), "dv-out-tamper-"));
	// Espera um hash forjado que não bate com o oráculo real
	const bogusExpected = [
		{ path: "check.py", sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
	];
	const result = await runOracle({
		taskDir: TASK,
		candidateDir: candidate(CORRECT),
		outdir: out,
		expectedOracleHashes: bogusExpected,
	});

	assert.equal(result.verdict, "NO_VERDICT");
	assert.equal(result.outcome, "INCONCLUSIVE");
	assert.equal(result.oracle_tampered, true);
	assert.equal(result.verification.status, "provider_error");
	assert.equal(result.verification.oracle_pass, null);
	assert.ok((result.tamper_violations?.length ?? 0) > 0);
});
