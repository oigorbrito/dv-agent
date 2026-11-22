// Redação: remove credenciais, mas preserva contadores de telemetria cujo nome contém "tokens".
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText, redactValue } from "../src/index.ts";

test("contadores *_tokens não são redigidos; credenciais são", () => {
	const out = redactValue({
		total_tokens: 1250,
		prompt_tokens: 1200,
		access_token: "abc",
		auth_token: "xyz",
		api_key: "k",
		nested: { password: "p", reasoning_tokens: null },
	}) as Record<string, unknown>;
	assert.equal(out.total_tokens, 1250);
	assert.equal(out.prompt_tokens, 1200);
	assert.equal(out.access_token, "[REDACTED]");
	assert.equal(out.auth_token, "[REDACTED]");
	assert.equal(out.api_key, "[REDACTED]");
	assert.deepEqual(out.nested, { password: "[REDACTED]", reasoning_tokens: null });
});

test("padrões de credencial em texto são redigidos e chave=valor preserva o nome", () => {
	assert.equal(redactText("use sk-ant-api03-ABCDEFGHIJKLMNOP"), "use [REDACTED]");
	assert.equal(redactText("Authorization: Bearer abcdefghijklmnop123"), "Authorization: [REDACTED]");
	assert.equal(redactText("token=supersecretvalue123"), "token=[REDACTED]");
	assert.equal(redactText("tokens 1200 e 50"), "tokens 1200 e 50");
});
