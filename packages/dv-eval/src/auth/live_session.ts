// Sessão viva de um provedor real para runner e probe: resolve modelo, stream e tabela de custo conforme o modo.
// api-key: pi-ai com variável de ambiente. subscription: Models do pi-ai com o auth.json (sem API key).

import {
	AGY_PROVIDER,
	agyModel,
	createAgyStreamFn,
	DV_CLIENT_IDENTITY,
	isAgyModel,
	type PriceBook,
} from "@dv-agent/core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleWithEnvAuth } from "@earendil-works/pi-ai/compat";
import {
	type BuiltinProvider,
	builtinProviders,
	getBuiltinModel,
	getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "./file_credential_store.ts";
import { requireSubscriptionSession } from "./subscription.ts";

export type LiveAuthMode = "api-key" | "subscription";

/** Timeout por requisição do agy (initialize, session/new e session/prompt). Mesmo prazo do CLI oficial (300 s). */
export const AGY_TIMEOUT_MS = 300_000;

export interface LiveSession {
	model: Model<string>;
	streamFn: StreamFn;
	priceBook: PriceBook;
}

/** Abre a sessão. Lança com instrução clara se o modelo não existe ou a autenticação não está pronta. */
export async function openLiveSession(options: {
	authMode: LiveAuthMode;
	provider: string;
	modelId: string;
	authPath: string;
}): Promise<LiveSession> {
	if (options.provider === AGY_PROVIDER) {
		// agy usa o login local do próprio agy (ACP sobre stdio): não há API key nem auth.json do pi-ai.
		if (options.authMode !== "subscription") {
			throw new Error("agy usa o login local do agy: use --auth-mode subscription");
		}
		if (!isAgyModel(options.modelId)) throw new Error(`modelo agy desconhecido: ${options.modelId}`);
		return {
			model: agyModel(options.modelId),
			streamFn: createAgyStreamFn({ cwd: process.cwd(), timeoutMs: AGY_TIMEOUT_MS }),
			priceBook: {
				kind: "subscription",
				id: "agy-local-login",
				source: "login local do agy (assinatura, sem tarifa por token)",
			},
		};
	}
	if (!getBuiltinProviders().includes(options.provider as BuiltinProvider)) {
		throw new Error(`provedor desconhecido no pi-ai: ${options.provider}`);
	}
	// Entrada de CLI validada contra o catálogo acima; o tipo genérico do catálogo não aceita string.
	const model = getBuiltinModel(options.provider as BuiltinProvider, options.modelId as never) as
		| Model<string>
		| undefined;
	if (model === undefined) throw new Error(`modelo ausente no catálogo pi-ai: ${options.provider}/${options.modelId}`);
	const key = `${options.provider}/${options.modelId}`;

	if (options.authMode === "api-key") {
		return {
			model,
			streamFn: (m, c, o) => streamSimpleWithEnvAuth(m, c, { ...o, identity: DV_CLIENT_IDENTITY }),
			priceBook: {
				kind: "metered",
				id: "pi-catalog",
				source: "pi-ai model catalog (Model.cost)",
				entries: { [key]: model.cost },
			},
		};
	}

	const provider = builtinProviders().find((p) => p.id === options.provider);
	if (provider === undefined) throw new Error(`provedor sem implementação no pi-ai: ${options.provider}`);
	const store = new FileCredentialStore(options.authPath);
	await requireSubscriptionSession(store, provider);
	const models = createModels({ credentials: store, identity: DV_CLIENT_IDENTITY });
	models.setProvider(provider);
	return {
		model,
		streamFn: (m, c, o) => models.streamSimple(m, c, o),
		// Sessão de assinatura: custo por token não é cobrado em USD (ver ledger/prices.ts).
		priceBook: {
			kind: "subscription",
			id: "subscription-session",
			source: "sessão OAuth do pi-ai (plano de assinatura)",
		},
	};
}
