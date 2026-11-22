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
