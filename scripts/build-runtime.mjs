// Compila os pacotes de runtime vendorados (schema, telemetry, ai, agent-core) e copia os dados de catálogo do pi-ai para dist.
// Substitui os scripts `build` upstream, que dependem de ../../scripts fora desta árvore e de geração por rede.
// Pré-requisito único: `npm run hydrate:pi-ai-data` (rede) uma vez, para gerar packages/runtime-pi/pi-ai/src/providers/data.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtime = join(root, "packages", "runtime-pi");
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
const packages = [
	"pi-schema",
	"pi-telemetry",
	"pi-ai",
	"pi-agent-core",
	"pi-tui",
	"pi-mcp",
	"pi-codemode",
	"pi-coding-agent",
];

for (const name of packages) {
	const dir = join(runtime, name);
	execFileSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], { cwd: dir, stdio: "inherit" });
	console.log(`compilado ${name}`);
}

const dataSrc = join(runtime, "pi-ai", "src", "providers", "data");
if (!existsSync(join(dataSrc, ".manifest.json"))) {
	throw new Error("dados do pi-ai ausentes: rode npm run hydrate:pi-ai-data (requer rede)");
}
cpSync(dataSrc, join(runtime, "pi-ai", "dist", "providers", "data"), { recursive: true });
const manifestSha = createHash("sha256")
	.update(readFileSync(join(dataSrc, ".manifest.json")))
	.digest("hex");
writeFileSync(
	join(runtime, "BUILD-DATA.json"),
	`${JSON.stringify({ schema: "dv-runtime-build-v1", pi_ai_data_manifest_sha256: manifestSha, note: "snapshot local de catálogo hidratado (gitignored upstream); não reproduzível sem a fonte de rede na mesma data" }, null, 2)}\n`,
);
console.log(`dados pi-ai copiados; manifest sha256=${manifestSha}`);
