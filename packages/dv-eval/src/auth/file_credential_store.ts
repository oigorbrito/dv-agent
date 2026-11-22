// CredentialStore de arquivo (auth.json do pi), com lock entre processos e escrita atômica.
// Mesmo formato do auth.json do pi-ai/pi-coding-agent: um objeto { providerId: Credential } com permissão 0600.
// O lock é um diretório `<auth.json>.lock` (mesma convenção do proper-lockfile usado pelo pi), então processos
// que usam a mesma convenção se excluem mutuamente. Refresh de OAuth roda sob este lock (ver pi-ai/auth/resolve.ts),
// pois o provedor pode rotacionar o refresh token: gravar sem lock poderia invalidar a sessão.
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Lock mais velho que isso é considerado abandonado (refresh OAuth leva no máximo 15 s). */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 50;

/** Erro de arquivo de credenciais. Mensagens nunca incluem conteúdo do arquivo. */
export class CredentialFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialFileError";
	}
}

type CredentialMap = Record<string, Credential>;

/** Lê o arquivo. Ausente = vazio. JSON inválido lança: sobrescrever um arquivo ilegível apagaria tokens. */
function loadAll(path: string): CredentialMap {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new CredentialFileError(`auth.json ilegível em ${path}; corrija ou refaça o login (não será sobrescrito)`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CredentialFileError(`auth.json com formato inesperado em ${path}`);
	}
	return parsed as CredentialMap;
}

/** Escrita atômica com permissão 0600: temporário no mesmo diretório, fsync e rename. */
function saveAll(path: string, data: CredentialMap): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Executa fn sob o lock de diretório. Espera até LOCK_WAIT_MS e remove locks abandonados. */
async function withLock<T>(path: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	const lockDir = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		signal?.throwIfAborted();
		try {
			mkdirSync(lockDir);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EPERM") throw error;
			const stat = statSync(lockDir, { throwIfNoEntry: false });
			if (stat === undefined) continue; // liberado entre as duas chamadas
			if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new CredentialFileError(`tempo esgotado aguardando o lock de ${path}`);
			await sleep(LOCK_POLL_MS);
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

/** Store de credenciais em arquivo, usado pelo Models do pi-ai no modo de assinatura. */
export class FileCredentialStore implements CredentialStore {
	readonly authPath: string;

	constructor(authPath: string) {
		this.authPath = authPath;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return loadAll(this.authPath)[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(loadAll(this.authPath)).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return withLock(this.authPath, options?.signal, async () => {
			const data = loadAll(this.authPath);
			const current = data[providerId];
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			if (next === undefined) return current;
			data[providerId] = next;
			saveAll(this.authPath, data);
			return next;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await withLock(this.authPath, options?.signal, async () => {
			const data = loadAll(this.authPath);
			if (!(providerId in data)) return;
			delete data[providerId];
			saveAll(this.authPath, data);
		});
	}
}
