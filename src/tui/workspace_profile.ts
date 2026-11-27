// Detecção local e determinística do tipo de projeto no diretório atual. Só lista o topo do diretório (sem recursão),
// verifica nomes de marcadores e lê no máximo um package.json pequeno. Sem chamada ao modelo: custo zero de tokens.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceProfile {
	/** Rótulos das stacks/ferramentas identificadas, na ordem fixa das regras. */
	readonly labels: readonly string[];
	/** Nomes dos arquivos que dispararam cada rótulo (um por rótulo). */
	readonly markers: readonly string[];
	/** Quantidade de entradas no topo do diretório. */
	readonly entryCount: number;
	/** Primeiras entradas do topo (pastas com "/"), para o agente saber o que existe sem listar tudo. */
	readonly entries: readonly string[];
}

interface Rule {
	readonly label: string;
	readonly names?: readonly string[];
	readonly exts?: readonly string[];
}

const RULES: readonly Rule[] = [
	{ label: "Node.js", names: ["package.json"] },
	{ label: "TypeScript", names: ["tsconfig.json"] },
	{ label: "pnpm", names: ["pnpm-lock.yaml", "pnpm-workspace.yaml"] },
	{ label: "yarn", names: ["yarn.lock"] },
	{ label: "npm", names: ["package-lock.json"] },
	{ label: "Bun", names: ["bun.lockb", "bun.lock"] },
	{ label: "Python", names: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"] },
	{ label: ".NET", exts: [".csproj", ".fsproj", ".vbproj", ".sln"] },
	{ label: "Rust", names: ["Cargo.toml"] },
	{ label: "Go", names: ["go.mod"] },
	{ label: "Java (Maven)", names: ["pom.xml"] },
	{ label: "Java/Kotlin (Gradle)", names: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"] },
	{ label: "Ruby", names: ["Gemfile"] },
	{ label: "PHP", names: ["composer.json"] },
	{ label: "Docker", names: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml"] },
	{ label: "git", names: [".git"] },
];

const MAX_ENTRIES = 20;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

function hasNpmWorkspaces(packageJson: string): boolean {
	try {
		if (statSync(packageJson).size > MAX_PACKAGE_JSON_BYTES) return false;
		const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { workspaces?: unknown };
		return pkg.workspaces !== undefined && pkg.workspaces !== null;
	} catch {
		return false;
	}
}

export function detectWorkspaceProfile(cwd: string): WorkspaceProfile {
	let dirents: Dirent[];
	try {
		dirents = readdirSync(cwd, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch {
		dirents = [];
	}
	const names = dirents.map((d) => d.name);
	const labels: string[] = [];
	const markers: string[] = [];
	for (const rule of RULES) {
		const hit = names.find((n) => rule.names?.includes(n) || rule.exts?.some((ext) => n.endsWith(ext)));
		if (hit === undefined) continue;
		labels.push(rule.label);
		markers.push(hit);
	}
	if (markers.includes("package.json") && hasNpmWorkspaces(join(cwd, "package.json"))) {
		labels.push("monorepo (workspaces)");
		markers.push("package.json#workspaces");
	}
	const entries = dirents.slice(0, MAX_ENTRIES).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
	return { labels, markers, entryCount: dirents.length, entries };
}

/** Linha única para o contexto do agente. Nunca vazia, para não deixar o modelo supor "pasta vazia". */
export function formatWorkspaceProfile(profile: WorkspaceProfile): string {
	const more = profile.entryCount > profile.entries.length ? `, … +${profile.entryCount - profile.entries.length}` : "";
	const top =
		profile.entryCount === 0
			? "diretório sem entradas no topo"
			: `topo (${profile.entryCount}): ${profile.entries.join(", ")}${more}`;
	if (profile.labels.length === 0) {
		return `nenhum marcador de projeto reconhecido; ${top}.`;
	}
	return `${profile.labels.join(" · ")} (marcadores: ${profile.markers.join(", ")}); ${top}.`;
}
