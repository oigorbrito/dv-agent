// Execução do verificador: o código do agente roda aqui, então não pode herdar credenciais do ambiente do
// processo, e o timeout tem de encerrar também os processos filhos que ainda seguram a saída.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execVerifier } from "../src/oracle/verifier.ts";

const SECRET = "DV_TEST_SECRET_VALUE_123";

test("verificador não herda variáveis sensíveis do ambiente (ex.: chaves de API)", async () => {
	const previous = process.env.DV_TEST_API_KEY;
	process.env.DV_TEST_API_KEY = SECRET;
	try {
		const run = await execVerifier(
			["node", "-e", "process.stdout.write(process.env.DV_TEST_API_KEY ?? 'ausente')"],
			process.cwd(),
			process.cwd(),
			10_000,
		);
		assert.equal(run.exitCode, 0);
		assert.equal(run.stdout, "ausente", "a chave não deve chegar ao código do agente");
	} finally {
		if (previous === undefined) delete process.env.DV_TEST_API_KEY;
		else process.env.DV_TEST_API_KEY = previous;
	}
});

test("verificador mantém PATH para executar o programa do verificador", async () => {
	const run = await execVerifier(
		["node", "-e", "process.stdout.write(process.env.PATH ? 'com-path' : 'sem-path')"],
		process.cwd(),
		process.cwd(),
		10_000,
	);
	assert.equal(run.stdout, "com-path");
});

test("timeout encerra também o processo neto que segura a saída", async () => {
	// O neto herda stdio e fica vivo; sem matar o grupo, o evento close nunca dispara e a execução trava.
	// O neto se encerra sozinho em 20 s para não deixar processo órfão se o teste falhar.
	const grandchild = "setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);";
	const parent =
		`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });` +
		"setInterval(() => {}, 1000);";
	const started = Date.now();
	const run = await Promise.race([
		execVerifier(["node", "-e", parent], process.cwd(), process.cwd(), 500),
		new Promise<"travou">((resolve) => setTimeout(() => resolve("travou"), 8_000)),
	]);
	assert.notEqual(run, "travou", "execução não encerrou após o timeout");
	assert.equal(typeof run === "object" && run.timedOut, true);
	assert.ok(Date.now() - started < 8_000);
});
