// CLI unificada do pacote. Os subcomandos carregam os entrypoints existentes sem reimplementar seus parsers.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSelfUpdate } from "./interactive.ts";
import { runInteractiveMode } from "./repl.ts";

const HELP = `dv-agent — agente interativo e harness determinístico para smoke, bench e métricas

Uso:
  dv                                    Modo interativo (REPL no diretório atual)
  dv "<prompt>"                         Executa uma tarefa no diretório atual
  dv smoke [opções]
  dv bench [opções]
  dv metrics (--weak M --strong M | --baseline P --treatment P) [opções] <outdir|summary.json> [...]
  dv probe [opções]
  dv auth login agy
  dv update                             Atualiza @engfinecode/dv-agent globalmente via npm
  dv --help
  dv --version

Os subcomandos preservam as opções dos runners existentes. Probe sem --live é offline.
`;

const COMMANDS: Readonly<Record<string, string>> = {
	smoke: "../scripts/dv-smoke.js",
	bench: "../scripts/dv-bench.js",
	metrics: "../scripts/dv-bench-metrics.js",
	probe: "../packages/dv-eval/src/probe/cli.js",
	auth: "../packages/dv-eval/src/auth/cli.js",
};
const COMMAND_HELP: Readonly<Record<string, string>> = {
	smoke: "Uso: dv smoke --policy single|ladder|architect-editor|predictive-harness-router [opções do dv-smoke]",
	bench: "Uso: dv bench --policies single,ladder [opções do dv-bench]",
	metrics: "Uso: dv metrics (--weak M --strong M | --baseline P --treatment P) [--seed N --resamples N] <outdir|summary.json> [...]",
	probe: "Uso: dv probe [--live --provider P --model M --auth-mode api-key|subscription]. Sem --live, o probe é offline.",
	auth: "Uso: dv auth login agy — autenticação interativa pelo browser do runtime ACP oficial.",
};

function packageManifest(): Record<string, unknown> {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const path = join(directory, "package.json");
		if (existsSync(path)) {
			try {
				const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (value.name === "@engfinecode/dv-agent") return value;
			} catch {
				// Continua a busca em diretórios ascendentes.
			}
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return { version: "0.1.0" };
}

const [command, ...args] = process.argv.slice(2);
const currentVersion = String(packageManifest().version ?? "0.1.0");
if (command === "--help" || command === "-h") {
	process.stdout.write(HELP);
} else if (command === "--version" || command === "-v") {
	process.stdout.write(`${currentVersion}\n`);
} else if (command === "update") {
	process.exitCode = runSelfUpdate();
} else if (command === "--login") {
	process.exitCode = await runInteractiveMode({ forceLogin: true, currentVersion });
} else if (command !== undefined && command in COMMANDS && (args[0] === "--help" || args[0] === "-h")) {
	process.stdout.write(`${COMMAND_HELP[command]}\n`);
} else if (command !== undefined && command in COMMANDS) {
	const entry = resolve(dirname(fileURLToPath(import.meta.url)), COMMANDS[command] ?? "");
	process.argv = [process.execPath, entry, ...args];
	await import(pathToFileURL(entry).href);
} else {
	const initialPrompt = command === undefined ? undefined : [command, ...args].join(" ");
	process.exitCode = await runInteractiveMode({
		...(initialPrompt === undefined ? {} : { initialPrompt }),
		currentVersion,
	});
}
