// Serialização JSON com chaves ordenadas em todos os níveis e digest SHA-256, para bytes reprodutíveis.
import { createHash } from "node:crypto";

/** Serializa com chaves ordenadas recursivamente. Mesmo valor gera mesmos bytes. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const parts = Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
	return `{${parts.join(",")}}`;
}

/** SHA-256 hexadecimal de uma string em UTF-8. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
