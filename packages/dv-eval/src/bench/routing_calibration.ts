// Calibração do atalho "começar direto no modelo forte" (PredictiveHarnessRouterPolicy).
//
// Regras anti-overfitting:
// 1. Partição fixa por posição na ordem alfabética dos IDs do corpus: índice par = calibração, ímpar = holdout.
// 2. O limiar é escolhido só com os rótulos da partição de calibração. O holdout nunca é lido por esta função.
// 3. Empate favorece a política sem atalho (limiar null), e um limiar só vence se melhorar a acurácia estritamente.
// 4. Rótulo vem de evidência de execução real do degrau 0 (Haiku). Tarefa sem evidência fica fora da calibração.
//    A tarefa negativa (irresolúvel) fica fora: a falha do Haiku nela reflete a especificação, não a complexidade.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractPythonSignals, type SourceFile } from "@dv-agent/core";

export interface Partition {
	calibration: readonly string[];
	holdout: readonly string[];
}

/** Partição determinística: ordena os IDs e alterna. Índice par calibra; ímpar fica de holdout. */
export function partitionTaskIds(ids: readonly string[]): Partition {
	const sorted = [...ids].sort();
	return {
		calibration: sorted.filter((_, i) => i % 2 === 0),
		holdout: sorted.filter((_, i) => i % 2 === 1),
	};
}

/**
 * Evidência do degrau 0 (Haiku 5.5) por tarefa, em tentativas do oráculo. Fontes: runs/* e runs-archive-summaries/*
 * (rodadas bench-hard-n5, bench-frontier-rep3, bench-2026-11-23T11-55-54-579Z e bench-negative).
 * Só estão aqui as tarefas da partição de calibração com evidência.
 */
export const CALIBRATION_EVIDENCE: readonly { task_id: string; rung0_passes: number; rung0_attempts: number }[] = [
	{ task_id: "frontier-02-raft-consensus-sim", rung0_passes: 6, rung0_attempts: 6 },
	{ task_id: "hard-01-mini-ini-ast", rung0_passes: 4, rung0_attempts: 4 },
	{ task_id: "hard-03-mini-sql-engine", rung0_passes: 4, rung0_attempts: 4 },
	{ task_id: "hard-05-bytecode-vm-gc", rung0_passes: 4, rung0_attempts: 4 },
	{ task_id: "medium-02-interval-scheduler", rung0_passes: 0, rung0_attempts: 4 },
];

/** Limiar calibrado committed. Deve ser igual a calibrateFromCorpus().threshold (teste garante). */
export const CALIBRATED_STRONG_FROM_DEPTH: number | null = null;

export interface Sample {
	task_id: string;
	import_depth: number;
	needs_strong: boolean;
}

/**
 * Escolhe o limiar de profundidade que maximiza a acurácia sobre as amostras de calibração. Retorna null quando
 * nenhum limiar melhora estritamente a política sem atalho (que sempre começa no degrau 0).
 */
export function calibrateStrongFromDepth(samples: readonly Sample[]): number | null {
	if (samples.length === 0) return null;
	const accuracy = (threshold: number | null): number =>
		samples.filter((s) => {
			const predictedStrong = threshold !== null && s.import_depth >= threshold;
			return predictedStrong === s.needs_strong;
		}).length;
	let best: number | null = null;
	let bestCorrect = accuracy(null);
	const candidates = [...new Set(samples.map((s) => s.import_depth))].sort((a, b) => a - b);
	for (const candidate of candidates) {
		const correct = accuracy(candidate);
		if (correct > bestCorrect) {
			best = candidate;
			bestCorrect = correct;
		}
	}
	return best;
}

/** Lê os arquivos de um workspace (sem __pycache__), com caminhos relativos e `/` como separador. */
export function readWorkspaceFiles(workspaceDir: string): SourceFile[] {
	const out: SourceFile[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === "__pycache__") continue;
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push({ path: relative(workspaceDir, full).split("\\").join("/"), content: readFileSync(full, "utf8") });
		}
	};
	walk(workspaceDir);
	return out;
}

/**
 * Calibra a partir do corpus. Usa só as tarefas de calibração que têm evidência. Retorna a partição e as amostras
 * usadas, para que o teste possa verificar que o holdout não entrou.
 */
export function calibrateFromCorpus(corpusDir: string): {
	threshold: number | null;
	partition: Partition;
	samples: Sample[];
} {
	const ids = readdirSync(corpusDir).filter((name) => statSync(join(corpusDir, name)).isDirectory());
	const partition = partitionTaskIds(ids);
	const calibrationSet = new Set(partition.calibration);
	const samples: Sample[] = [];
	for (const evidence of CALIBRATION_EVIDENCE) {
		if (!calibrationSet.has(evidence.task_id)) continue; // holdout nunca entra na calibração
		const signals = extractPythonSignals(readWorkspaceFiles(join(corpusDir, evidence.task_id, "workspace")));
		samples.push({
			task_id: evidence.task_id,
			import_depth: signals.import_depth,
			needs_strong: evidence.rung0_passes / evidence.rung0_attempts < 0.5,
		});
	}
	return { threshold: calibrateStrongFromDepth(samples), partition, samples };
}
