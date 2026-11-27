// Testes offline do REPL do dv: catálogo de comandos `/`, editor de linha, cabeçalho/status, `!` shell,
// menu de login (browser, api-key, free, paid), config em ~/.dv/config.json e fallback non-TTY.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	checkNpmUpdateNonBlocking,
	defaultModelForProvider,
	detectDefaultAuth,
	formatModelRef,
	isValidCatalogModel,
	loadDvUserConfig,
	promptLoginMenu,
	saveDvUserConfig,
} from "../../../src/interactive.ts";
import {
	autoCompactSession,
	buildTurnPrompt,
	compactSession,
	historyTokens,
	readAutoCompactTokens,
	type SessionState,
} from "../../../src/repl.ts";
import { OSC52_MAX_CHARS, osc52Sequence } from "../../../src/tui/clipboard.ts";
import { findSlashCommand, formatHelp, matchSlashCommands, SLASH_COMMANDS } from "../../../src/tui/commands.ts";
import { createPlainIo } from "../../../src/tui/io.ts";
import { applyKey, createEditorState, type EditorState, popupItems } from "../../../src/tui/line_editor.ts";
import {
	formatCostMode,
	formatCount,
	type HeaderInfo,
	renderHeader,
	renderPromptBlock,
	renderStatusLine,
} from "../../../src/tui/render.ts";
import { TerminalUI } from "../../../src/tui/terminal.ts";
import { detectWorkspaceProfile, formatWorkspaceProfile } from "../../../src/tui/workspace_profile.ts";

const CLI_ENTRY = resolve(import.meta.dirname, "../../../src/cli.ts");
const NO_STYLE = { color: false };

function typeText(state: EditorState, text: string): EditorState {
	let next = state;
	for (const ch of text) next = applyKey(next, { str: ch, name: ch }).state;
	return next;
}

function press(state: EditorState, name: string): EditorState {
	return applyKey(state, { name, str: undefined }).state;
}

test("isValidCatalogModel e defaultModelForProvider rejeitam radius/balanced e retornam modelos reais", () => {
	assert.equal(isValidCatalogModel("radius", "balanced"), false);
	assert.equal(isValidCatalogModel("anthropic", "modelo-inexistente"), false);
	assert.equal(isValidCatalogModel("anthropic", "claude-haiku-4-5"), true);
	assert.equal(isValidCatalogModel("google", "gemini-2.5-flash"), true);
	assert.equal(isValidCatalogModel("agy", "gemini-3.8-flash-high"), true);

	for (const provider of ["anthropic", "openai", "openai-codex", "google", "groq", "agy"]) {
		const modelId = defaultModelForProvider(provider);
		assert.ok(modelId !== null && isValidCatalogModel(provider, modelId), `${provider}/${modelId} inválido`);
	}
});

test("loadDvUserConfig e saveDvUserConfig: rejeitam modelo inválido, aceitam effort e persistem escolha válida", () => {
	const home = mkdtempSync(join(tmpdir(), "dv-home-"));
	try {
		assert.deepEqual(loadDvUserConfig(home), {});
		mkdirSync(join(home, ".dv"), { recursive: true });
		writeFileSync(
			join(home, ".dv", "config.json"),
			JSON.stringify({ model: "radius/balanced", policy: "invalida", maxTokens: -1 }),
		);
		assert.deepEqual(loadDvUserConfig(home), {});

		saveDvUserConfig({ model: "anthropic/claude-haiku-4-5", policy: "ladder", maxTokens: 150000 }, home);
		assert.deepEqual(loadDvUserConfig(home), {
			model: "anthropic/claude-haiku-4-5",
			policy: "ladder",
			maxTokens: 150000,
		});

		saveDvUserConfig({ model: "anthropic/claude-haiku-4-5:high", policy: "architect-editor" }, home);
		assert.deepEqual(loadDvUserConfig(home), {
			model: "anthropic/claude-haiku-4-5:high",
			policy: "architect-editor",
			maxTokens: 150000,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("detectDefaultAuth: detecta auth.json oauth/api_key, fallback de env e ignora config quebrada", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-detect-auth-"));
	const authFile = join(dir, "auth.json");
	try {
		assert.equal(await detectDefaultAuth({ DV_AUTH_FILE: authFile }), null);

		const envOnly = await detectDefaultAuth({ DV_AUTH_FILE: authFile, ANTHROPIC_API_KEY: "sk-ant-test" });
		assert.equal(envOnly?.provider, "anthropic");
		assert.equal(envOnly?.modelId, "claude-haiku-4-5");
		assert.equal(envOnly?.authMode, "api-key");

		writeFileSync(
			authFile,
			JSON.stringify({
				anthropic: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
			}),
		);
		const oauth = await detectDefaultAuth({ DV_AUTH_FILE: authFile }, "radius/balanced");
		assert.equal(oauth?.provider, "anthropic");
		assert.equal(oauth?.modelId, "claude-haiku-4-5");
		assert.equal(oauth?.authMode, "subscription");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("promptLoginMenu: cobre browser, api-key, free e paid persistindo modelo válido em ~/.dv/config.json", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-login-menu-"));
	const home = join(dir, "home");
	const authPath = join(dir, "auth.json");
	try {
		// 1) Browser / assinatura (mock oauth)
		const browserAnswers = ["1", "anthropic"];
		let oauthCalled = "";
		const resBrowser = await promptLoginMenu({
			ask: async () => browserAnswers.shift() ?? "",
			write: () => {},
			authPath,
			homeDir: home,
			loginOAuth: async (provider) => {
				oauthCalled = provider;
			},
		});
		assert.equal(oauthCalled, "anthropic");
		assert.equal(resBrowser?.provider, "anthropic");
		assert.equal(resBrowser?.authMode, "subscription");
		assert.equal(loadDvUserConfig(home).model, "anthropic/claude-haiku-4-5");

		// 2) Chave de API (api-key)
		const apiKeyAnswers = ["2", "openai", "sk-openai-TESTE-NAO-REAL"];
		const resKey = await promptLoginMenu({
			ask: async () => apiKeyAnswers.shift() ?? "",
			write: () => {},
			authPath,
			homeDir: home,
			env: {},
		});
		assert.equal(resKey?.provider, "openai");
		assert.equal(resKey?.authMode, "api-key");
		assert.equal(JSON.parse(readFileSync(authPath, "utf8")).openai.type, "api_key");
		assert.equal(loadDvUserConfig(home).model, "openai/gpt-4.1");

		// 3) Rota gratuita (free)
		const freeAnswers = ["3", "groq", "gsk-TESTE-NAO-REAL"];
		const resFree = await promptLoginMenu({
			ask: async () => freeAnswers.shift() ?? "",
			write: () => {},
			authPath,
			homeDir: home,
			env: {},
		});
		assert.equal(resFree?.provider, "groq");
		assert.equal(resFree?.modelId, "llama-3.3-70b-versatile");
		assert.equal(loadDvUserConfig(home).model, "groq/llama-3.3-70b-versatile");

		// 4) Rota paga (paid)
		const paidAnswers = ["4", "deepseek", "sk-ds-TESTE-NAO-REAL"];
		const resPaid = await promptLoginMenu({
			ask: async () => paidAnswers.shift() ?? "",
			write: () => {},
			authPath,
			homeDir: home,
			env: {},
		});
		assert.equal(resPaid?.provider, "deepseek");
		assert.equal(resPaid?.modelId, "deepseek-flash");
		assert.equal(loadDvUserConfig(home).model, "deepseek/deepseek-flash");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("promptLoginMenu com seletor com setas (TTY): índice 0 faz browser e 'Cancelar' devolve null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-login-select-"));
	const home = join(dir, "home");
	try {
		let offered: readonly string[] = [];
		let oauthCalled = "";
		const picks: Array<number | null> = [0, 4];
		const select = async (_title: string, labels: readonly string[]) => {
			offered = labels;
			return picks.shift() ?? null;
		};
		const logged = await promptLoginMenu({
			ask: async () => "",
			write: () => {},
			authPath: join(dir, "auth.json"),
			homeDir: home,
			select,
			loginOAuth: async (provider) => {
				oauthCalled = provider;
			},
		});
		assert.equal(offered.length, 5, "o seletor deve oferecer 4 rotas + cancelar");
		assert.equal(oauthCalled, "anthropic");
		assert.equal(logged?.authMode, "subscription");

		const cancelled = await promptLoginMenu({
			ask: async () => "",
			write: () => {},
			authPath: join(dir, "auth.json"),
			homeDir: home,
			select,
		});
		assert.equal(cancelled, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("checkNpmUpdateNonBlocking: retorna nova versão ou null sem falhar offline", async () => {
	const newer = await checkNpmUpdateNonBlocking(
		"0.0.2",
		async () => new Response(JSON.stringify({ version: "0.0.3" }), { status: 200 }),
	);
	assert.equal(newer, "0.0.3");

	const same = await checkNpmUpdateNonBlocking(
		"0.0.2",
		async () => new Response(JSON.stringify({ version: "0.0.2" }), { status: 200 }),
	);
	assert.equal(same, null);

	const offline = await checkNpmUpdateNonBlocking("0.0.2", async () => {
		throw new Error("ENOTFOUND");
	});
	assert.equal(offline, null);
});

test("catálogo de comandos: 20+ comandos únicos, incluindo todos os exigidos pelo REPL", () => {
	const names = SLASH_COMMANDS.map((c) => c.name);
	assert.ok(names.length >= 20, `apenas ${names.length} comandos`);
	assert.equal(new Set(names).size, names.length, "nomes duplicados");
	const required = [
		"help",
		"login",
		"logout",
		"auth",
		"model",
		"effort",
		"policy",
		"budget",
		"tokens",
		"status",
		"files",
		"diff",
		"compact",
		"clear",
		"new",
		"resume",
		"history",
		"config",
		"doctor",
		"update",
		"version",
		"exit",
		"copy",
	];
	for (const name of required) assert.ok(findSlashCommand(name), `faltando /${name}`);
	assert.equal(findSlashCommand("quit")?.name, "exit", "/quit deve ser alias de /exit");
	const help = formatHelp();
	for (const name of required) assert.ok(help.includes(`/${name}`), `ajuda sem /${name}`);
});

test("filtragem por prefixo: '/' lista tudo, '/mo' filtra e argumentos fecham o popup", () => {
	assert.equal(matchSlashCommands("/").length, SLASH_COMMANDS.length);
	assert.deepEqual(
		matchSlashCommands("/mo").map((c) => c.name),
		["model"],
	);
	assert.deepEqual(
		matchSlashCommands("/lo")
			.map((c) => c.name)
			.sort(),
		["login", "logout"],
	);
	assert.deepEqual(
		matchSlashCommands("/qu").map((c) => c.name),
		["exit"],
	);
	assert.deepEqual(matchSlashCommands("/model anthropic"), []);
	assert.deepEqual(matchSlashCommands("texto sem barra"), []);
});

test("editor: digitar '/' abre o popup em tempo real; setas navegam e Enter completa ou executa", () => {
	let state = createEditorState();
	state = typeText(state, "/");
	assert.equal(popupItems(state).length, SLASH_COMMANDS.length);

	state = typeText(state, "mo");
	assert.deepEqual(
		popupItems(state).map((c) => c.name),
		["model"],
	);

	// Enter em comando com argumentos completa "/model " sem executar.
	const completed = applyKey(state, { name: "return" });
	assert.equal(completed.action, undefined);
	assert.equal(completed.state.buffer, "/model ");

	// Enter em comando sem argumentos executa imediatamente.
	const help = typeText(createEditorState(), "/he");
	const submitted = applyKey(help, { name: "return" });
	assert.deepEqual(submitted.action, { kind: "submit", text: "/help" });

	// Setas percorrem o popup com volta ao início.
	let nav = typeText(createEditorState(), "/l");
	assert.equal(popupItems(nav)[0]?.name, "login");
	nav = press(nav, "down");
	assert.equal(popupItems(nav)[1]?.name, "logout");
	nav = press(nav, "down");
	assert.equal(popupItems(nav)[0]?.name, "login", "deve dar a volta na lista");

	// Esc fecha o popup sem apagar o texto.
	const dismissed = press(typeText(createEditorState(), "/mo"), "escape");
	assert.equal(popupItems(dismissed).length, 0);
	assert.equal(dismissed.buffer, "/mo");
});

test("editor: histórico com ↑/↓ e prefixo '!' como texto comum (shell não passa pelo modelo)", () => {
	let state = createEditorState();
	state = typeText(state, "!git status");
	const first = applyKey(state, { name: "return" });
	assert.deepEqual(first.action, { kind: "submit", text: "!git status" });

	let next = typeText(first.state, "primeira tarefa");
	next = applyKey(next, { name: "return" }).state;
	const up = press(next, "up");
	assert.equal(up.buffer, "primeira tarefa");
	const upAgain = press(up, "up");
	assert.equal(upAgain.buffer, "!git status");
	const down = press(upAgain, "down");
	assert.equal(down.buffer, "primeira tarefa");
});

test("cabeçalho e barra de status: versão, workspace, modelo, esforço, política, tokens e atalhos", () => {
	const info: HeaderInfo = {
		version: "0.0.2",
		cwd: "D:/projetos/dv-agent",
		auth: "assinatura · anthropic · paid",
		model: "anthropic/claude-haiku-5-5",
		effort: "medium",
		policy: "ladder",
		budget: 200000,
		updateNotice: "0.0.3",
	};
	const header = renderHeader(info, 100, NO_STYLE).join("\n");
	assert.ok(header.includes("dv-agent v0.0.2"));
	assert.ok(header.includes("D:/projetos/dv-agent"));
	assert.ok(header.includes("anthropic/claude-haiku-5-5 · medium"));
	assert.ok(header.includes("ladder"));
	assert.ok(header.includes("Atualização disponível: 0.0.3"), "aviso de atualização ausente");

	const status = renderStatusLine(
		{
			cwd: "D:/projetos/dv-agent",
			branch: "feat/x",
			model: "anthropic/claude-haiku-5-5",
			effort: "medium",
			policy: "ladder",
			usage: { input: 1234, output: 56, total: 1290 },
			cost: "sub",
		},
		200,
	);
	assert.ok(status.includes("⎇ feat/x"));
	assert.ok(status.includes("tok 1.2k in · 56 out · 1.3k total"), status);
	assert.ok(status.includes("sub"), "modo de assinatura ausente");
	for (const shortcut of ["/ comandos", "! shell", "Esc cancelar", "Ctrl+C sair"]) {
		assert.ok(status.includes(shortcut), `atalho ausente: ${shortcut}`);
	}
});

test("bloco do prompt: popup aparece abaixo da entrada e o cursor acompanha o texto", () => {
	const editor = typeText(createEditorState(), "/mo");
	const frame = renderPromptBlock(editor, {
		status: "status",
		width: 80,
		style: NO_STYLE,
		label: "›",
		masked: false,
	});
	assert.ok(frame.lines[1]?.includes("/mo"));
	assert.ok(
		frame.lines.some((line) => line.includes("/model")),
		"popup sem /model",
	);
	assert.equal(frame.cursorRow, 1);
	assert.equal(frame.cursorCol, "› ".length + "/mo".length);

	const masked = renderPromptBlock(typeText(createEditorState(), "segredo"), {
		status: "",
		width: 80,
		style: NO_STYLE,
		label: "Chave:",
		masked: true,
	});
	assert.ok(!masked.lines[1]?.includes("segredo"), "chave não pode aparecer em claro");
});

test("sessão: prompt de contexto inclui resumo e turnos recentes; compactar mantém só o último turno", () => {
	const session: SessionState = {
		id: "s1",
		dir: null,
		createdAt: new Date(0).toISOString(),
		turns: [
			{ index: 1, prompt: "criar arquivo a", reply: "feito a", status: "completed", at: "" },
			{ index: 2, prompt: "criar arquivo b", reply: "feito b", status: "completed", at: "" },
			{ index: 3, prompt: "criar arquivo c", reply: "feito c", status: "completed", at: "" },
		],
		summary: "",
		nextIndex: 4,
		tokens: {
			calls: 0,
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_usd: 0,
		},
	};
	assert.equal(buildTurnPrompt({ summary: "", turns: [] }, "oi"), "oi", "sem histórico, prompt inalterado");
	const withContext = buildTurnPrompt(session, "agora d");
	assert.ok(withContext.includes("criar arquivo c") && withContext.endsWith("Nova solicitação:\nagora d"));

	assert.equal(compactSession(session), 2);
	assert.equal(session.turns.length, 1);
	assert.equal(session.turns[0]?.index, 3);
	assert.ok(session.summary.includes("#1 criar arquivo a"));
	assert.ok(buildTurnPrompt(session, "x").includes("Resumo da conversa anterior"));
});

test("formatModelRef inclui o esforço no formato provider/modelo:effort", () => {
	assert.equal(formatModelRef({ provider: "anthropic", modelId: "claude-haiku-4-5" }), "anthropic/claude-haiku-4-5");
	assert.equal(
		formatModelRef({ provider: "anthropic", modelId: "claude-haiku-4-5", reasoningEffort: "xhigh" }),
		"anthropic/claude-haiku-4-5:xhigh",
	);
});

test("fallback non-TTY: REPL linha a linha roda comandos, '!' shell e /exit sem quebrar", () => {
	const dir = mkdtempSync(join(tmpdir(), "dv-nontty-"));
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	try {
		const result = spawnSync(process.execPath, [CLI_ENTRY], {
			cwd: dir,
			input: "/version\n!echo dv-shell-ok\n/comando-inexistente\n/help\n/copy\n/exit\n",
			encoding: "utf8",
			timeout: 60_000,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				DV_AUTH_FILE: join(dir, "auth.json"),
				DV_NO_UPDATE_CHECK: "1",
				ANTHROPIC_API_KEY: "",
				OPENAI_API_KEY: "",
				GEMINI_API_KEY: "",
				GROQ_API_KEY: "",
				OPENROUTER_API_KEY: "",
				DEEPSEEK_API_KEY: "",
			},
		});
		const output = `${result.stdout}\n${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.ok(output.includes("dv-agent v"), "cabeçalho ausente");
		assert.ok(output.includes("dv-shell-ok"), "!comando não executou no shell");
		assert.ok(output.includes("Comando desconhecido: /comando-inexistente"), "comando inválido não tratado");
		assert.ok(output.includes("Comandos (digite / para o menu filtrável)"), "/help ausente");
		assert.ok(output.includes("Nada para copiar"), "/copy sem resposta deve avisar");
		assert.ok(!output.includes("\u001b[?25l"), "não deve emitir sequências de TTY em modo pipe");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

class FakeTty extends EventEmitter {
	readonly written: string[] = [];
	readonly columns = 80;
	readonly isTTY = true;
	setRawMode(_mode: boolean): void {}
	resume(): void {}
	pause(): void {}
	write(text: string): boolean {
		this.written.push(text);
		return true;
	}
	char(ch: string): void {
		this.emit("keypress", ch, { name: ch });
	}
	key(name: string): void {
		this.emit("keypress", name === "return" ? "\r" : undefined, { name });
	}
}

test("TTY (terminal simulado): seletor com setas confirma a opção e a linha completa /mo com Enter", async () => {
	const fake = new FakeTty();
	const ui = new TerminalUI(fake as unknown as NodeJS.ReadStream, fake as unknown as NodeJS.WriteStream);
	ui.start();
	try {
		const picked = ui.select("Esforço", ["low", "medium", "high"], 0);
		fake.key("down");
		fake.key("down");
		fake.key("up");
		fake.key("down");
		fake.key("return");
		assert.equal(await picked, 2);

		const line = ui.readLine("status");
		for (const ch of "/mo") fake.char(ch);
		fake.key("return");
		for (const ch of "anthropic/x") fake.char(ch);
		fake.key("return");
		assert.deepEqual(await line, { kind: "submit", text: "/model anthropic/x" });
		assert.ok(
			fake.written.some((chunk) => chunk.includes("/model")),
			"popup não foi desenhado",
		);
	} finally {
		ui.stop();
	}
});

test("TTY (terminal simulado): Esc cancela o seletor e Ctrl+C em turno dispara o handler de interrupção", async () => {
	const fake = new FakeTty();
	const ui = new TerminalUI(fake as unknown as NodeJS.ReadStream, fake as unknown as NodeJS.WriteStream);
	ui.start();
	try {
		const cancelled = ui.select("Modelo", ["a", "b"]);
		fake.key("escape");
		assert.equal(await cancelled, null);

		let interrupted = 0;
		ui.watchInterrupt(() => {
			interrupted += 1;
		});
		fake.emit("keypress", "\u0003", { name: "c", ctrl: true });
		fake.key("escape");
		assert.equal(interrupted, 2);
		ui.watchInterrupt(null);
	} finally {
		ui.stop();
	}
});

test("TTY: a sessão não ativa captura de mouse nem tela alternativa (seleção nativa preservada)", async () => {
	const fake = new FakeTty();
	const ui = new TerminalUI(fake as unknown as NodeJS.ReadStream, fake as unknown as NodeJS.WriteStream);
	ui.start();
	try {
		const line = ui.readLine("status");
		for (const ch of "oi") fake.char(ch);
		fake.key("return");
		await line;
		ui.copyToClipboard("resposta");
	} finally {
		ui.stop();
	}
	const out = fake.written.join("");
	for (const mode of ["?1000", "?1002", "?1003", "?1005", "?1006", "?1015", "?1049"]) {
		assert.ok(!out.includes(`\u001b[${mode}h`), `sequência de modo ${mode} não deve ser emitida`);
	}
});

test("TTY: /copy envia OSC 52 com o texto em base64 e não escreve nada sem terminal", () => {
	const fake = new FakeTty();
	const ui = new TerminalUI(fake as unknown as NodeJS.ReadStream, fake as unknown as NodeJS.WriteStream);
	const result = ui.copyToClipboard("olá dv");
	assert.deepEqual(result, { written: true, truncated: false });
	assert.ok(fake.written.join("").includes(`\u001b]52;c;${Buffer.from("olá dv").toString("base64")}\u0007`));

	const plain = createPlainIo(null, { write() {} });
	assert.deepEqual(plain.copyToClipboard("x"), { written: false, truncated: false });
});

test("osc52Sequence: codifica em base64 e trunca acima de OSC52_MAX_CHARS", () => {
	const small = osc52Sequence("olá");
	assert.equal(small.truncated, false);
	assert.equal(small.sequence, `\u001b]52;c;${Buffer.from("olá", "utf8").toString("base64")}\u0007`);

	const big = osc52Sequence("x".repeat(OSC52_MAX_CHARS + 10));
	assert.equal(big.truncated, true);
	const payload = big.sequence.slice("\u001b]52;c;".length, -1);
	assert.equal(Buffer.from(payload, "base64").length, OSC52_MAX_CHARS);
});

test("tokens na barra: contagem compacta e custo/modo (sub, US$, n/d)", () => {
	assert.equal(formatCount(56), "56");
	assert.equal(formatCount(1234), "1.2k");
	assert.equal(formatCount(3_456_789), "3.46M");
	assert.equal(formatCostMode(null, true), "sub", "assinatura sem custo USD");
	assert.equal(formatCostMode(0, true), "sub", "assinatura com custo zero");
	assert.equal(formatCostMode(0.0123, true), "sub · est. US$ 0.0123", "assinatura com custo estimado");
	assert.equal(formatCostMode(0.5, false), "US$ 0.5000");
	assert.equal(formatCostMode(null, false), "n/d", "api-key sem preço");
});

function sessionWith(turns: Array<{ prompt: string; reply: string }>): SessionState {
	return {
		id: "auto",
		dir: null,
		createdAt: new Date(0).toISOString(),
		turns: turns.map((t, i) => ({ index: i + 1, prompt: t.prompt, reply: t.reply, status: "completed", at: "" })),
		summary: "",
		nextIndex: turns.length + 1,
		tokens: {
			calls: 0,
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_usd: 0,
		},
	};
}

test("compactação automática: dispara ao atingir o limiar, preserva o último turno e é determinística", () => {
	const turns = [1, 2, 3, 4].map((n) => ({ prompt: `p${n}`.padEnd(400, "p"), reply: `r${n}`.padEnd(400, "r") }));
	const session = sessionWith(turns);
	assert.equal(historyTokens(session), 800, "4 turnos de 800 caracteres ≈ 800 tokens");

	assert.equal(autoCompactSession(session, 1_000), 0, "abaixo do limiar não compacta");
	assert.equal(autoCompactSession(session, 0), 0, "limiar 0 desativa");
	assert.equal(session.turns.length, 4);

	const twin = sessionWith(turns);
	assert.equal(autoCompactSession(session, 800), 3);
	assert.equal(autoCompactSession(twin, 800), 3);
	assert.equal(session.turns.length, 1);
	assert.equal(session.turns[0]?.index, 4, "o turno mais recente é preservado");
	assert.equal(session.summary, twin.summary, "resumo determinístico");
	assert.ok(session.summary.includes("#1 p1"));

	// Sem repetir: já há um turno, nada mais a compactar.
	assert.equal(autoCompactSession(session, 1), 0);
});

test("compactação: resumo cortado apenas em linhas inteiras e limiar lido de DV_AUTO_COMPACT_TOKENS", () => {
	const turns = Array.from({ length: 80 }, (_, i) => ({ prompt: `tarefa ${i} ${"x".repeat(120)}`, reply: "ok" }));
	const session = sessionWith(turns);
	compactSession(session);
	const lines = session.summary.split("\n");
	assert.ok(session.summary.length <= 3_000, `resumo com ${session.summary.length} caracteres`);
	assert.ok(
		lines.every((line) => line.startsWith("- #")),
		"nenhuma linha pode ser cortada no meio",
	);

	assert.equal(readAutoCompactTokens({}), 6_000, "padrão");
	assert.equal(readAutoCompactTokens({ DV_AUTO_COMPACT_TOKENS: "0" }), 0, "0 desativa");
	assert.equal(readAutoCompactTokens({ DV_AUTO_COMPACT_TOKENS: " 900 " }), 900);
	assert.equal(readAutoCompactTokens({ DV_AUTO_COMPACT_TOKENS: "abc" }), 6_000, "inválido cai no padrão");
});

test("contexto do workspace: linha detectada entra no prompt do turno, antes da solicitação", () => {
	const line = "Node.js · TypeScript (marcadores: package.json, tsconfig.json); topo (2): package.json, src/.";
	const prompt = buildTurnPrompt({ summary: "", turns: [] }, "liste os arquivos", line);
	assert.ok(prompt.startsWith("Contexto do workspace (detectado localmente): Node.js"));
	assert.ok(prompt.endsWith("Nova solicitação:\nliste os arquivos"));
});

test("detecção de workspace: marcadores do topo, sem recursão, determinística e nunca vazia no texto", () => {
	const root = mkdtempSync(join(tmpdir(), "dv-ws-"));
	const node = join(root, "node-ts");
	const py = join(root, "py");
	const net = join(root, "net");
	const empty = join(root, "empty");
	const many = join(root, "many");
	try {
		for (const d of [node, py, net, empty, many]) mkdirSync(d, { recursive: true });
		writeFileSync(join(node, "package.json"), JSON.stringify({ name: "x", workspaces: ["packages/*"] }));
		writeFileSync(join(node, "tsconfig.json"), "{}");
		writeFileSync(join(node, "pnpm-lock.yaml"), "");
		mkdirSync(join(node, ".git"));
		mkdirSync(join(node, "packages", "a"), { recursive: true });
		writeFileSync(join(py, "pyproject.toml"), "[project]");
		writeFileSync(join(net, "App.csproj"), "<Project/>");
		for (let i = 0; i < 30; i += 1) writeFileSync(join(many, `f${String(i).padStart(2, "0")}.txt`), "");

		const nodeProfile = detectWorkspaceProfile(node);
		assert.deepEqual(nodeProfile.labels, ["Node.js", "TypeScript", "pnpm", "git", "monorepo (workspaces)"]);
		const nodeLine = formatWorkspaceProfile(nodeProfile);
		assert.ok(nodeLine.startsWith("Node.js · TypeScript · pnpm · git"), nodeLine);
		assert.ok(nodeLine.includes("packages/"), "pastas do topo devem aparecer com /");
		assert.equal(JSON.stringify(detectWorkspaceProfile(node)), JSON.stringify(nodeProfile), "determinístico");

		assert.deepEqual(detectWorkspaceProfile(py).labels, ["Python"]);
		assert.deepEqual(detectWorkspaceProfile(net).labels, [".NET"]);

		const emptyLine = formatWorkspaceProfile(detectWorkspaceProfile(empty));
		assert.ok(emptyLine.includes("diretório sem entradas no topo"), emptyLine);

		const manyProfile = detectWorkspaceProfile(many);
		assert.equal(manyProfile.entryCount, 30);
		assert.equal(manyProfile.entries.length, 20, "lista limitada ao topo");
		assert.ok(formatWorkspaceProfile(manyProfile).includes("… +10"));

		assert.deepEqual(detectWorkspaceProfile(join(root, "inexistente")).labels, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fallback non-TTY: copyToClipboard não escreve nada e não lança erro", () => {
	const plain = createPlainIo(null, { write() {} });
	assert.equal(plain.tty, false);
	assert.deepEqual(plain.copyToClipboard("x"), { written: false, truncated: false });
});
