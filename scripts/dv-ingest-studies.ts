// Ingestão e validação determinística de estudos e benchmarks externos (arXiv e GitHub releases).
// Suporta execução determinística (--offline-fixture) e feeds públicos (--live-feeds) a custo zero de API.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "../packages/dv-eval/src/cli/args.ts";
import { validateTasksBatch } from "../packages/dv-eval/src/intake/intake_gate.ts";

export interface IngestedItem {
	id: string;
	canonical_url: string;
	title: string;
	authors: string[];
	published_at: string;
	summary: string;
	source: "arxiv" | "github" | "fixture";
	query: string;
	is_duplicate: boolean;
}

export interface IntakeReport {
	schema: "dv-external-intake-v1";
	ingested_at: string;
	date: string;
	mode: "offline-fixture" | "live-feeds";
	raw_payload_sha256: string;
	total_items: number;
	new_items_count: number;
	items: IngestedItem[];
	dataset_sha256?: string;
	gate_report?: {
		ok: boolean;
		tasks_checked: number;
		violations: string[];
	};
}

const ARXIV_QUERIES = ["coding agents", "harness", "context compaction", "reasoning effort"];

const GITHUB_REPOS = ["swe-bench/SWE-bench", "terminal-bench/terminal-bench"];

export function parseArxivAtom(xml: string, query: string): IngestedItem[] {
	const items: IngestedItem[] = [];
	const entries = xml.split(/<entry[\s>]/);
	for (let i = 1; i < entries.length; i++) {
		const chunk = entries[i]!;
		const idMatch = chunk.match(/<id>([^<]+)<\/id>/);
		const titleMatch = chunk.match(/<title>([^<]+)<\/title>/);
		const summaryMatch = chunk.match(/<summary>([\s\S]*?)<\/summary>/);
		const publishedMatch = chunk.match(/<published>([^<]+)<\/published>/);

		if (!idMatch || !titleMatch) continue;

		const rawId = idMatch[1]!.trim();
		const arxivIdMatch = rawId.match(/(\d{4}\.\d{4,5})/);
		const canonicalId = arxivIdMatch ? `arXiv:${arxivIdMatch[1]}` : rawId;
		const canonicalUrl = arxivIdMatch ? `https://arxiv.org/abs/${arxivIdMatch[1]}` : rawId;

		const authorMatches = [...chunk.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((m) => m[1]!.trim());

		items.push({
			id: canonicalId,
			canonical_url: canonicalUrl,
			title: titleMatch[1]!.replace(/\s+/g, " ").trim(),
			authors: authorMatches,
			published_at: publishedMatch ? publishedMatch[1]!.trim() : "",
			summary: summaryMatch ? summaryMatch[1]!.replace(/\s+/g, " ").trim() : "",
			source: "arxiv",
			query,
			is_duplicate: false,
		});
	}
	return items;
}

export function parseGitHubReleases(jsonText: string, repo: string): IngestedItem[] {
	try {
		const parsed = JSON.parse(jsonText);
		if (!Array.isArray(parsed)) return [];
		const items: IngestedItem[] = [];
		for (const rel of parsed) {
			const tagName = rel.tag_name || rel.name || "release";
			const htmlUrl = rel.html_url || `https://github.com/${repo}/releases/tag/${tagName}`;
			items.push({
				id: `${repo}#${tagName}`,
				canonical_url: htmlUrl,
				title: `${repo} ${tagName}: ${rel.name || tagName}`,
				authors: [rel.author?.login || repo.split("/")[0]!],
				published_at: rel.published_at || rel.created_at || "",
				summary: (rel.body || "").slice(0, 300).replace(/\s+/g, " ").trim(),
				source: "github",
				query: repo,
				is_duplicate: false,
			});
		}
		return items;
	} catch {
		return [];
	}
}

/** Extrai IDs e URLs canônicos já conhecidos no repositório para deduplicação. */
export function extractKnownIdentifiers(findingsDocPath: string, queueDir: string): Set<string> {
	const known = new Set<string>();

	if (existsSync(findingsDocPath)) {
		const content = readFileSync(findingsDocPath, "utf8");
		for (const m of content.matchAll(/arXiv:(\d{4}\.\d{4,5})/gi)) {
			known.add(`arXiv:${m[1]}`);
			known.add(m[1]!.toLowerCase());
			known.add(`https://arxiv.org/abs/${m[1]}`.toLowerCase());
		}
		for (const m of content.matchAll(/https?:\/\/[^\s)\]]+/gi)) {
			known.add(m[0]!.toLowerCase());
		}
	}

	if (existsSync(queueDir)) {
		for (const file of readdirSync(queueDir)) {
			if (file.startsWith("intake-") && file.endsWith(".json")) {
				try {
					const data = JSON.parse(readFileSync(join(queueDir, file), "utf8"));
					if (Array.isArray(data.items)) {
						for (const it of data.items) {
							if (it.id) known.add(String(it.id).toLowerCase());
							if (it.canonical_url) known.add(String(it.canonical_url).toLowerCase());
						}
					}
				} catch {
					// Ignora arquivos corrompidos
				}
			}
		}
	}

	return known;
}

/** Atualiza a seção delimitada em EXTERNAL-FINDINGS-2026.md preservando as seções manuais. */
export function updateFindingsDocument(docPath: string, items: IngestedItem[], rawSha256: string, date: string): void {
	if (!existsSync(docPath)) return;
	const original = readFileSync(docPath, "utf8");

	const newRows = items
		.slice(0, 15)
		.map((it) => {
			const authors = it.authors.length > 0 ? it.authors.slice(0, 2).join(", ") : "Autores não listados";
			const cleanTitle = it.title.replace(/\|/g, "\\|");
			const flag = it.is_duplicate ? "Já registrado" : "Novo (E0/UNTESTED)";
			return `| ${it.id} | ${authors} — *${cleanTitle}* | ${it.published_at.slice(0, 10) || it.query} | [link](${it.canonical_url}) | ${flag} |`;
		})
		.join("\n");

	const sectionContent = [
		`<!-- BEGIN:AUTO-INGEST -->`,
		`### Ingestão automatizada em ${date} (Payload SHA-256: \`${rawSha256.slice(0, 16)}...\`)`,
		``,
		`Total ingerido: ${items.length} itens (${items.filter((i) => !i.is_duplicate).length} novos). Todos em status \`UNTESTED\` / \`E0\`.`,
		``,
		`| Identificador | Referência / Título | Data | URL Canônica | Status na Triagem |`,
		`|---|---|---|---|---|`,
		newRows,
		`<!-- END:AUTO-INGEST -->`,
	].join("\n");

	const beginMarker = "<!-- BEGIN:AUTO-INGEST -->";
	const endMarker = "<!-- END:AUTO-INGEST -->";
	const beginCount = original.split(beginMarker).length - 1;
	const endCount = original.split(endMarker).length - 1;

	let updated: string;
	if (beginCount === 1 && endCount === 1) {
		const startIdx = original.indexOf(beginMarker);
		const endIdx = original.indexOf(endMarker) + endMarker.length;
		if (startIdx > endIdx) throw new Error("Marcadores AUTO-INGEST fora de ordem");
		updated = original.slice(0, startIdx) + sectionContent + original.slice(endIdx);
	} else if (beginCount === 0 && endCount === 0) {
		updated = `${original.trimEnd()}\n\n## Fila de Ingestão Automatizada de Estudos\n\n${sectionContent}\n`;
	} else {
		throw new Error("Marcadores AUTO-INGEST incompletos ou duplicados; arquivo não foi alterado");
	}

	writeFileSync(docPath, updated, "utf8");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const text = (name: string): string | undefined => {
		const val = args.get(name);
		return typeof val === "string" ? val : undefined;
	};

	const offlineFixturePath = text("offline-fixture");
	const isLiveFeeds = args.get("live-feeds") === true;
	const runGate = text("run-gate") !== "false";
	const tasksDir = resolve(text("tasks-dir") ?? "experiments/external-queue/tasks");
	const outdir = resolve(text("outdir") ?? "experiments/external-queue");
	const findingsDoc = resolve(text("findings-doc") ?? "docs/research/EXTERNAL-FINDINGS-2026.md");

	if (!offlineFixturePath && !isLiveFeeds) {
		console.log("Uso: node scripts/dv-ingest-studies.ts --offline-fixture <path> | --live-feeds [--run-gate]");
		process.exit(1);
	}

	mkdirSync(outdir, { recursive: true });

	const today = new Date().toISOString().slice(0, 10);
	const knownIds = extractKnownIdentifiers(findingsDoc, outdir);

	let rawAggregatedPayload = "";
	const allItems: IngestedItem[] = [];

	if (offlineFixturePath) {
		const fixtureAbs = resolve(offlineFixturePath);
		if (!existsSync(fixtureAbs)) {
			throw new Error(`Fixture offline não encontrada: ${fixtureAbs}`);
		}
		const rawText = readFileSync(fixtureAbs, "utf8");
		rawAggregatedPayload += rawText;

		try {
			const parsed = JSON.parse(rawText);
			if (Array.isArray(parsed)) {
				allItems.push(...parsed);
			} else if (parsed.arxiv || parsed.github || parsed.items) {
				if (Array.isArray(parsed.items)) allItems.push(...parsed.items);
				if (Array.isArray(parsed.arxiv)) allItems.push(...parsed.arxiv);
				if (Array.isArray(parsed.github)) allItems.push(...parsed.github);
			}
		} catch {
			// Se não for JSON, trata como XML Atom
			allItems.push(...parseArxivAtom(rawText, "fixture"));
		}
	} else if (isLiveFeeds) {
		for (const query of ARXIV_QUERIES) {
			const url = `https://export.arxiv.org/api/query?search_query=all:%22${encodeURIComponent(query)}%22&max_results=5&sortBy=submittedDate&sortOrder=descending`;
			try {
				const res = await fetch(url, { headers: { "User-Agent": "dv-agent-ingest/1.0 (academic research)" } });
				if (res.ok) {
					const textBody = await res.text();
					rawAggregatedPayload += textBody;
					allItems.push(...parseArxivAtom(textBody, query));
				}
			} catch (err) {
				console.warn(`Aviso: falha ao consultar feed arXiv para "${query}":`, err);
			}
		}

		for (const repo of GITHUB_REPOS) {
			const url = `https://api.github.com/repos/${repo}/releases?per_page=3`;
			try {
				const res = await fetch(url, {
					headers: {
						"User-Agent": "dv-agent-ingest/1.0",
						Accept: "application/vnd.github.v3+json",
					},
				});
				if (res.ok) {
					const textBody = await res.text();
					rawAggregatedPayload += textBody;
					allItems.push(...parseGitHubReleases(textBody, repo));
				}
			} catch (err) {
				console.warn(`Aviso: falha ao consultar releases do GitHub para "${repo}":`, err);
			}
		}
	}

	const rawSha256 = createHash("sha256").update(rawAggregatedPayload).digest("hex");

	// Deduplicação determinística
	const seenThisRun = new Set<string>();
	let newCount = 0;

	for (const item of allItems) {
		const keyId = item.id.toLowerCase();
		const keyUrl = item.canonical_url.toLowerCase();

		if (knownIds.has(keyId) || knownIds.has(keyUrl) || seenThisRun.has(keyId) || seenThisRun.has(keyUrl)) {
			item.is_duplicate = true;
		} else {
			item.is_duplicate = false;
			newCount += 1;
			seenThisRun.add(keyId);
			seenThisRun.add(keyUrl);
		}
	}

	// Execução do gate offline sobre tarefas pendentes se solicitado
	let gateReport: IntakeReport["gate_report"] | undefined;
	let batchDatasetSha256: string | undefined;

	if (runGate) {
		const batchResult = await validateTasksBatch(tasksDir, outdir);
		batchDatasetSha256 = batchResult.dataset_sha256;
		gateReport = {
			ok: batchResult.ok,
			tasks_checked: batchResult.tasks.length,
			violations: batchResult.violations,
		};
		if (!batchResult.ok) {
			console.error(`Gate offline rejeitou tarefas importadas:`, batchResult.violations);
		}
	}

	const report: IntakeReport = {
		schema: "dv-external-intake-v1",
		ingested_at: new Date().toISOString(),
		date: today,
		mode: offlineFixturePath ? "offline-fixture" : "live-feeds",
		raw_payload_sha256: rawSha256,
		total_items: allItems.length,
		new_items_count: newCount,
		items: allItems,
		dataset_sha256: batchDatasetSha256,
		gate_report: gateReport,
	};

	const intakeJsonPath = join(outdir, `intake-${today}.json`);
	writeFileSync(intakeJsonPath, `${JSON.stringify(report, null, 2)}\n`.replace(/\r\n/g, "\n"), "utf8");
	console.log(`Relatório gravado em: ${intakeJsonPath}`);

	// Atualiza documento de achados externos
	updateFindingsDocument(findingsDoc, allItems, rawSha256, today);
	console.log(`Documento atualizado: ${findingsDoc}`);

	if (gateReport && !gateReport.ok) {
		process.exit(1);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((err) => {
		console.error("Erro fatal na ingestão:", err);
		process.exit(1);
	});
}
