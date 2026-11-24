// Redação: remove credenciais, mas preserva contadores de telemetria cujo nome contém "tokens".
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProviderError, redactText, redactValue, sanitizeProviderErrorMessage } from "../src/index.ts";

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

test("sanitizeProviderErrorMessage extrai corpo de erro 5xx e redige segredos conhecidos e padrões", () => {
	const rawJson = JSON.stringify({
		error: {
			code: 503,
			status: "UNAVAILABLE",
			message: "The model is overloaded. Please try again. Secret: AIzaSyD123456789012345678901234567890",
		},
	});
	const sanitized = sanitizeProviderErrorMessage(rawJson, ["custom-secret-key-999"]);
	assert.ok(sanitized.includes("model is overloaded"));
	assert.ok(!sanitized.includes("AIzaSyD123456789012345678901234567890"));
	assert.ok(sanitized.includes("[REDACTED]"));

	// Segredo ecoado de volta é substituído
	const echoed = sanitizeProviderErrorMessage("bad auth for custom-secret-key-999", ["custom-secret-key-999"]);
	assert.equal(echoed, "bad auth for [REDACTED]");

	// Cabeçalhos sensíveis em strings cruas são eliminados
	const withHeaders = sanitizeProviderErrorMessage(
		"Error: 503 Service Unavailable\nAuthorization: Bearer supersecrettoken123\nModel busy",
	);
	assert.ok(!withHeaders.includes("supersecrettoken123"));
	assert.ok(withHeaders.includes("Model busy"));
});

test("classifyProviderError categoriza 5xx como PROVIDER_UNAVAILABLE e 401/403/429/timeout", () => {
	assert.equal(classifyProviderError(503, "overloaded"), "PROVIDER_UNAVAILABLE");
	assert.equal(classifyProviderError(500, "internal server error"), "PROVIDER_UNAVAILABLE");
	assert.equal(classifyProviderError(null, "Model is temporarily unavailable"), "PROVIDER_UNAVAILABLE");
	assert.equal(classifyProviderError(401, "invalid api key"), "AUTH_REJECTED");
	assert.equal(classifyProviderError(403, "forbidden"), "AUTH_REJECTED");
	assert.equal(classifyProviderError(429, "rate limit exceeded"), "RATE_LIMITED");
	assert.equal(classifyProviderError(504, "gateway timeout"), "PROVIDER_UNAVAILABLE");
	assert.equal(classifyProviderError(null, "request timed out"), "TIMEOUT");
	assert.equal(classifyProviderError(400, "bad request body"), "PROVIDER_ERROR");
});
