// Subcomando `dv auth` espelhando `pi auth` para login (browser/api-key) e checagem de sessão.
import { type AuthLoginMode, checkAuthSession, loginAuthSession } from "./session_auth.ts";
import { resolveAuthPath } from "./subscription.ts";

const HELP = `Uso:
  dv auth login <provider> [--browser | --api-key] [--auth-file <caminho>]
  dv auth check --provider <provider> [--json] [--no-refresh] [--auth-file <caminho>]

Comandos:
  login <provider>   Autentica via navegador (OAuth oficial) ou salva API key em auth.json (0600)
  check              Verifica prontidão da sessão (exit 0 = ready, 1 = not_ready, 2 = invalid)
`;

export type ParsedAuthCli =
	| { kind: "help" }
	| { kind: "login"; provider: string; mode: AuthLoginMode; authPath?: string }
	| { kind: "check"; provider: string; json: boolean; refresh: boolean; authPath?: string };

export function parseAuthCliArgs(argv: readonly string[]): ParsedAuthCli {
	const [sub, ...rest] = argv;
	if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
		return { kind: "help" };
	}

	if (sub === "login") {
		let provider = "";
		let mode: AuthLoginMode = "browser";
		let authPath: string | undefined;
		for (let i = 0; i < rest.length; i += 1) {
			const arg = rest[i];
			if (arg === "--help" || arg === "-h") return { kind: "help" };
			if (arg === "--api-key") mode = "api-key";
			else if (arg === "--browser") mode = "browser";
			else if (arg === "--auth-file") {
				const next = rest[++i];
				if (!next) throw new Error("--auth-file exige um caminho");
				authPath = next;
			} else if (arg?.startsWith("-")) {
				throw new Error(`opção desconhecida em "dv auth login": ${arg}`);
			} else if (arg && provider === "") {
				provider = arg;
			} else {
				throw new Error(`argumento inesperado em "dv auth login": ${arg}`);
			}
		}
		if (provider === "") throw new Error("Uso: dv auth login <provider> [--browser | --api-key]");
		return { kind: "login", provider, mode, ...(authPath === undefined ? {} : { authPath }) };
	}

	if (sub === "check") {
		let provider = "";
		let json = false;
		let refresh = true;
		let authPath: string | undefined;
		for (let i = 0; i < rest.length; i += 1) {
			const arg = rest[i];
			if (arg === "--help" || arg === "-h") return { kind: "help" };
			if (arg === "--json") json = true;
			else if (arg === "--no-refresh") refresh = false;
			else if (arg === "--provider") {
				const next = rest[++i];
				if (!next) throw new Error("--provider exige um provedor");
				provider = next;
			} else if (arg === "--auth-file") {
				const next = rest[++i];
				if (!next) throw new Error("--auth-file exige um caminho");
				authPath = next;
			} else if (arg?.startsWith("-")) {
				throw new Error(`opção desconhecida em "dv auth check": ${arg}`);
			} else if (arg && provider === "") {
				provider = arg;
			} else {
				throw new Error(`argumento inesperado em "dv auth check": ${arg}`);
			}
		}
		if (provider === "") throw new Error("Uso: dv auth check --provider <provider> [--json] [--no-refresh]");
		return { kind: "check", provider, json, refresh, ...(authPath === undefined ? {} : { authPath }) };
	}

	throw new Error(`subcomando desconhecido em "dv auth": ${sub}`);
}

export async function runAuthCli(argv: readonly string[]): Promise<number> {
	const parsed = parseAuthCliArgs(argv);
	if (parsed.kind === "help") {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.kind === "login") {
		const result = await loginAuthSession({
			provider: parsed.provider,
			mode: parsed.mode,
			authPath: parsed.authPath ?? resolveAuthPath(),
		});
		console.log(result.message);
		return 0;
	}
	const result = await checkAuthSession({
		provider: parsed.provider,
		authPath: parsed.authPath ?? resolveAuthPath(),
		refresh: parsed.refresh,
	});
	if (parsed.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const detail = result.reason ? ` (${result.reason})` : result.authType ? ` (${result.authType})` : "";
		console.log(`${result.provider}: ${result.status}${detail}`);
	}
	return result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
}

if (import.meta.main) {
	try {
		process.exitCode = await runAuthCli(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
