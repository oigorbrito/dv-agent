// Identidade de transporte e User-Agent oficial do DV.
// Evita bloqueios por WAFs e CDNs (ex.: Cloudflare 403 / erro 1010) que barram
// bibliotecas e clientes HTTP padrão (como urllib, fetch sem UA explícito, etc.).

export const DV_USER_AGENT = "dv-agent/0.1.0 (+https://github.com/oigorbrito/DV)";

export interface ClientIdentity {
	userAgent: { custom: string };
	attribution: {
		name: string;
		url: string;
		categories?: string[];
	};
}

export const DV_CLIENT_IDENTITY: ClientIdentity = {
	userAgent: { custom: DV_USER_AGENT },
	attribution: {
		name: "dv-agent",
		url: "https://github.com/oigorbrito/DV",
		categories: ["cli-agent"],
	},
};

/**
 * Retorna os headers HTTP com o User-Agent explícito do DV.
 */
export function dvHttpHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
	return {
		"User-Agent": DV_USER_AGENT,
		...extraHeaders,
	};
}

/**
 * Detecta se a resposta HTTP foi rejeitada por CDN / Cloudflare (HTTP 403 com erro 1010).
 */
export function isCloudflareBlocked(statusCode: number, responseBody?: string): boolean {
	if (statusCode !== 403) return false;
	if (!responseBody) return false;
	return (
		responseBody.includes("1010") || responseBody.includes("error code: 1010") || responseBody.includes("Cloudflare")
	);
}
