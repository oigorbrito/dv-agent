// Catálogo de comandos de barra (`/...`) do REPL. Fonte única para o popup, a ajuda e os testes.

export type CommandGroup = "sessão" | "modelo" | "workspace" | "sistema";

export interface SlashCommand {
	readonly name: string;
	readonly description: string;
	readonly group: CommandGroup;
	/** Argumento opcional. Quando definido, Enter no popup completa o nome em vez de executar. */
	readonly args?: string;
	readonly aliases?: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: "help", group: "sistema", description: "mostra comandos e atalhos de teclado" },
	{ name: "login", group: "modelo", description: "abre o seletor de autenticação (browser, API key, free, paid)" },
	{ name: "logout", group: "modelo", args: "[provedor]", description: "remove a credencial salva do provedor" },
	{ name: "auth", group: "modelo", description: "status detalhado das credenciais e provedores" },
	{ name: "model", group: "modelo", args: "[provedor/modelo]", description: "seleciona provedor e modelo do catálogo" },
	{ name: "effort", group: "modelo", args: "[low|medium|high|xhigh]", description: "define o nível de raciocínio" },
	{ name: "policy", group: "modelo", args: "[política]", description: "define a política de roteamento" },
	{ name: "budget", group: "sessão", args: "[tokens]", description: "mostra ou ajusta o limite de tokens da sessão" },
	{ name: "tokens", group: "sessão", description: "entrada, saída, cache e custo estimado da sessão" },
	{ name: "status", group: "workspace", description: "workspace, branch, modelo, política e ledger atual" },
	{ name: "files", group: "workspace", description: "arquivos modificados ou novos no workspace" },
	{ name: "diff", group: "workspace", description: "git diff --stat do workspace" },
	{ name: "compact", group: "sessão", description: "resume turnos antigos e mantém o último integral (também automático)" },
	{ name: "copy", group: "sessão", description: "copia a última resposta do agente (OSC 52, sem capturar o mouse)" },
	{ name: "clear", group: "sessão", description: "limpa histórico e tela, mantendo a sessão" },
	{ name: "new", group: "sessão", description: "inicia nova sessão e novo diretório em .dv/runs/" },
	{ name: "resume", group: "sessão", args: "[número]", description: "lista e retoma sessões de .dv/runs/" },
	{ name: "history", group: "sessão", description: "turnos executados na sessão atual" },
	{ name: "config", group: "sistema", args: "[set <chave> <valor>]", description: "exibe ou edita ~/.dv/config.json" },
	{ name: "doctor", group: "sistema", description: "diagnostica ambiente, auth.json, agy, Node, Git e catálogo" },
	{ name: "update", group: "sistema", description: "atualiza @engfinecode/dv-agent@latest" },
	{ name: "version", group: "sistema", description: "versão do dv-agent e do runtime interno" },
	{ name: "exit", group: "sistema", description: "encerra a sessão interativa", aliases: ["quit"] },
];

/** Comandos que casam com o texto digitado após `/` (filtro por prefixo). Vazio quando já há argumentos. */
export function matchSlashCommands(input: string): readonly SlashCommand[] {
	if (!input.startsWith("/") || /\s/.test(input)) return [];
	const query = input.slice(1).toLowerCase();
	return SLASH_COMMANDS.filter((c) => c.name.startsWith(query) || (c.aliases ?? []).some((a) => a.startsWith(query)));
}

export function findSlashCommand(name: string): SlashCommand | undefined {
	const wanted = name.toLowerCase();
	return SLASH_COMMANDS.find((c) => c.name === wanted || (c.aliases ?? []).includes(wanted));
}

export function formatHelp(): string {
	const lines = ["Comandos (digite / para o menu filtrável):"];
	for (const cmd of SLASH_COMMANDS) {
		const usage = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
		lines.push(`  ${usage.padEnd(38)} ${cmd.description}`);
	}
	lines.push(
		"",
		"Atalhos:",
		"  /           abre o menu de comandos",
		"  !<comando>  executa no shell do workspace, sem usar tokens do modelo",
		"  ↑ / ↓       navega no menu ou no histórico de entradas",
		"  Tab         completa o comando selecionado",
		"  Esc         fecha o menu; durante um turno, cancela após a chamada atual",
		"  Ctrl+C      limpa a linha; com a linha vazia, sai",
	);
	return lines.join("\n");
}
