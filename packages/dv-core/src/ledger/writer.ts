// Writer do ledger dv-run-ledger-v2: um evento JSON por linha, LF, com flush e fsync antes de a execução prosseguir.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { LEDGER_SCHEMA } from "../contract.ts";
import { canonicalJson } from "../util/canonical.ts";
import { redactValue } from "./redact.ts";
import type { CallFinishedPayload, CallStartedPayload, RunFinishedPayload, RunStartedPayload, ToolFinishedPayload } from "./events.ts";

/** Ledger append-only de uma execução (um degrau = um ledger). Não grava nada que não passe pela redação. */
export class RunLedger {
	readonly path: string;
	private fd: number | undefined;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
		this.fd = openSync(path, "a");
	}

	appendRunStarted(payload: RunStartedPayload): void {
		this.append("run_started", payload);
	}

	appendCallStarted(payload: CallStartedPayload): void {
		this.append("call_started", payload);
	}

	appendCallFinished(payload: CallFinishedPayload): void {
		this.append("call_finished", payload);
	}

	appendToolFinished(payload: ToolFinishedPayload): void {
		this.append("tool_finished", payload);
	}

	appendRunFinished(payload: RunFinishedPayload): void {
		this.append("run_finished", payload);
	}

	/** Fecha o arquivo. Idempotente. O ledger_sha256 só deve ser lido depois disso. */
	close(): void {
		if (this.fd === undefined) return;
		closeSync(this.fd);
		this.fd = undefined;
	}

	private append(event: string, payload: object): void {
		if (this.fd === undefined) throw new Error(`ledger fechado: ${this.path}`);
		const line = canonicalJson({ schema: LEDGER_SCHEMA, event, ...(redactValue(payload) as object) });
		writeSync(this.fd, `${line}\n`);
		fsyncSync(this.fd);
	}
}

/** SHA-256 dos bytes exatos do ledger (contrato v4, regra d: ledger_sha256). Chamar após close(). */
export function ledgerSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
