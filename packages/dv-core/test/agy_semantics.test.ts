// Classificador puro da semântica do usage do agy: cada caso é uma regra de decisão, não uma implementação.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAgyUsage } from "../src/index.ts";

const turn = (o: Partial<Record<string, number>>) => ({
	inputTokens: 13193,
	outputTokens: 118,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	thoughtTokens: 117,
	totalTokens: 13311,
	...o,
});

test("sem cache em nenhum turno: INDETERMINATE (T = I + O nas duas leituras)", () => {
	const v = classifyAgyUsage([turn({}), turn({})]);
	assert.equal(v.status, "INDETERMINATE");
	assert.equal(v.semantics, null);
	assert.equal(v.warm_turns, 0);
});

test("cache fora de input (T = I + O + cache): DETERMINED com regra de entrada = input", () => {
	const v = classifyAgyUsage([turn({}), turn({ inputTokens: 1193, cachedReadTokens: 12000 })]);
	assert.equal(v.status, "DETERMINED");
	assert.equal(v.semantics, "cache_outside_input");
	assert.equal(v.proposed_uncached_rule, "input");
});

test("cache dentro de input (T = I + O, com R <= I): DETERMINED com regra input - cache", () => {
	const v = classifyAgyUsage([turn({ inputTokens: 13193, cachedReadTokens: 12000 })]);
	assert.equal(v.status, "DETERMINED");
	assert.equal(v.semantics, "cache_inside_input");
	assert.equal(v.proposed_uncached_rule, "input_minus_cache");
});

test("total que não bate com nenhuma fórmula: INCONSISTENT com o campo e os valores na evidência", () => {
	const v = classifyAgyUsage([turn({ totalTokens: 5 })]);
	assert.equal(v.status, "INCONSISTENT");
	assert.match(v.evidence.at(-1) ?? "", /não bate/);
});

test("raciocínio maior que a saída viola subconjunto: INCONSISTENT", () => {
	const v = classifyAgyUsage([turn({ thoughtTokens: 500 })]);
	assert.equal(v.status, "INCONSISTENT");
	assert.match(v.evidence.at(-1) ?? "", /thoughtTokens/);
});

test("valor inválido (negativo, fracionário, texto) é INCONSISTENT, não zero silencioso", () => {
	for (const bad of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { cachedReadTokens: "3" as unknown as number }]) {
		assert.equal(classifyAgyUsage([turn(bad)]).status, "INCONSISTENT", JSON.stringify(bad));
	}
});

test("cache dentro de input mas maior que input: INCONSISTENT (a fórmula interna não se sustenta)", () => {
	const v = classifyAgyUsage([
		turn({ inputTokens: 100, outputTokens: 10, thoughtTokens: 5, cachedReadTokens: 500, totalTokens: 110 }),
	]);
	assert.equal(v.status, "INCONSISTENT");
	assert.match(v.evidence.at(-1) ?? "", /maior que inputTokens/);
});

test("lista vazia: INDETERMINATE, sem evidência", () => {
	assert.equal(classifyAgyUsage([]).status, "INDETERMINATE");
});
