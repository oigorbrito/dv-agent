// Gera UPSTREAM_PIN.json a partir de um clone do pi-mono no commit fixado.
// Uso: node scripts/pin-upstream.mjs <caminho-do-clone-pi-mono>
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PIN = "69a6993486acee850d14a4a1547daa4a167228ad";
const clone = process.argv[2];
if (!clone) throw new Error("uso: node scripts/pin-upstream.mjs <clone-pi-mono>");

const git = (args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();

const roles = {
	"pi-ai": "provider/stream runtime (EventStream, validateToolArguments, normalizeContext)",
	"pi-agent-core": "agent loop com hooks beforeToolCall/afterToolCall e eventos message_end",
	"pi-coding-agent": "vendorado como fonte solicitado; NAO importado pelo dv-core; nao compilado nesta fase",
	"pi-schema": "dependencia de runtime transitiva de pi-ai (builders de schema)",
	"pi-telemetry": "dependencia de runtime transitiva de pi-ai (TelemetrySpan)",
};

const pkgs = [
	["ai", "pi-ai", "@earendil-works/pi-ai"],
	["agent", "pi-agent-core", "@earendil-works/pi-agent-core"],
	["coding-agent", "pi-coding-agent", "@earendil-works/pi-coding-agent"],
	["schema", "pi-schema", "@earendil-works/pi-schema"],
	["telemetry", "pi-telemetry", "@earendil-works/pi-telemetry"],
];

const packages = pkgs.map(([src, dst, npm]) => ({
	npm_name: npm,
	upstream_path: `packages/${src}`,
	vendored_path: `packages/runtime-pi/${dst}`,
	version: JSON.parse(git(["show", `${PIN}:packages/${src}/package.json`])).version,
	subtree_git_tree: git(["rev-parse", `${PIN}:packages/${src}`]),
	tracked_files: git(["ls-tree", "-r", "--name-only", `${PIN}:packages/${src}`]).split("\n").length,
	role: roles[dst],
}));

const out = {
	schema: "dv-upstream-pin-v1",
	upstream: {
		repository: "https://github.com/badlogic/pi-mono",
		commit: PIN,
		commit_date: git(["log", "-1", "--format=%cI", PIN]),
		license: "MIT",
		license_file: "packages/runtime-pi/LICENSE",
	},
	method:
		"git archive <commit>:packages/<name> (somente arquivos rastreados pelo git; artefatos gitignored e node_modules nao copiados). Sem modificacoes de conteudo.",
	packages,
	transitive_closure_note:
		"pi-coding-agent depende de pi-tui, pi-mcp, pi-codemode (nao vendorados). Nao sao necessarios para pi-ai/pi-agent-core. Vendorar pi-coding-agent executavel exige o fechamento completo.",
	npm_registry_reference:
		"@earendil-works/pi-agent-core@1.6.0 existe no registro npm (referencia de conferencia, nao fonte de codigo)",
};

writeFileSync(join(import.meta.dirname, "..", "UPSTREAM_PIN.json"), JSON.stringify(out, null, 2) + "\n");
console.log(
	packages.map((p) => `${p.vendored_path} ${p.version} files=${p.tracked_files} tree=${p.subtree_git_tree}`).join("\n"),
);
