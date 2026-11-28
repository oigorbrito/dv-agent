// Parser de modelos da escada: aliases conhecidos resolvem; chaves herdadas do Object.prototype
// (toString, constructor, __proto__) não são tratadas como alias nem como esforço de raciocínio.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLadderModel } from "../src/smoke/runner.ts";

test("parseLadderModel resolve alias conhecido, com e sem esforço", () => {
	assert.deepEqual(parseLadderModel("haiku 5.5"), { provider: "anthropic", modelId: "claude-haiku-5-5" });
	const withEffort = parseLadderModel("sonnet 5.5:high");
	assert.equal(withEffort.provider, "anthropic");
	assert.equal(withEffort.modelId, "claude-sonnet-5-5");
	assert.equal(withEffort.reasoningEffort, "high");
});

test("parseLadderModel não trata chaves do Object.prototype como alias", () => {
	for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
		assert.throws(() => parseLadderModel(key), /modelo deve ser provider\/modelId/, key);
	}
});

test("parseLadderModel não confunde chave do Object.prototype com prefixo de esforço", () => {
	for (const input of ["constructor:high", "toString:low"]) {
		assert.throws(
			() => parseLadderModel(input),
			(error: Error) => {
				assert.match(error.message, /modelo deve ser provider\/modelId/);
				assert.doesNotMatch(error.message, /function|native code/, input);
				return true;
			},
		);
	}
});
