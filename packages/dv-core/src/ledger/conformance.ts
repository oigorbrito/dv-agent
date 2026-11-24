// Verificador do ledger contra o contrato p1-run-accounting-v4 (regras a, c, d) e o schema dv-run-ledger-v2.
import { readFileSync } from "node:fs";
import { CONTRACT_V5_ID, LEDGER_SCHEMA, SUPPORTED_CONTRACT_IDS } from "../contract.ts";
import { canonicalJson } from "../util/canonical.ts";
import { redactText } from "./redact.ts";

export type ConformanceStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface ConformanceReport {
	ok: boolean;
	/** PASS; FAIL com violação; INCONCLUSIVE sem violação mas teto não verificável (contract v4, regra c). */
	status: ConformanceStatus;
	ceiling_status: string | null;
	violations: string[];
}

type Json = Record<string, unknown>;

const EVENTS = new Set([
	"run_started",
	"route_decided",
	"call_started",
	"call_finished",
	"tool_finished",
	"run_finished",
]);
const HEX64 = /^[0-9a-f]{64}$/;
const TOLERANCE = 1e-9;

/** Confere um ledger.jsonl. Retorna todas as violações, não só a primeira. */
export function checkLedgerConformance(path: string): ConformanceReport {
	const raw = readFileSync(path, "utf8");
	const violations: string[] = [];
	if (raw.includes("\r")) violations.push("bytes CR presentes (o ledger deve ser LF)");
	if (raw.length > 0 && !raw.endsWith("\n")) violations.push("última linha sem \\n");
	if (redactText(raw) !== raw) violations.push("padrão de segredo presente sem redação");

	const events: Json[] = [];
	for (const [i, line] of raw.split("\n").entries()) {
		if (line.length === 0) continue;
		const parsed = parseLine(line, i + 1, violations);
		if (parsed !== undefined) events.push(parsed);
	}
	if (events.length === 0) {
		violations.push("ledger vazio");
		return { ok: false, status: "FAIL", ceiling_status: null, violations };
	}
	checkOrder(events, violations);
	const runStarted = events.find((ev) => ev.event === "run_started");
	if (runStarted !== undefined) checkRunStarted(runStarted, violations);
	checkCalls(events, violations);
	checkTools(events, violations);
	checkRunFinished(events, violations);
	const ceiling = events.find((ev) => ev.event === "run_finished")?.ceiling_status;
	const ceilingStatus = typeof ceiling === "string" ? ceiling : null;
	const status: ConformanceStatus =
		violations.length > 0 ? "FAIL" : ceilingStatus === "unverifiable" ? "INCONCLUSIVE" : "PASS";
	return { ok: violations.length === 0, status, ceiling_status: ceilingStatus, violations };
}

function parseLine(line: string, lineNo: number, violations: string[]): Json | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		violations.push(`linha ${lineNo}: JSON inválido`);
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		violations.push(`linha ${lineNo}: não é objeto`);
		return undefined;
	}
	const ev = parsed as Json;
	if (ev.schema !== LEDGER_SCHEMA) violations.push(`linha ${lineNo}: schema ${String(ev.schema)} != ${LEDGER_SCHEMA}`);
	if (typeof ev.event !== "string" || !EVENTS.has(ev.event)) {
		violations.push(`linha ${lineNo}: evento desconhecido ${String(ev.event)}`);
	}
	if (canonicalJson(parsed) !== line) violations.push(`linha ${lineNo}: chaves fora de ordem ou bytes não canônicos`);
	return ev;
}

function checkOrder(events: Json[], violations: string[]): void {
	const names = events.map((ev) => ev.event);
	if (names[0] !== "run_started") violations.push("primeiro evento não é run_started");
	if (names.at(-1) !== "run_finished") violations.push("último evento não é run_finished");
	if (names.filter((n) => n === "run_started").length !== 1) violations.push("run_started deve aparecer uma vez");
	if (names.filter((n) => n === "run_finished").length !== 1) violations.push("run_finished deve aparecer uma vez");
	// route_decided é opcional: no máximo um, imediatamente após run_started. Não altera telemetria.
	const routes = names.filter((n) => n === "route_decided").length;
	if (routes > 1) violations.push("route_decided deve aparecer no máximo uma vez");
	if (routes === 1 && names[1] !== "route_decided") violations.push("route_decided deve seguir run_started");
}

/** Traceabilidade por run (regra d): campos obrigatórios presentes. Campo ausente é falha, não zero. */
function checkRunStarted(ev: Json, violations: string[]): void {
	if (typeof ev.contract_id !== "string" || !SUPPORTED_CONTRACT_IDS.includes(ev.contract_id)) {
		violations.push(`contract_id ${String(ev.contract_id)} não suportado (${SUPPORTED_CONTRACT_IDS.join(", ")})`);
	}
	if (typeof ev.harness_variant !== "string" || ev.harness_variant === "") violations.push("harness_variant ausente");
	const provenance = ev.reference_provenance;
	if (provenance === null || typeof provenance !== "object" || Object.keys(provenance).length === 0) {
		violations.push("reference_provenance ausente");
	}
	for (const field of ["dataset_sha256", "task_definition_sha256"]) {
		const value = ev[field];
		if (typeof value !== "string" || !HEX64.test(value)) violations.push(`${field} ausente ou inválido`);
	}
	if (typeof ev.max_cost_usd !== "number") violations.push("max_cost_usd ausente");
}

/** Chamadas pareadas e sequenciais; telemetria por chamada conforme regra a. */
function checkCalls(events: Json[], violations: string[]): void {
	const contractId = events.find((ev) => ev.event === "run_started")?.contract_id;
	const started = new Set<number>();
	const finished = new Set<number>();
	let expected = 1;
	for (const ev of events) {
		if (ev.event === "call_started") {
			const index = ev.call_index as number;
			if (index !== expected) violations.push(`call_started ${index} fora de sequência (esperado ${expected})`);
			expected += 1;
			started.add(index);
		} else if (ev.event === "call_finished") {
			const index = ev.call_index as number;
			if (!started.has(index)) violations.push(`call_finished ${index} sem call_started`);
			finished.add(index);
			checkTelemetry(index, ((ev.record as Json).telemetry ?? {}) as Json, violations, contractId);
		}
	}
	for (const index of started) {
		if (!finished.has(index)) violations.push(`chamada ${index} em voo (sem call_finished)`);
	}
}

/** Regra a: telemetry_complete e cost_accounting_status derivados de missing_buckets; nulo só quando declarado. */
function checkTelemetry(index: number, t: Json, violations: string[], contractId: unknown): void {
	const label = `call ${index}`;
	const missing = (t.missing_buckets as string[] | undefined) ?? [];
	const measured = missing.length === 0;
	const unverifiable = missing.includes("agy_cache_semantics_unverified");
	if (unverifiable && contractId !== CONTRACT_V5_ID) {
		violations.push(`${label}: estado UNVERIFIABLE do agy exige contrato v5`);
	}
	if (t.telemetry_complete !== measured)
		violations.push(`${label}: telemetry_complete inconsistente com missing_buckets`);
	const expectedStatus = measured ? "MEASURED" : unverifiable ? "UNVERIFIABLE" : "INCONCLUSIVE";
	if (t.cost_accounting_status !== expectedStatus)
		violations.push(`${label}: cost_accounting_status deve ser ${expectedStatus}`);
	for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
		if (typeof t[field] !== "number") violations.push(`${label}: ${field} não medido`);
	}
	if (t.total_tokens !== (t.prompt_tokens as number) + (t.completion_tokens as number)) {
		violations.push(`${label}: total_tokens != prompt_tokens + completion_tokens`);
	}
	// Nulo só com justificativa: faltante (missing_buckets) ou declarado não exposto pelo transporte (declared_not_exposed).
	const declared = (t.declared_not_exposed as string[] | undefined) ?? [];
	for (const bucket of ["uncached_input_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"]) {
		if (t[bucket] === null && !missing.includes(bucket) && !declared.includes(bucket)) {
			violations.push(`${label}: ${bucket} nulo sem declaração`);
		}
		if (declared.includes(bucket) && t[bucket] !== null)
			violations.push(`${label}: ${bucket} declarado não exposto mas com valor`);
	}
	// Três estados de custo: medido (usd numérico); não aplicável por assinatura (usd null, basis subscription_session);
	// desconhecido (usd null, basis unknown, listado em missing_buckets).
	const subscription = t.cost_basis === "subscription_session";
	if (subscription) {
		if (t.cost_usd !== null) violations.push(`${label}: sessão de assinatura não pode ter cost_usd`);
	} else if (t.cost_usd === null) {
		if (t.cost_basis !== "unknown") violations.push(`${label}: cost_basis deve ser unknown sem custo`);
		if (!missing.includes("cost_usd")) violations.push(`${label}: cost_usd nulo sem declaração`);
	} else if (t.cost_basis === "unknown") {
		violations.push(`${label}: custo com cost_basis unknown`);
	}
}

/** Ferramentas: cada tool_finished aponta para uma tool_call declarada e com o mesmo digest de argumentos. */
function checkTools(events: Json[], violations: string[]): void {
	const declared = new Map<string, string>();
	const reported = new Set<string>();
	for (const ev of events) {
		if (ev.event === "call_finished") {
			for (const call of ((ev.record as Json).tool_calls as Json[] | undefined) ?? []) {
				declared.set(call.tool_call_id as string, call.arguments_sha256 as string);
			}
		}
		if (ev.event === "tool_finished") {
			const id = ev.tool_call_id as string;
			reported.add(id);
			if (!declared.has(id)) violations.push(`tool_finished ${id} sem tool_call declarada`);
			else if (declared.get(id) !== ev.arguments_sha256)
				violations.push(`tool_finished ${id}: arguments_sha256 divergente`);
			if (typeof ev.raw_output_sha256 !== "string" || !HEX64.test(ev.raw_output_sha256)) {
				violations.push(`tool_finished ${id}: raw_output_sha256 inválido`);
			}
		}
	}
	for (const id of declared.keys()) {
		if (!reported.has(id)) violations.push(`tool_call ${id} sem desfecho (tool_finished)`);
	}
}

/** Fechamento: contagens, limite inferior = soma dos custos conhecidos, e teto coerente (regra c). */
function checkRunFinished(events: Json[], violations: string[]): void {
	const run = events.find((ev) => ev.event === "run_finished");
	const start = events.find((ev) => ev.event === "run_started");
	if (run === undefined || start === undefined) return;
	const telemetries = events
		.filter((ev) => ev.event === "call_finished")
		.map((ev) => ((ev.record as Json).telemetry ?? {}) as Json);
	const costs = telemetries.map((t) => t.cost_usd as number | null | undefined);
	const knownSum = costs.reduce<number>((sum, c) => sum + (typeof c === "number" ? c : 0), 0);
	const unknownCalls = telemetries.filter((t) => t.cost_basis === "unknown").length;
	const nonMeteredCalls = telemetries.filter((t) => t.cost_basis === "subscription_session").length;
	if (run.calls_started !== costs.length || run.calls_finished !== costs.length) {
		violations.push("contagem de chamadas no run_finished diverge do ledger");
	}
	if ((run.in_flight_call_indices as unknown[] | undefined)?.length)
		violations.push("run_finished com chamadas em voo");
	if (Math.abs((run.spent_lower_bound_usd as number) - knownSum) > TOLERANCE) {
		violations.push("spent_lower_bound_usd diverge da soma dos custos conhecidos");
	}
	if (run.unknown_cost_calls !== unknownCalls) violations.push("unknown_cost_calls diverge do ledger");
	if (run.non_metered_cost_calls !== nonMeteredCalls) violations.push("non_metered_cost_calls diverge do ledger");
	const max = start.max_cost_usd as number;
	if (
		run.ceiling_status === "within_verified" &&
		(unknownCalls > 0 || nonMeteredCalls > 0 || knownSum > max + TOLERANCE)
	) {
		violations.push("ceiling_status within_verified incoerente com os custos");
	}
	if (run.ceiling_status === "exceeded" && knownSum <= max)
		violations.push("ceiling_status exceeded sem excesso no ledger");
}
