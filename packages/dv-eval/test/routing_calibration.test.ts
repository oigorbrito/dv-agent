// Calibração do atalho de roteamento: partição registrada, regra de escolha e limiar committed reproduzido do corpus.
// Offline e determinístico. O holdout só aparece aqui para verificar a partição, nunca para escolher o limiar.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
	CALIBRATED_STRONG_FROM_DEPTH,
	CALIBRATION_EVIDENCE,
	calibrateFromCorpus,
	calibrateStrongFromDepth,
	partitionTaskIds,
} from "../src/bench/routing_calibration.ts";

const CORPUS = resolve(import.meta.dirname, "../corpus");

// Partição registrada (ordem alfabética, índice par = calibração). Mudar esta lista exige nova calibração.
const REGISTERED_CALIBRATION = [
	"easy-01-calc",
	"easy-03-csv-normalizer",
	"easy-05-slug-dedup",
	"frontier-02-raft-consensus-sim",
	"hard-01-mini-ini-ast",
	"hard-03-mini-sql-engine",
	"hard-05-bytecode-vm-gc",
	"medium-02-interval-scheduler",
	"medium-04-lru-ttl-cache",
	"negative-01-contradictory-spec",
];
const REGISTERED_HOLDOUT = [
	"easy-02-log-parser",
	"easy-04-rle-codec",
	"frontier-01-ssa-dominator-opt",
	"frontier-03-incremental-type-infer",
	"hard-02-wal-ledger-replay",
	"hard-04-crdt-lww-map",
	"medium-01-semver-resolver",
	"medium-03-topo-build-planner",
	"medium-05-rate-limiter-sliding",
];

test("partição: determinística, disjunta e cobre o corpus; índices registrados", () => {
	const ids = [...REGISTERED_CALIBRATION, ...REGISTERED_HOLDOUT];
	const shuffled = [...ids].reverse();
	const a = partitionTaskIds(ids);
	const b = partitionTaskIds(shuffled);
	assert.deepEqual(a, b, "a ordem de entrada não altera a partição");
	assert.deepEqual([...a.calibration].sort(), [...REGISTERED_CALIBRATION].sort());
	assert.deepEqual([...a.holdout].sort(), [...REGISTERED_HOLDOUT].sort());
	const overlap = a.calibration.filter((id) => a.holdout.includes(id));
	assert.equal(overlap.length, 0);
});

test("partição do corpus real bate com o registro (19 tarefas: 10 calibração, 9 holdout)", () => {
	const ids = [...REGISTERED_CALIBRATION, ...REGISTERED_HOLDOUT];
	assert.equal(ids.length, 19);
	const p = partitionTaskIds(ids);
	assert.equal(p.calibration.length, 10);
	assert.equal(p.holdout.length, 9);
});

test("evidência: toda tarefa com rótulo está na partição de calibração (holdout nunca rotula)", () => {
	for (const evidence of CALIBRATION_EVIDENCE) {
		assert.ok(REGISTERED_CALIBRATION.includes(evidence.task_id), `${evidence.task_id} fora da calibração`);
		assert.ok(!REGISTERED_HOLDOUT.includes(evidence.task_id));
	}
});

test("escolha de limiar: separação perfeita devolve a fronteira", () => {
	const threshold = calibrateStrongFromDepth([
		{ task_id: "a", import_depth: 1, needs_strong: false },
		{ task_id: "b", import_depth: 2, needs_strong: false },
		{ task_id: "c", import_depth: 3, needs_strong: true },
		{ task_id: "d", import_depth: 4, needs_strong: true },
	]);
	assert.equal(threshold, 3);
});

test("escolha de limiar: empate favorece null (política sem atalho)", () => {
	// Nenhum limiar melhora sobre "nunca atalho" (acerta 2 de 4 em ambos os casos).
	const threshold = calibrateStrongFromDepth([
		{ task_id: "a", import_depth: 1, needs_strong: false },
		{ task_id: "b", import_depth: 3, needs_strong: false },
		{ task_id: "c", import_depth: 3, needs_strong: true },
		{ task_id: "d", import_depth: 1, needs_strong: true },
	]);
	assert.equal(threshold, null);
});

test("escolha de limiar: sem amostras ou sem separação útil devolve null", () => {
	assert.equal(calibrateStrongFromDepth([]), null);
	assert.equal(
		calibrateStrongFromDepth([
			{ task_id: "a", import_depth: 1, needs_strong: false },
			{ task_id: "b", import_depth: 3, needs_strong: false },
		]),
		null,
	);
});

test("corpus real: amostras de calibração com profundidades medidas; limiar committed reproduzido", () => {
	const result = calibrateFromCorpus(CORPUS);
	const byId = Object.fromEntries(result.samples.map((s) => [s.task_id, s]));
	assert.deepEqual(
		result.samples.map((s) => s.task_id).sort(),
		[
			"frontier-02-raft-consensus-sim",
			"hard-01-mini-ini-ast",
			"hard-03-mini-sql-engine",
			"hard-05-bytecode-vm-gc",
			"medium-02-interval-scheduler",
		].sort(),
	);
	assert.equal(byId["frontier-02-raft-consensus-sim"]?.import_depth, 3);
	assert.equal(byId["hard-01-mini-ini-ast"]?.import_depth, 1);
	assert.equal(byId["medium-02-interval-scheduler"]?.needs_strong, true);
	assert.equal(byId["frontier-02-raft-consensus-sim"]?.needs_strong, false);
	// Nenhuma amostra vem do holdout.
	for (const s of result.samples) assert.ok(!REGISTERED_HOLDOUT.includes(s.task_id));
	// Resultado: nenhum limiar supera a política sem atalho nesta calibração (4/5 contra 3/5 e 1/5).
	assert.equal(result.threshold, null);
	assert.equal(CALIBRATED_STRONG_FROM_DEPTH, result.threshold, "constante committed deve bater com a calibração");
});
