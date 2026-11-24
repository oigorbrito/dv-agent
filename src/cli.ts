// CLI unificada do pacote. Os subcomandos carregam os entrypoints existentes sem reimplementar seus parsers.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELP = `dv-agent — harness determinístico para smoke, bench e métricas

Uso:
  dv smoke [opções]
  dv bench [opções]
  dv metrics [opções] summary.json [...]
  dv probe [opções]
  dv --help
  dv --version

Os subcomandos preservam as opções dos runners existentes. Probe sem --live é offline.
`;

const COMMANDS: Readonly<Record<string, string>> = {
	smoke: "../scripts/dv-smoke.js",
	bench: "../scripts/dv-bench.js",
	metrics: "../scripts/dv-bench-metrics.js",
	probe: "../packages/dv-eval/src/probe/cli.js",
};
const COMMAND_HELP: Readonly<Record<string, string>> = {
	smoke: "Uso: dv smoke --policy single|ladder|architect-editor|predictive-harness-router [opções do dv-smoke]",
	bench: "Uso: dv bench --policies single,ladder [opções do dv-bench]",
	metrics: "Uso: dv metrics (--weak M --strong M | --paired-policy-a P --paired-policy-b P) summary.json [...]",
	probe: "Uso: dv probe [--live --provider P --model M --auth-mode api-key|subscription]. Sem --live, o probe é offline.",
};

function packageManifest(): Record<string, unknown> {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const path = join(directory, "package.json");
		if (existsSync(path)) {
			try {
				const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (value.name === "@finecode/dv-agent") return value;
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
if (command === undefined || command === "--help" || command === "-h") {
	process.stdout.write(HELP);
} else if (command === "--version" || command === "-v") {
	const manifest = packageManifest();
	process.stdout.write(`${String(manifest.version)}\n`);
} else if (command in COMMANDS && (args[0] === "--help" || args[0] === "-h")) {
	process.stdout.write(`${COMMAND_HELP[command]}\n`);
} else if (!(command in COMMANDS)) {
	console.error(`subcomando desconhecido: ${command}\n\n${HELP}`);
	process.exitCode = 1;
} else {
	const entry = resolve(dirname(fileURLToPath(import.meta.url)), COMMANDS[command] ?? "");
	process.argv = [process.execPath, entry, ...args];
	await import(pathToFileURL(entry).href);
}
