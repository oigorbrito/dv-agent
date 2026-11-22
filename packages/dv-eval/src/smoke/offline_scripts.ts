// Roteiros offline do smoke: comportamento determinístico por papel (provider faux). Não avaliam modelo real.
// "cheap" erra a correção (add vira a + b + 1); "strong" acerta. Assim o smoke exercita promoção de degrau.
import { type Turn, textTurn, toolTurn, usage } from "@dv-agent/core";

const WRONG_EDIT = { old_text: "return a - b", new_text: "return a + b + 1" };
const RIGHT_EDIT = { old_text: "return a - b", new_text: "return a + b" };
const SELF_CHECK = { command: 'python -c "import calc; print(calc.add(2, 3))"' };

/** Turnos de um modelo faux, identificado pelo id do modelo (faux-cheap, faux-strong, faux-architect, faux-editor). */
export function offlineTurns(modelId: string): Turn[] {
	const u = (): ReturnType<typeof usage> => usage(1000, 100, { reasoning: 0 });
	if (modelId === "faux-architect") {
		return [textTurn("Plano: em add(), trocar a subtração por adição; manter mul e safe_div.", u())];
	}
	const edit = modelId === "faux-strong" || modelId === "faux-editor" ? RIGHT_EDIT : WRONG_EDIT;
	return [
		toolTurn("read_file", { path: "calc.py" }, u()),
		toolTurn("edit_file", { path: "calc.py", ...edit }, u()),
		toolTurn("run_bash", SELF_CHECK, u()),
		textTurn("alteração feita", u()),
	];
}
