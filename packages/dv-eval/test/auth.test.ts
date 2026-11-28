// Autenticação por assinatura (offline): store de arquivo com lock, exigência de sessão OAuth, e resolução do token
// pelo Models do pi-ai sem variável de ambiente. Nenhum teste faz chamada de rede nem imprime token.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { CredentialFileError, FileCredentialStore } from "../src/auth/file_credential_store.ts";
import { openLiveSession } from "../src/auth/live_session.ts";
import { requireSubscriptionSession, resolveAuthPath, SubscriptionLoginRequired } from "../src/auth/subscription.ts";

const FAKE_ACCESS = "tok-access-TESTE-NAO-REAL";
const FAKE_REFRESH = "tok-refresh-TESTE-NAO-REAL";

function tempAuthFile(content?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "dv-auth-"));
	const path = join(dir, "auth.json");
	if (content !== undefined) writeFileSync(path, JSON.stringify(content));
	return path;
}

function oauthCredential(hoursValid = 1): Credential {
	return { type: "oauth", access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: Date.now() + hoursValid * 3_600_000 };
}

test("store: modify grava uma credencial e preserva as de outros providers", async () => {
	const path = tempAuthFile({ deepseek: { type: "api_key", key: "outra" } });
	const store = new FileCredentialStore(path);
	await store.modify("anthropic", async () => oauthCredential());
	assert.equal((await store.read("anthropic"))?.type, "oauth");
	assert.equal((await store.read("deepseek"))?.type, "api_key");
	assert.deepEqual((await store.list()).map((c) => c.providerId).sort(), ["anthropic", "deepseek"]);
	await store.delete("deepseek");
	assert.equal(await store.read("deepseek"), undefined);
	assert.equal((await store.read("anthropic"))?.type, "oauth");
});

test("store: auth.json ilegível lança e não é sobrescrito", async () => {
	const path = tempAuthFile();
	writeFileSync(path, "{ não é json");
	const store = new FileCredentialStore(path);
	await assert.rejects(
		store.modify("anthropic", async () => oauthCredential()),
		CredentialFileError,
	);
	assert.equal(readFileSync(path, "utf8"), "{ não é json", "conteúdo original intacto");
});

test("store: modify concorrente é serializado (sem perda de atualização)", async () => {
	const path = tempAuthFile({ anthropic: { type: "api_key", key: "0" } });
	const store = new FileCredentialStore(path);
	const bump = () =>
		store.modify("anthropic", async (current) => {
			const count = Number(current?.type === "api_key" ? current.key : "0") + 1;
			await new Promise((r) => setTimeout(r, 5));
			return { type: "api_key", key: String(count) };
		});
	await Promise.all(Array.from({ length: 8 }, bump));
	assert.deepEqual(await store.read("anthropic"), { type: "api_key", key: "8" });
});

test("store: lock abandonado (mais velho que o limite) é removido e a escrita prossegue", async () => {
	const path = tempAuthFile({});
	const lockDir = `${path}.lock`;
	mkdirSync(lockDir);
	const old = new Date(Date.now() - 3 * 60_000);
	utimesSync(lockDir, old, old);
	const store = new FileCredentialStore(path);
	await store.modify("anthropic", async () => oauthCredential());
	assert.equal((await store.read("anthropic"))?.type, "oauth");
});

test("requireSubscriptionSession: sem sessão, instrui o login sem expor segredo", async () => {
	const store = new FileCredentialStore(tempAuthFile({}));
	const error = await requireSubscriptionSession(store, anthropicProvider()).catch((e: unknown) => e);
	assert.ok(error instanceof SubscriptionLoginRequired);
	assert.match(error.message, /npx @earendil-works\/pi-ai@1\.7\.0 login anthropic/);
	assert.match(error.message, /DV_AUTH_FILE/);
	assert.doesNotMatch(error.message, /tok-/);
});

test("requireSubscriptionSession: credencial api_key não serve como assinatura", async () => {
	const store = new FileCredentialStore(tempAuthFile({ anthropic: { type: "api_key", key: "sk-ant-TESTE" } }));
	await assert.rejects(requireSubscriptionSession(store, anthropicProvider()), /é api_key, não sessão de assinatura/);
});

test("requireSubscriptionSession: provedor sem OAuth de assinatura é recusado", async () => {
	const store = new FileCredentialStore(tempAuthFile({ deepseek: oauthCredential() }));
	await assert.rejects(
		requireSubscriptionSession(store, deepseekProvider()),
		/não oferece autenticação por assinatura/,
	);
});

test("Models do pi-ai usa o token de assinatura guardado, sem nenhuma variável de ambiente de API key", async () => {
	const path = tempAuthFile({ anthropic: oauthCredential() });
	const store = new FileCredentialStore(path);
	const models = createModels({ credentials: store });
	models.setProvider(anthropicProvider());
	const saved = { ...process.env };
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_OAUTH_TOKEN;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	try {
		const resolved = await models.getAuth("anthropic");
		assert.equal(resolved?.auth.apiKey, FAKE_ACCESS, "token da sessão é o que a requisição usa");
	} finally {
		Object.assign(process.env, saved);
	}
});

test("openLiveSession subscription: sem credencial lança a instrução de login (antes de qualquer chamada)", async () => {
	await assert.rejects(
		openLiveSession({
			authMode: "subscription",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			authPath: tempAuthFile({}),
		}),
		SubscriptionLoginRequired,
	);
});

test("openLiveSession subscription: com sessão OAuth, custo é sessão de assinatura (sem preço por token)", async () => {
	const session = await openLiveSession({
		authMode: "subscription",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		authPath: tempAuthFile({ anthropic: oauthCredential() }),
	});
	assert.equal(session.priceBook.kind, "subscription");
	assert.equal(session.model.provider, "anthropic");
});

test("resolveAuthPath: DV_AUTH_FILE tem precedência; senão PI_CODING_AGENT_DIR; senão ~/.pi/agent", () => {
	assert.equal(resolveAuthPath({ DV_AUTH_FILE: "/x/a.json" } as NodeJS.ProcessEnv), "/x/a.json");
	assert.equal(resolveAuthPath({ PI_CODING_AGENT_DIR: "/y" } as NodeJS.ProcessEnv), join("/y", "auth.json"));
	assert.match(resolveAuthPath({} as NodeJS.ProcessEnv), /\.pi[\\/]agent[\\/]auth\.json$/);
});
