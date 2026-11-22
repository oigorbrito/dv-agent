// Rastreio de desfecho das chamadas de ferramenta declaradas pelo modelo. Chamada declarada que não recebe resultado
// até o fim da run (ex.: corte de orçamento) é registrada como not_executed. Nada desaparece em silêncio.
import { sha256Hex } from "../util/canonical.ts";
import type { RunLedger } from "./writer.ts";

export interface DeclaredToolCall {
	toolCallId: string;
	toolName: string;
	argumentsSha256: string;
}

export class ToolOutcomeTracker {
	private readonly declared = new Map<string, DeclaredToolCall>();
	private readonly reported = new Set<string>();

	/** Registra uma chamada declarada pelo modelo, antes de qualquer execução. */
	declare(call: DeclaredToolCall): void {
		this.declared.set(call.toolCallId, call);
	}

	/** Marca que a chamada recebeu um resultado (executado, erro ou bloqueado). */
	report(toolCallId: string): void {
		this.reported.add(toolCallId);
	}

	/** Chamadas declaradas sem resultado, na ordem de declaração. */
	pending(): DeclaredToolCall[] {
		return [...this.declared.values()].filter((call) => !this.reported.has(call.toolCallId));
	}

	/** Grava tool_finished com status not_executed para cada chamada pendente. Retorna quantas foram gravadas. */
	finalize(ledger: RunLedger, reason: string): number {
		const pending = this.pending();
		for (const call of pending) {
			ledger.appendToolFinished({
				tool_call_id: call.toolCallId,
				tool_name: call.toolName,
				arguments_sha256: call.argumentsSha256,
				status: "not_executed",
				block_reason: reason,
				raw_output: "",
				raw_output_sha256: sha256Hex(""),
			});
			this.reported.add(call.toolCallId);
		}
		return pending.length;
	}
}
