// Testes offline do subcomando `dv auth` (login browser/api-key e checagem de sessão para pi-ai e agy).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAuthCliArgs } from "../src/auth/cli.ts";
import { FileCredentialStore } from "../src/auth/file_credential_store.ts";
import { checkAuthSession, loginAuthSession } from "../src/auth/session_auth.ts";

function tempAuthFile(content?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "dv-auth-cli-"));
	const path = join(dir, "auth.json");
	if (content !== undefined) writeFileSync(path, JSON.stringify(content));
	return path;
}

test("parseAuthCliArgs: login browser (padrão), --api-key e check", () => {
	assert.deepEqual(parseAuthCliArgs(["login", "anthropic"]), {
		kind: "login",
		provider: "anthropic",
		mode: "browser",
	});
	assert.deepEqual(parseAuthCliArgs(["login", "anthropic", "--api-key", "--auth-file", "/tmp/a.json"]), {
		kind: "login",
		provider: "anthropic",
		mode: "api-key",
		authPath: "/tmp/a.json",
	});
	assert.deepEqual(parseAuthCliArgs(["check", "--provider", "agy", "--json", "--no-refresh"]), {
		kind: "check",
		provider: "agy",
		json: true,
		refresh: false,
	});
	assert.deepEqual(parseAuthCliArgs(["--help"]), { kind: "help" });
});

test("checkAuthSession (pi-ai): retorna not_ready, ready e invalid conforme auth.json", async () => {
	const emptyPath = tempAuthFile({});
	assert.deepEqual(await checkAuthSession({ provider: "anthropic", authPath: emptyPath, refresh: false }), {
		status: "not_ready",
		provider: "anthropic",
		reason: "credentials_not_configured",
	});

	const oauthPath = tempAuthFile({
		anthropic: {
			type: "oauth",
			access: "tok-access-TESTE",
			refresh: "tok-refresh-TESTE",
			expires: Date.now() + 3_600_000,
		},
	});
	assert.deepEqual(await checkAuthSession({ provider: "anthropic", authPath: oauthPath, refresh: false }), {
		status: "ready",
		provider: "anthropic",
		authType: "oauth",
	});

	const brokenPath = tempAuthFile();
	writeFileSync(brokenPath, "{ invalid");
	assert.deepEqual(await checkAuthSession({ provider: "anthropic", authPath: brokenPath, refresh: false }), {
		status: "invalid",
		provider: "anthropic",
		reason: "invalid_state",
	});

	assert.deepEqual(await checkAuthSession({ provider: "inexistente", authPath: emptyPath, refresh: false }), {
		status: "not_ready",
		provider: "inexistente",
		reason: "provider_not_found",
	});
});

test("checkAuthSession (agy): ready quando ACP abre e not_ready em Authentication required", async () => {
	let closed = false;
	const ok = await checkAuthSession({
		provider: "agy",
		openAgy: async () => ({
			close: async () => {
				closed = true;
			},
		}),
	});
	assert.equal(closed, true);
	assert.deepEqual(ok, { status: "ready", provider: "agy", authType: "local_login" });

	const unauth = await checkAuthSession({
		provider: "agy",
		openAgy: async () => {
			throw new Error("Authentication required");
		},
	});
	assert.equal(unauth.status, "not_ready");
	assert.equal(unauth.provider, "agy");
	assert.match(unauth.reason ?? "", /Authentication required/);
});

test("loginAuthSession: salva api-key em auth.json sem expor segredo e recusa --api-key no agy", async () => {
	const authPath = tempAuthFile({});
	const fakeKey = "sk-ant-TESTE-NAO-REAL";
	const res = await loginAuthSession({
		provider: "anthropic",
		mode: "api-key",
		authPath,
		interaction: {
			signal: new AbortController().signal,
			prompt: async () => fakeKey,
			notify: () => {},
		},
	});
	assert.equal(res.provider, "anthropic");
	assert.equal(res.mode, "api-key");
	assert.doesNotMatch(res.message, /sk-ant-TESTE/);

	const store = new FileCredentialStore(authPath);
	assert.deepEqual(await store.read("anthropic"), { type: "api_key", key: fakeKey });
	assert.match(readFileSync(authPath, "utf8"), /"api_key"/);

	await assert.rejects(loginAuthSession({ provider: "agy", mode: "api-key" }), /login local oficial do próprio agy/);
	const agyReady = await loginAuthSession({
		provider: "agy",
		mode: "browser",
		checkAgy: async () => ({ status: "ready", provider: "agy", authType: "local_login" }),
	});
	assert.match(agyReady.message, /pronta/);
});
