// Servidor ACP mínimo em processo real (stdio), para testar framing, ciclo de vida e encerramento sem órfão.
// Não é o agy. Modo via env AGY_FIXTURE_MODE: normal (padrão) | crash_on_prompt.
import { createInterface } from "node:readline";

const mode = process.env.AGY_FIXTURE_MODE ?? "normal";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessionId = "fixture-session";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: {},
				agentInfo: { name: "fixture", version: "0" },
				authMethods: [],
			},
		});
	} else if (msg.method === "session/new") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				sessionId,
				models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
				modes: {},
				configOptions: [],
				_meta: {},
			},
		});
	} else if (msg.method === "session/prompt") {
		if (mode === "crash_on_prompt") process.exit(3);
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
		});
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				stopReason: "end_turn",
				usage: {
					inputTokens: 13193,
					outputTokens: 118,
					cachedReadTokens: 0,
					cachedWriteTokens: 0,
					thoughtTokens: 117,
					totalTokens: 13311,
				},
			},
		});
	}
});
// Fechar stdin encerra o agente, como o agy real.
rl.on("close", () => process.exit(0));
