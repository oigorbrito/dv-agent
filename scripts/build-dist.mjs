// Compila a CLI e reúne os pacotes TypeScript internos sob dist/. Dependências externas permanecem como imports npm.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stage = join(dist, ".stage");
const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
const copy = (source, target) => {
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true });
};
const writeJson = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

rmSync(dist, { recursive: true, force: true });
const buildMetadata = join(root, "packages/runtime-pi/BUILD-DATA.json");
const originalBuildMetadata = readFileSync(buildMetadata);
try {
	await import("./build-runtime.mjs");
	copy(buildMetadata, join(dist, "runtime-build-data.json"));
} finally {
	writeFileSync(buildMetadata, originalBuildMetadata);
}
run([join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.dist.json"]);

copy(join(stage, "src"), join(dist, "src"));
copy(join(stage, "scripts"), join(dist, "scripts"));
copy(join(stage, "packages/dv-core/src"), join(dist, "packages/dv-core/src"));
copy(join(stage, "packages/dv-eval/src"), join(dist, "packages/dv-eval/src"));
copy(join(root, "packages/dv-eval/corpus"), join(dist, "packages/dv-eval/corpus"));
copy(join(root, "packages/dv-eval/tasks"), join(dist, "packages/dv-eval/tasks"));
copy(join(root, "UPSTREAM_PIN.json"), join(dist, "UPSTREAM_PIN.json"));
copy(join(root, "contracts/run-accounting-contract-v4.json"), join(dist, "contracts/run-accounting-contract-v4.json"));
copy(join(root, "contracts/run-accounting-contract-v5.json"), join(dist, "contracts/run-accounting-contract-v5.json"));

const packages = [
	{
		name: "@dv-agent/core",
		version: "0.1.0",
		distributionDirectory: "packages/dv-core",
		exports: { ".": "./src/index.js", "./*": "./src/*.js" },
	},
	{
		name: "@dv-agent/eval",
		version: "0.1.0",
		distributionDirectory: "packages/dv-eval",
		exports: { ".": "./src/index.js", "./*": "./src/*.js" },
	},
	{
		name: "@earendil-works/pi-agent-core",
		version: "1.6.0",
		runtimePackage: "pi-agent-core",
		distributionDirectory: "packages/runtime-pi/pi-agent-core",
	},
	{
		name: "@earendil-works/pi-ai",
		version: "1.6.0",
		runtimePackage: "pi-ai",
		distributionDirectory: "packages/runtime-pi/pi-ai",
	},
	{
		name: "@earendil-works/pi-schema",
		version: "1.6.0",
		runtimePackage: "pi-schema",
		distributionDirectory: "packages/runtime-pi/pi-schema",
	},
	{
		name: "@earendil-works/pi-telemetry",
		version: "1.6.0",
		runtimePackage: "pi-telemetry",
		distributionDirectory: "packages/runtime-pi/pi-telemetry",
	},
];

for (const item of packages) {
	const target = join(dist, item.distributionDirectory);
	if (item.runtimePackage !== undefined) {
		writeJson(join(target, "package.json"), {
			name: item.name,
			version: item.version,
			type: "module",
			...(item.exports === undefined ? {} : { exports: item.exports }),
		});
	} else {
		writeJson(join(target, "package.json"), {
			name: item.name,
			version: item.version,
			type: "module",
			exports: item.exports,
		});
	}
	if (item.runtimePackage !== undefined) {
		const source = join(root, "packages/runtime-pi", item.runtimePackage);
		copy(join(source, "dist"), join(target, "dist"));
	}
}

const internalRoots = [
	["@dv-agent/core", join(dist, "packages/dv-core/src")],
	["@dv-agent/eval", join(dist, "packages/dv-eval/src")],
	["@earendil-works/pi-agent-core", join(dist, "packages/runtime-pi/pi-agent-core/dist")],
	["@earendil-works/pi-ai", join(dist, "packages/runtime-pi/pi-ai/dist")],
	["@earendil-works/pi-schema", join(dist, "packages/runtime-pi/pi-schema/dist")],
	["@earendil-works/pi-telemetry", join(dist, "packages/runtime-pi/pi-telemetry/dist")],
];
const specialInternalPaths = new Map([
	["@earendil-works/pi-schema/formats", join(dist, "packages/runtime-pi/pi-schema/dist/formats/index.js")],
	["@earendil-works/pi-telemetry/testing", join(dist, "packages/runtime-pi/pi-telemetry/dist/testing/index.js")],
]);
const importPattern =
	/(from\s+|import\(\s*)(["'])(@dv-agent\/(?:core|eval)(?:\/[^"']*)?|@earendil-works\/pi-(?:agent-core|ai|schema|telemetry)(?:\/[^"']*)?)(["'])/g;
const rewrittenFiles = [];
const walk = (directory) => {
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (path.endsWith(".js")) rewrittenFiles.push(path);
	}
};
walk(dist);
for (const file of rewrittenFiles) {
	const source = readFileSync(file, "utf8");
	const rewritten = source.replace(importPattern, (whole, prefix, quote, specifier) => {
		let target = specialInternalPaths.get(specifier);
		if (target === undefined) {
			const rootPackage = internalRoots.find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
			if (rootPackage === undefined) return whole;
			const [name, base] = rootPackage;
			const subpath = specifier === name ? "index.js" : `${specifier.slice(name.length + 1)}.js`;
			target = join(base, subpath);
		}
		if (!statSync(target, { throwIfNoEntry: false })?.isFile()) {
			throw new Error(`módulo interno não encontrado para ${specifier} em ${file}: ${target}`);
		}
		let spec = relative(dirname(file), target).split(sep).join("/");
		if (!spec.startsWith(".")) spec = `./${spec}`;
		return `${prefix}${quote}${spec}${quote}`;
	});
	if (rewritten !== source) writeFileSync(file, rewritten, "utf8");
}

rmSync(stage, { recursive: true, force: true });
console.log("dist preparado com CLI, corpus, contratos e runtime interno.");
