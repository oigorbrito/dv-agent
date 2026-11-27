// Testes offline do modo interativo/tarefa padrão, detecção de auth, config e checagem de versão npm.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkNpmUpdateNonBlocking,
	detectDefaultAuth,
	formatReplHelp,
	loadDvUserConfig,
} from "../../../src/interactive.ts";

test("loadDvUserConfig: lê ~/.dv/config.json e ignora política inválida", () => {
	const home = mkdtempSync(join(tmpdir(), "dv-home-"));
	try {
		assert.deepEqual(loadDvUserConfig(home), {});
		mkdirSync(join(home, ".dv"), { recursive: true });
		writeFileSync(
			join(home, ".dv", "config.json"),
			JSON.stringify({ model: "anthropic/claude-sonnet-4-5", policy: "ladder", maxTokens: 150000 }),
		);
		assert.deepEqual(loadDvUserConfig(home), {
			model: "anthropic/claude-sonnet-4-5",
			policy: "ladder",
			maxTokens: 150000,
		});
		writeFileSync(join(home, ".dv", "config.json"), JSON.stringify({ policy: "invalida", maxTokens: -1 }));
		assert.deepEqual(loadDvUserConfig(home), {});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("detectDefaultAuth: detecta auth.json oauth, fallback de env e null quando vazio", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-detect-auth-"));
	const authFile = join(dir, "auth.json");
	try {
		assert.equal(await detectDefaultAuth({ DV_AUTH_FILE: authFile }), null);

		const envOnly = await detectDefaultAuth({ DV_AUTH_FILE: authFile, ANTHROPIC_API_KEY: "sk-ant-test" });
		assert.equal(envOnly?.provider, "anthropic");
		assert.equal(envOnly?.authMode, "api-key");

		writeFileSync(
			authFile,
			JSON.stringify({
				anthropic: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
			}),
		);
		const oauth = await detectDefaultAuth({ DV_AUTH_FILE: authFile });
		assert.equal(oauth?.provider, "anthropic");
		assert.equal(oauth?.authMode, "subscription");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("checkNpmUpdateNonBlocking: retorna nova versão ou null sem falhar offline", async () => {
	const newer = await checkNpmUpdateNonBlocking(
		"0.0.2",
		async () => new Response(JSON.stringify({ version: "0.0.3" }), { status: 200 }),
	);
	assert.equal(newer, "0.0.3");

	const same = await checkNpmUpdateNonBlocking(
		"0.0.2",
		async () => new Response(JSON.stringify({ version: "0.0.2" }), { status: 200 }),
	);
	assert.equal(same, null);

	const offline = await checkNpmUpdateNonBlocking("0.0.2", async () => {
		throw new Error("ENOTFOUND");
	});
	assert.equal(offline, null);
});

test("formatReplHelp: inclui todos os comandos de barra esperados", () => {
	const help = formatReplHelp();
	for (const cmd of ["/help", "/model", "/policy", "/tokens", "/login", "/exit"]) {
		assert.ok(help.includes(cmd), `faltando ${cmd}`);
	}
});
