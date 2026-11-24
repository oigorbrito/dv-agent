// Redação de segredos aplicada a todo valor antes de entrar no ledger (chave sensível ou padrão conhecido em texto).
import { REDACTED } from "../contract.ts";

// `token` só como nome de credencial (token, access_token). Não casa contadores como total_tokens ou prompt_tokens.
const SENSITIVE_KEY = /(api[_-]?key|secret|password|passwd|authorization|credential|private[_-]?key|(^|[_-])token)$/i;

// Padrões de credencial comuns. Cada um cobre um formato de provedor; não é um detector completo.
const SECRET_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\b((?:api[_-]?key|secret|token|password)\s*[=:]\s*)[^\s"',;]+/gi,
];

/** Substitui padrões de credencial num texto. Preserva o nome da chave quando o padrão é `chave=valor`. */
export function redactText(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		// Com grupo de captura o segundo argumento é o texto preservado; sem ele, é o offset numérico.
		out = out.replace(pattern, (_match, keep: unknown) => (typeof keep === "string" ? `${keep}${REDACTED}` : REDACTED));
	}
	return out;
}

/** Redação recursiva: chaves sensíveis viram REDACTED, strings passam por redactText. */
export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY.test(key) && inner !== null && inner !== undefined ? REDACTED : redactValue(inner);
		}
		return out;
	}
	return value;
}

/** Classificação padronizada de falhas de transporte/provedor. */
export type ProviderErrorClassification =
	| "PROVIDER_UNAVAILABLE"
	| "AUTH_REJECTED"
	| "RATE_LIMITED"
	| "TIMEOUT"
	| "PROVIDER_ERROR";

/**
 * Sanitiza texto e corpos de erro HTTP de provedores (ex.: 5xx com corpo de erro ou chave ecoada).
 * Mantém apenas o extrato da mensagem relevante (até 300 caracteres), elimina headers,
 * e aplica redação estrita de credenciais conhecidas e padrões de tokens.
 */
export function sanitizeProviderErrorMessage(raw: unknown, knownSecrets: readonly string[] = []): string {
	if (raw === null || raw === undefined) return "erro sem mensagem";
	let text: string;

	if (typeof raw === "string") {
		text = raw;
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") {
				const err = (parsed as { error?: unknown }).error ?? parsed;
				if (typeof err === "object" && err !== null) {
					const msg =
						(err as { message?: string }).message ?? (err as { status?: string }).status ?? JSON.stringify(err);
					text = String(msg);
				}
			}
		} catch {
			// Não é JSON, usa string original.
		}
	} else if (raw instanceof Error) {
		text = raw.message;
	} else if (typeof raw === "object") {
		const err = (raw as { error?: unknown }).error ?? raw;
		if (typeof err === "object" && err !== null) {
			text = String(
				(err as { message?: string }).message ?? (err as { status?: string }).status ?? JSON.stringify(err),
			);
		} else {
			text = String(err);
		}
	} else {
		text = String(raw);
	}

	// Remove headers caso venha formato chave-valor HTTP com múltiplos blocos
	text = text.replace(/(?:authorization|cookie|api[_-]?key)\s*:[^\r\n]+/gi, "");
	// Normaliza whitespace
	text = text.trim().replace(/\s+/g, " ");
	// Limita tamanho a 300 chars conforme especificação de diagnóstico defensivo
	if (text.length > 300) {
		text = `${text.slice(0, 297)}...`;
	}

	let sanitized = redactText(text);
	for (const secret of knownSecrets) {
		if (secret.length > 0) {
			sanitized = sanitized.split(secret).join(REDACTED);
		}
	}
	return sanitized || "erro sem mensagem";
}

/**
 * Classifica um erro HTTP ou de provedor. Erros 5xx após retries ou indicando sobrecarga
 * são classificados como PROVIDER_UNAVAILABLE (falha de disponibilidade de upstream), e não defeito de requisição.
 */
export function classifyProviderError(statusCode?: number | null, errorMessage?: string): ProviderErrorClassification {
	const msg = (errorMessage ?? "").toLowerCase();
	if (
		statusCode === 503 ||
		(statusCode !== undefined && statusCode !== null && statusCode >= 500 && statusCode < 600) ||
		msg.includes("503") ||
		msg.includes("unavailable") ||
		msg.includes("overloaded") ||
		msg.includes("capacity")
	) {
		return "PROVIDER_UNAVAILABLE";
	}
	if (statusCode === 401 || statusCode === 403 || msg.includes("401") || msg.includes("unauthorized")) {
		return "AUTH_REJECTED";
	}
	if (statusCode === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
		return "RATE_LIMITED";
	}
	if (statusCode === 408 || statusCode === 504 || msg.includes("timeout") || msg.includes("timed out")) {
		return "TIMEOUT";
	}
	return "PROVIDER_ERROR";
}
