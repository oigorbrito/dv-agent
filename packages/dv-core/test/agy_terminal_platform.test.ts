// Terminal do agy por plataforma: opção detached e plano de encerramento (ramo win32 coberto offline, em qualquer SO).
import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalDetached, terminationPlan } from "../src/providers/agy/acp_workspace.ts";

test("win32: terminal não é detached (sem grupo de processos por pid negativo)", () => {
	assert.equal(terminalDetached("win32"), false);
	assert.equal(terminalDetached("linux"), true);
	assert.equal(terminalDetached("darwin"), true);
});

test("win32: encerramento usa taskkill /T /F na árvore do pid, nunca kill de grupo", () => {
	assert.deepEqual(terminationPlan("win32", 4242), {
		kind: "taskkill",
		args: ["/pid", "4242", "/T", "/F"],
	});
});

test("não-win32: encerramento mata o grupo de processos (pid negativo)", () => {
	assert.deepEqual(terminationPlan("linux", 4242), { kind: "process_group", pid: 4242 });
	assert.deepEqual(terminationPlan("darwin", 7), { kind: "process_group", pid: 7 });
});

test("sem pid: cai para kill direto do filho, em qualquer plataforma", () => {
	assert.deepEqual(terminationPlan("win32", undefined), { kind: "child_kill" });
	assert.deepEqual(terminationPlan("linux", undefined), { kind: "child_kill" });
});
