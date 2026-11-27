// Cópia para a área de transferência por OSC 52. Só é usada por `/copy`, nunca automaticamente, e não captura o mouse:
// a seleção nativa do terminal continua funcionando. Terminais sem suporte ignoram a sequência silenciosamente.

/** Limite de caracteres do texto copiado. Com UTF-8 (≤3 bytes por unidade UTF-16) fica abaixo de ~72 KB, dentro do limite
 *  típico de terminais para OSC 52. */
export const OSC52_MAX_CHARS = 24_000;

export interface ClipboardSequence {
	readonly sequence: string;
	readonly truncated: boolean;
}

export function osc52Sequence(text: string): ClipboardSequence {
	const truncated = text.length > OSC52_MAX_CHARS;
	const body = truncated ? text.slice(0, OSC52_MAX_CHARS) : text;
	const encoded = Buffer.from(body, "utf8").toString("base64");
	return { sequence: `\u001b]52;c;${encoded}\u0007`, truncated };
}
